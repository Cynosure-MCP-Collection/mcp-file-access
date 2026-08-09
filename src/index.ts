#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { EOL } from 'node:os';
import sharp from 'sharp';
import { ZipArchive } from 'archiver';
import unzipper from 'unzipper';

type SortBy = 'name' | 'size' | 'modified';

interface FileEntry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
    modified: string;
}

interface TreeEntry {
    name: string;
    path: string;
    type: FileEntry['type'];
    size?: number;
    children?: TreeEntry[];
}

const DEFAULT_EXCLUDE_PATTERNS = [
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    '.cache',
    '.parcel-cache',
    '.turbo',
    '.vercel',
    'coverage',
    '.pytest_cache',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    'vendor',
    '.DS_Store',
];

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
};

const MEDIA_MIME_BY_EXT: Record<string, string> = {
    ...IMAGE_MIME_BY_EXT,
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
};

function log(msg: string): void {
    process.stderr.write(`[file-access-mcp ${new Date().toISOString()}] ${msg}\n`);
}

function configuredAllowedDirectories(): string[] {
    const configured = process.env.FILE_ACCESS_ALLOWED_DIRECTORIES;
    const dirs = configured
        ? configured.split(path.delimiter).map(p => p.trim()).filter(Boolean)
        : [process.cwd()];
    return dirs.map(dir => path.resolve(dir));
}

const ALLOWED_DIRECTORIES = configuredAllowedDirectories();

function isWithin(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function resolveAllowedPath(inputPath: string): Promise<string> {
    if (!inputPath || inputPath.trim() === '') throw new Error('Path is required.');
    const absolute = path.resolve(inputPath);
    let resolvedTarget = absolute;

    try {
        resolvedTarget = await fs.realpath(absolute);
    } catch {
        const missingParts: string[] = [];
        let cursor = absolute;

        while (true) {
            try {
                const realExistingParent = await fs.realpath(cursor);
                resolvedTarget = path.join(realExistingParent, ...missingParts.reverse());
                break;
            } catch {
                const parent = path.dirname(cursor);
                if (parent === cursor) throw new Error(`No existing parent directory found for path: ${inputPath}`);
                missingParts.push(path.basename(cursor));
                cursor = parent;
            }
        }
    }

    for (const allowed of ALLOWED_DIRECTORIES) {
        let realAllowed = allowed;
        try {
            realAllowed = await fs.realpath(allowed);
        } catch {
            // Keep the resolved configured path if the allowed root is created later.
        }
        if (isWithin(realAllowed, resolvedTarget)) return resolvedTarget;
    }

    throw new Error(`Access denied. Path is outside allowed directories: ${inputPath}`);
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

function searchPatternToRegExp(pattern: string): RegExp {
    if (pattern.includes('*') || pattern.includes('?')) return globToRegExp(pattern);
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
}

function shouldExclude(name: string, fullPath: string, patterns: string[] = []): boolean {
    const allPatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...patterns].filter(Boolean);
    const normalized = fullPath.split(path.sep).join('/');

    return allPatterns.some(pattern => {
        if (pattern.includes('*') || pattern.includes('?')) {
            const re = globToRegExp(pattern);
            return re.test(name) || re.test(normalized);
        }
        return name === pattern || normalized.includes(`/${pattern}/`) || normalized.endsWith(`/${pattern}`);
    });
}

function entryType(stats: Awaited<ReturnType<typeof fs.lstat>>): FileEntry['type'] {
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    if (stats.isSymbolicLink()) return 'symlink';
    return 'other';
}

async function toFileEntry(fullPath: string, name = path.basename(fullPath)): Promise<FileEntry> {
    const stats = await fs.lstat(fullPath);
    return {
        name,
        path: fullPath,
        type: entryType(stats),
        size: stats.size,
        modified: stats.mtime.toISOString(),
    };
}

function sortEntries(entries: FileEntry[], sortBy: SortBy = 'name'): FileEntry[] {
    return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : b.type === 'directory' ? 1 : 0;
        if (sortBy === 'size') return b.size - a.size || a.name.localeCompare(b.name);
        if (sortBy === 'modified') return b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name);
    });
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit++;
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

async function directorySize(dir: string, excludePatterns: string[] = []): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (shouldExclude(entry.name, fullPath, excludePatterns)) continue;
        const stats = await fs.lstat(fullPath);
        if (stats.isDirectory()) total += await directorySize(fullPath, excludePatterns);
        else total += stats.size;
    }

    return total;
}

async function readDirectoryEntries(dir: string, includeSizes = false, sortBy: SortBy = 'name'): Promise<FileEntry[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (shouldExclude(entry.name, fullPath)) continue;
        const info = await toFileEntry(fullPath, entry.name);
        if (includeSizes && info.type === 'directory') info.size = await directorySize(fullPath);
        result.push(info);
    }

    return sortEntries(result, sortBy);
}

async function buildTree(dir: string, depth: number, excludePatterns: string[]): Promise<TreeEntry> {
    const info = await toFileEntry(dir);
    const node: TreeEntry = {
        name: info.name || dir,
        path: info.path,
        type: info.type,
        size: info.size,
    };

    if (info.type !== 'directory' || depth <= 0) return node;

    const children = await fs.readdir(dir, { withFileTypes: true });
    node.children = [];
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        const childPath = path.join(dir, child.name);
        if (shouldExclude(child.name, childPath, excludePatterns)) continue;
        node.children.push(await buildTree(childPath, depth - 1, excludePatterns));
    }
    return node;
}

async function searchFilesRecursive(dir: string, matcher: RegExp, excludePatterns: string[], results: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (shouldExclude(entry.name, fullPath, excludePatterns)) continue;
        if (matcher.test(entry.name) || matcher.test(fullPath)) results.push(fullPath);
        if (entry.isDirectory()) await searchFilesRecursive(fullPath, matcher, excludePatterns, results);
    }
}

function limitText(text: string, head?: number, tail?: number): string {
    const lines = text.split(/\r?\n/);
    if (head !== undefined && tail !== undefined) {
        return [
            ...lines.slice(0, head),
            `... omitted ${Math.max(0, lines.length - head - tail)} line(s) ...`,
            ...lines.slice(Math.max(head, lines.length - tail)),
        ].join(EOL);
    }
    if (head !== undefined) return lines.slice(0, head).join(EOL);
    if (tail !== undefined) return lines.slice(Math.max(0, lines.length - tail)).join(EOL);
    return text;
}

async function readText(absPath: string, head?: number, tail?: number): Promise<string> {
    const buffer = await fs.readFile(absPath);
    return limitText(TEXT_DECODER.decode(buffer), head, tail);
}

function mimeForPath(filePath: string): string {
    return MEDIA_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isImagePath(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() in IMAGE_MIME_BY_EXT;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function truncateMiddle(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const side = Math.floor((maxLength - 3) / 2);
    return `${value.slice(0, side)}...${value.slice(value.length - side)}`;
}

function captionSvg(width: number, height: number, title: string, index: number): Buffer {
    const label = escapeXml(`${index}. ${truncateMiddle(title, 44)}`);
    return Buffer.from(`
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="#f7f7f7"/>
            <text x="12" y="28" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="600" fill="#222">${label}</text>
        </svg>
    `);
}

async function createImageCollage(paths: string[], tileSize: number): Promise<{ data: Buffer; width: number; height: number; files: Array<{ name: string; path: string }> }> {
    if (paths.length < 1 || paths.length > 6) throw new Error('read_multiple_media_files supports 1 to 6 images per call.');

    const absPaths = [];
    for (const filePath of paths) {
        const absPath = await resolveAllowedPath(filePath);
        if (!isImagePath(absPath)) throw new Error(`Not a supported image file: ${filePath}`);
        absPaths.push(absPath);
    }

    const columns = Math.min(3, absPaths.length);
    const rows = Math.ceil(absPaths.length / columns);
    const margin = 24;
    const gap = 18;
    const captionHeight = 46;
    const cellWidth = tileSize;
    const imageHeight = tileSize;
    const cellHeight = imageHeight + captionHeight;
    const width = margin * 2 + columns * cellWidth + (columns - 1) * gap;
    const height = margin * 2 + rows * cellHeight + (rows - 1) * gap;
    const composites: sharp.OverlayOptions[] = [];
    const files: Array<{ name: string; path: string }> = [];

    for (let i = 0; i < absPaths.length; i++) {
        const absPath = absPaths[i];
        const col = i % columns;
        const row = Math.floor(i / columns);
        const left = margin + col * (cellWidth + gap);
        const top = margin + row * (cellHeight + gap);

        const image = await sharp(absPath)
            .rotate()
            .resize({ width: cellWidth, height: imageHeight, fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer({ resolveWithObject: true });

        const imageLeft = left + Math.floor((cellWidth - image.info.width) / 2);
        const imageTop = top + Math.floor((imageHeight - image.info.height) / 2);
        composites.push({ input: image.data, left: imageLeft, top: imageTop });
        composites.push({ input: captionSvg(cellWidth, captionHeight, path.basename(absPath), i + 1), left, top: top + imageHeight });
        files.push({ name: path.basename(absPath), path: absPath });
    }

    const data = await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: '#ffffff',
        },
    })
        .composite(composites)
        .png()
        .toBuffer();

    return { data, width, height, files };
}

function unifiedDiff(original: string, updated: string): string {
    const before = original.split(/\r?\n/);
    const after = updated.split(/\r?\n/);
    const lines = ['--- original', '+++ updated'];
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
        if (before[i] === after[i]) {
            lines.push(` ${before[i] ?? ''}`);
        } else {
            if (before[i] !== undefined) lines.push(`-${before[i]}`);
            if (after[i] !== undefined) lines.push(`+${after[i]}`);
        }
    }
    return lines.join('\n');
}

function errorCode(err: unknown): string | undefined {
    if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
        return err.code;
    }
    return undefined;
}

function errorHints(prefix: string, err: unknown): string[] {
    const code = errorCode(err);
    const message = err instanceof Error ? err.message : String(err);
    const hints: string[] = [];

    if (code === 'ENOENT') hints.push('Verify the path exists and is spelled correctly.');
    if (code === 'EACCES' || code === 'EPERM') hints.push('Check filesystem permissions for the source and destination.');
    if (code === 'EEXIST') hints.push('Choose a different destination, or explicitly enable overwrite when the tool supports it.');
    if (code === 'ENOTDIR') hints.push('A path component expected to be a directory is a file.');
    if (code === 'EISDIR') hints.push('The supplied path is a directory; use the corresponding directory tool.');
    if (code === 'ENOTEMPTY') hints.push('The destination or directory is not empty. Use the tool’s merge/recursive option if appropriate.');
    if (message.includes('outside allowed directories') || message.includes('Access denied')) {
        hints.push('Call list_allowed_directories and use a path inside one of the returned roots.');
    }
    if (prefix.includes('delete directory')) {
        hints.push('Path-only deletion is safe for empty directories. For a non-empty directory, retry with {"path":"...","recursive":true}.');
    }
    if (prefix.includes('move file')) {
        hints.push('move_file accepts files only. To move, rename, or merge a directory, use move_directory.');
    }
    if (prefix.includes('move directory')) {
        hints.push('Destination is the exact final directory path, not merely its parent. For example, use "/projects/client" rather than "/projects".');
        hints.push('An existing destination is rejected by default. Set merge to true only when you intentionally want to merge the source contents into it.');
    }
    if (prefix.includes('zip archive')) {
        hints.push('Use .zip paths inside an allowed directory and ensure input paths have distinct top-level names.');
    }

    return [...new Set(hints)];
}

function errorResult(prefix: string, err: unknown) {
    const code = errorCode(err);
    const hints = errorHints(prefix.toLowerCase(), err);
    const details = [
        `${prefix}: ${err instanceof Error ? err.message : String(err)}`,
        code ? `Error code: ${code}` : undefined,
        hints.length > 0 ? `How to fix:\n${hints.map(hint => `- ${hint}`).join('\n')}` : undefined,
    ].filter(Boolean);
    return {
        content: [{ type: 'text' as const, text: details.join('\n') }],
        isError: true,
    };
}

async function pathExists(candidate: string): Promise<boolean> {
    try {
        await fs.lstat(candidate);
        return true;
    } catch (err) {
        if (errorCode(err) === 'ENOENT') return false;
        throw err;
    }
}

async function assertPathType(candidate: string, expected: 'file' | 'directory'): Promise<void> {
    const stats = await fs.lstat(candidate);
    const matches = expected === 'file' ? stats.isFile() : stats.isDirectory();
    if (!matches) {
        throw new Error(`Source path is not a ${expected}. ${expected === 'file' ? 'Use move_directory for directories.' : 'Use move_file for files.'}`);
    }
}

function assertNotNested(source: string, destination: string): void {
    if (isWithin(source, destination)) {
        throw new Error('Destination cannot be the source directory itself or a location inside it.');
    }
}

async function copyFileSafely(source: string, destination: string, overwrite: boolean): Promise<void> {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
}

async function moveFilePath(source: string, destination: string, overwrite: boolean): Promise<string> {
    const destinationExists = await pathExists(destination);
    if (destinationExists) {
        const destinationStats = await fs.lstat(destination);
        if (destinationStats.isDirectory()) {
            destination = path.join(destination, path.basename(source));
        }
    }

    if (await pathExists(destination)) {
        const destinationStats = await fs.lstat(destination);
        if (!destinationStats.isFile()) throw new Error(`Destination exists and is not a file: ${destination}`);
        if (!overwrite) throw Object.assign(new Error(`Destination file already exists: ${destination}`), { code: 'EEXIST' });
        await fs.rm(destination);
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
        await fs.rename(source, destination);
    } catch (err) {
        if (errorCode(err) !== 'EXDEV') throw err;
        await copyFileSafely(source, destination, overwrite);
        await fs.unlink(source);
    }
    return destination;
}

async function collectMergeConflicts(source: string, destination: string, conflicts: string[]): Promise<void> {
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        const sourceChild = path.join(source, entry.name);
        const destinationChild = path.join(destination, entry.name);
        if (!await pathExists(destinationChild)) continue;

        const sourceStats = await fs.lstat(sourceChild);
        const destinationStats = await fs.lstat(destinationChild);
        if (sourceStats.isDirectory() && destinationStats.isDirectory()) {
            await collectMergeConflicts(sourceChild, destinationChild, conflicts);
        } else {
            conflicts.push(destinationChild);
        }
    }
}

async function mergeDirectory(source: string, destination: string, overwrite: boolean): Promise<void> {
    if (!overwrite) {
        const conflicts: string[] = [];
        await collectMergeConflicts(source, destination, conflicts);
        if (conflicts.length > 0) {
            const preview = conflicts.slice(0, 10).join(', ');
            const suffix = conflicts.length > 10 ? `, and ${conflicts.length - 10} more` : '';
            throw Object.assign(new Error(`Merge would overwrite ${conflicts.length} existing path(s): ${preview}${suffix}`), { code: 'EEXIST' });
        }
    }

    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        const sourceChild = path.join(source, entry.name);
        const destinationChild = path.join(destination, entry.name);
        const destinationExists = await pathExists(destinationChild);

        if (entry.isDirectory() && destinationExists && (await fs.lstat(destinationChild)).isDirectory()) {
            await mergeDirectory(sourceChild, destinationChild, overwrite);
            continue;
        }
        if (destinationExists) await fs.rm(destinationChild, { recursive: true });
        await fs.mkdir(path.dirname(destinationChild), { recursive: true });
        try {
            await fs.rename(sourceChild, destinationChild);
        } catch (err) {
            if (errorCode(err) !== 'EXDEV') throw err;
            await fs.cp(sourceChild, destinationChild, { recursive: true, force: overwrite, errorOnExist: !overwrite });
            await fs.rm(sourceChild, { recursive: true });
        }
    }
    await fs.rmdir(source);
}

async function moveDirectoryPath(source: string, destination: string, merge: boolean, overwrite: boolean): Promise<'moved' | 'merged'> {
    assertNotNested(source, destination);
    if (await pathExists(destination)) {
        const destinationStats = await fs.lstat(destination);
        if (!destinationStats.isDirectory()) throw new Error(`Destination exists and is not a directory: ${destination}`);
        if (!merge) {
            throw Object.assign(new Error(
                `Destination directory already exists: ${destination}. ` +
                `The destination must be the exact new path, including the source directory name. ` +
                `If you intentionally want to merge the source contents into this existing directory, retry with merge: true.`,
            ), { code: 'EEXIST' });
        }
        await mergeDirectory(source, destination, overwrite);
        return 'merged';
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
        await fs.rename(source, destination);
    } catch (err) {
        if (errorCode(err) !== 'EXDEV') throw err;
        await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
        await fs.rm(source, { recursive: true });
    }
    return 'moved';
}

function archiveEntryName(filePath: string): string {
    const name = path.basename(filePath);
    if (!name || name === path.sep) throw new Error(`Cannot archive a filesystem root directly: ${filePath}`);
    return name;
}

async function createZipArchive(filePaths: string[], destination: string, overwrite: boolean): Promise<void> {
    const absDestination = await resolveAllowedPath(destination);
    const sources: Array<{ absPath: string; name: string; isDirectory: boolean }> = [];
    const topLevelNames = new Set<string>();

    for (const filePath of filePaths) {
        const absPath = await resolveAllowedPath(filePath);
        const stats = await fs.lstat(absPath);
        if (!stats.isFile() && !stats.isDirectory()) throw new Error(`Unsupported archive input type: ${filePath}`);
        const name = archiveEntryName(absPath);
        if (topLevelNames.has(name)) throw new Error(`Duplicate top-level archive name "${name}". Rename an input or archive it separately.`);
        topLevelNames.add(name);
        if (stats.isDirectory() && isWithin(absPath, absDestination)) {
            throw new Error(`Archive destination cannot be inside an input directory: ${absPath}`);
        }
        sources.push({ absPath, name, isDirectory: stats.isDirectory() });
    }

    if (await pathExists(absDestination)) {
        if (!overwrite) throw Object.assign(new Error(`Archive already exists: ${absDestination}`), { code: 'EEXIST' });
        const stats = await fs.lstat(absDestination);
        if (!stats.isFile()) throw new Error(`Archive destination is not a file: ${absDestination}`);
    }

    await fs.mkdir(path.dirname(absDestination), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(absDestination, { flags: overwrite ? 'w' : 'wx' });
        const archive = new ZipArchive({ zlib: { level: 9 } });
        const fail = (err: Error) => reject(err);
        output.on('close', resolve);
        output.on('error', fail);
        archive.on('error', fail);
        archive.pipe(output);
        for (const source of sources) {
            if (source.isDirectory) archive.directory(source.absPath, source.name);
            else archive.file(source.absPath, { name: source.name });
        }
        void archive.finalize();
    }).catch(async err => {
        await fs.rm(absDestination, { force: true }).catch(() => undefined);
        throw err;
    });
}

function safeZipEntryPath(destination: string, entryPath: string): string {
    const normalized = entryPath.replace(/\\/g, '/');
    if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
        throw new Error(`Unsafe absolute ZIP entry path: ${entryPath}`);
    }
    const target = path.resolve(destination, normalized);
    if (!isWithin(destination, target)) throw new Error(`Unsafe ZIP entry escapes destination: ${entryPath}`);
    return target;
}

async function extractZipArchive(archivePath: string, destination: string | undefined, overwrite: boolean): Promise<string> {
    const absArchive = await resolveAllowedPath(archivePath);
    await assertPathType(absArchive, 'file');
    const defaultDestination = path.join(path.dirname(absArchive), path.basename(absArchive, path.extname(absArchive)));
    const absDestination = await resolveAllowedPath(destination ?? defaultDestination);
    const zip = await unzipper.Open.file(absArchive);
    const entries = [];
    const archiveTargets = new Set<string>();
    for (const entry of zip.files) {
        const target = safeZipEntryPath(absDestination, entry.path);
        const resolvedTarget = await resolveAllowedPath(target);
        if (!isWithin(absDestination, resolvedTarget)) {
            throw new Error(`Unsafe ZIP entry resolves outside destination through a symbolic link: ${entry.path}`);
        }
        if (archiveTargets.has(resolvedTarget)) {
            throw new Error(`ZIP archive contains duplicate destination entries: ${entry.path}`);
        }
        archiveTargets.add(resolvedTarget);
        entries.push({ entry, target: resolvedTarget });
    }

    const conflicts = [];
    for (const { entry, target } of entries) {
        if (!await pathExists(target)) continue;
        const existingStats = await fs.lstat(target);
        const typeMatches = entry.type === 'Directory' ? existingStats.isDirectory() : existingStats.isFile();
        if (!typeMatches) {
            throw new Error(`ZIP entry type conflicts with existing path: ${target}`);
        }
        if (!overwrite && entry.type !== 'Directory') conflicts.push(target);
    }
    if (conflicts.length > 0) {
        throw Object.assign(new Error(`Extraction would overwrite ${conflicts.length} existing file(s): ${conflicts.slice(0, 10).join(', ')}`), { code: 'EEXIST' });
    }

    await fs.mkdir(absDestination, { recursive: true });
    for (const { entry, target } of entries) {
        if (entry.type === 'Directory') {
            await fs.mkdir(target, { recursive: true });
            continue;
        }
        if (entry.type !== 'File') throw new Error(`Unsupported ZIP entry type for ${entry.path}: ${entry.type}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (overwrite) await fs.rm(target, { force: true });
        await new Promise<void>((resolve, reject) => {
            const output = createWriteStream(target, { flags: 'wx' });
            entry.stream().on('error', reject).pipe(output).on('error', reject).on('finish', resolve);
        });
    }
    return absDestination;
}

const server = new McpServer({
    name: 'File Access',
    version: '1.1.0',
    title: 'File Access',
    description: 'Safe file access, editing, directory browsing, ZIP archives, media reads, and image thumbnails.',
    icons: [{ src: 'https://raw.githubusercontent.com/andreasjhagen/Cynosure-MCPs/main/mcp-file-access/icon.png', mimeType: 'image/png' }],
});

server.registerTool(
    'list_allowed_directories',
    {
        description: 'List the absolute directory roots this MCP may access.',
        inputSchema: {},
    },
    async () => ({
        content: [{ type: 'text', text: JSON.stringify({ allowedDirectories: ALLOWED_DIRECTORIES }, null, 2) }],
    }),
);

server.registerTool(
    'get_file_info',
    {
        description: 'Get metadata for a file or directory path.',
        inputSchema: { path: z.string().describe('File or directory path.') },
    },
    async ({ path: inputPath }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const info = await toFileEntry(absPath);
            return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
        } catch (err) {
            return errorResult('Failed to get file info', err);
        }
    },
);

server.registerTool(
    'list_directory',
    {
        description: 'List directory contents, excluding common dependency/build/cache folders by default.',
        inputSchema: { path: z.string().describe('Directory path.') },
    },
    async ({ path: inputPath }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const entries = await readDirectoryEntries(absPath);
            return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
        } catch (err) {
            return errorResult('Failed to list directory', err);
        }
    },
);

server.registerTool(
    'list_directory_with_sizes',
    {
        description: 'List directory contents with recursive directory sizes. Sort by name, size, or modified time.',
        inputSchema: {
            path: z.string().describe('Directory path.'),
            sortBy: z.enum(['name', 'size', 'modified']).optional().describe('Sort entries by name, size, or modified time. Defaults to name.'),
        },
    },
    async ({ path: inputPath, sortBy }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const entries = await readDirectoryEntries(absPath, true, sortBy);
            const enriched = entries.map(entry => ({ ...entry, sizeHuman: formatBytes(entry.size) }));
            return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] };
        } catch (err) {
            return errorResult('Failed to list directory with sizes', err);
        }
    },
);

server.registerTool(
    'directory_tree',
    {
        description: 'Return a JSON directory tree up to a maximum depth, excluding common generated folders by default.',
        inputSchema: {
            path: z.string().describe('Directory path.'),
            depth: z.number().int().min(0).max(10).optional().describe('Maximum depth to traverse. Defaults to 3.'),
            excludePatterns: z.array(z.string()).optional().describe('Additional file, directory, or glob-like patterns to exclude.'),
        },
    },
    async ({ path: inputPath, depth, excludePatterns }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const tree = await buildTree(absPath, depth ?? 3, excludePatterns ?? []);
            return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
        } catch (err) {
            return errorResult('Failed to build directory tree', err);
        }
    },
);

server.registerTool(
    'search_files',
    {
        description: 'Search for files and directories by name/path using a case-insensitive glob-like pattern.',
        inputSchema: {
            path: z.string().describe('Directory path to search.'),
            pattern: z.string().describe('Name/path pattern. Supports * and ?.'),
            excludePatterns: z.array(z.string()).optional().describe('Additional file, directory, or glob-like patterns to exclude.'),
        },
    },
    async ({ path: inputPath, pattern, excludePatterns }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const results: string[] = [];
            await searchFilesRecursive(absPath, searchPatternToRegExp(pattern), excludePatterns ?? [], results);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
            return errorResult('Failed to search files', err);
        }
    },
);

server.registerTool(
    'read_text_file',
    {
        description: 'Read a UTF-8 text file. Optionally return only the first head lines or last tail lines.',
        inputSchema: {
            path: z.string().describe('Text file path.'),
            head: z.number().int().positive().optional().describe('Return only the first N lines.'),
            tail: z.number().int().positive().optional().describe('Return only the last N lines.'),
        },
    },
    async ({ path: inputPath, head, tail }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const text = await readText(absPath, head, tail);
            return { content: [{ type: 'text', text }] };
        } catch (err) {
            return errorResult('Failed to read text file', err);
        }
    },
);

server.registerTool(
    'read_multiple_files',
    {
        description: 'Read multiple UTF-8 text files in one call.',
        inputSchema: {
            paths: z.array(z.string()).min(1).describe('Text file paths to read.'),
        },
    },
    async ({ paths }) => {
        try {
            const files = [];
            for (const filePath of paths) {
                const absPath = await resolveAllowedPath(filePath);
                files.push({ path: absPath, content: await readText(absPath) });
            }
            return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
        } catch (err) {
            return errorResult('Failed to read multiple files', err);
        }
    },
);

server.registerTool(
    'read_media_file',
    {
        description: 'Read a media file. Images are returned inline for model vision; other media is returned as base64 text with MIME metadata.',
        inputSchema: { path: z.string().describe('Media file path.') },
    },
    async ({ path: inputPath }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const stats = await fs.stat(absPath);
            if (stats.size > MAX_MEDIA_BYTES) {
                throw new Error(`Media file is too large (${formatBytes(stats.size)}). Limit is ${formatBytes(MAX_MEDIA_BYTES)}.`);
            }
            const data = await fs.readFile(absPath);
            const mimeType = mimeForPath(absPath);
            const metadata = { path: absPath, mimeType, size: stats.size, sizeHuman: formatBytes(stats.size) };

            if (isImagePath(absPath)) {
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(metadata, null, 2) },
                        { type: 'image', data: data.toString('base64'), mimeType },
                    ],
                };
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ ...metadata, base64: data.toString('base64') }, null, 2),
                }],
            };
        } catch (err) {
            return errorResult('Failed to read media file', err);
        }
    },
);

server.registerTool(
    'get_image_thumbnails',
    {
        description: 'Create inline PNG thumbnails for multiple image files, each paired with its source name/path for classification workflows.',
        inputSchema: {
            paths: z.array(z.string()).min(1).describe('Image file paths.'),
            size: z.number().int().min(32).max(1024).optional().describe('Maximum thumbnail width/height in pixels. Defaults to 256.'),
        },
    },
    async ({ paths, size }) => {
        try {
            const content = [];
            for (const filePath of paths) {
                const absPath = await resolveAllowedPath(filePath);
                if (!isImagePath(absPath)) throw new Error(`Not a supported image file: ${filePath}`);
                const thumb = await sharp(absPath)
                    .rotate()
                    .resize({ width: size ?? 256, height: size ?? 256, fit: 'inside', withoutEnlargement: true })
                    .png()
                    .toBuffer();
                content.push({ type: 'text' as const, text: JSON.stringify({ name: path.basename(absPath), path: absPath, mimeType: 'image/png' }) });
                content.push({ type: 'image' as const, data: thumb.toString('base64'), mimeType: 'image/png' });
            }
            return { content };
        } catch (err) {
            return errorResult('Failed to create thumbnails', err);
        }
    },
);

server.registerTool(
    'read_multiple_media_files',
    {
        description: 'Read up to 6 image files as one medium PNG collage/contact sheet with each file name captioned for comparison or classification.',
        inputSchema: {
            paths: z.array(z.string()).min(1).max(6).describe('Image file paths to include in the collage. Supports PNG, JPEG, WebP, GIF, AVIF, TIFF, BMP, and SVG when supported by sharp.'),
            tileSize: z.number().int().min(160).max(512).optional().describe('Maximum image tile width/height in pixels. Defaults to 320.'),
        },
    },
    async ({ paths, tileSize }) => {
        try {
            const collage = await createImageCollage(paths, tileSize ?? 320);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            mimeType: 'image/png',
                            width: collage.width,
                            height: collage.height,
                            files: collage.files,
                        }, null, 2),
                    },
                    { type: 'image', data: collage.data.toString('base64'), mimeType: 'image/png' },
                ],
            };
        } catch (err) {
            return errorResult('Failed to read multiple media files', err);
        }
    },
);

server.registerTool(
    'write_file',
    {
        description: 'Write a UTF-8 text file. Set overwrite to true to replace an existing file.',
        inputSchema: {
            path: z.string().describe('File path to write.'),
            content: z.string().describe('UTF-8 text content.'),
            overwrite: z.boolean().optional().describe('Whether to overwrite an existing file. Defaults to false.'),
        },
    },
    async ({ path: inputPath, content, overwrite }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
            return { content: [{ type: 'text', text: `Wrote file: ${absPath}` }] };
        } catch (err) {
            return errorResult('Failed to write file', err);
        }
    },
);

server.registerTool(
    'edit_file',
    {
        description: 'Apply string replacements to a UTF-8 text file. Use dryRun to preview a unified diff without writing.',
        inputSchema: {
            path: z.string().describe('Text file path.'),
            edits: z.array(z.object({
                oldText: z.string().describe('Exact text to replace.'),
                newText: z.string().describe('Replacement text.'),
                replaceAll: z.boolean().optional().describe('Replace all occurrences. Defaults to false.'),
            })).min(1).describe('Replacement edits to apply in order.'),
            dryRun: z.boolean().optional().describe('Preview changes without writing. Defaults to false.'),
        },
    },
    async ({ path: inputPath, edits, dryRun }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const original = await readText(absPath);
            let updated = original;
            for (const edit of edits) {
                if (!updated.includes(edit.oldText)) throw new Error(`oldText not found: ${edit.oldText.slice(0, 80)}`);
                updated = edit.replaceAll ? updated.split(edit.oldText).join(edit.newText) : updated.replace(edit.oldText, edit.newText);
            }
            const diff = unifiedDiff(original, updated);
            if (!dryRun) await fs.writeFile(absPath, updated, 'utf8');
            return { content: [{ type: 'text', text: `${dryRun ? 'Dry run only.' : `Edited file: ${absPath}`}\n\n${diff}` }] };
        } catch (err) {
            return errorResult('Failed to edit file', err);
        }
    },
);

server.registerTool(
    'create_directory',
    {
        description: 'Create a directory, including parent directories as needed.',
        inputSchema: { path: z.string().describe('Directory path to create.') },
    },
    async ({ path: inputPath }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            await fs.mkdir(absPath, { recursive: true });
            return { content: [{ type: 'text', text: `Created directory: ${absPath}` }] };
        } catch (err) {
            return errorResult('Failed to create directory', err);
        }
    },
);

server.registerTool(
    'move_file',
    {
        description: 'Move or rename a file. If destination is an existing directory, the file is moved into it. Use move_directory for directories.',
        inputSchema: {
            source: z.string().describe('Source file path.'),
            destination: z.string().describe('Destination file path, or an existing directory that should contain the file.'),
            overwrite: z.boolean().optional().describe('Replace an existing destination file. Defaults to false.'),
        },
    },
    async ({ source, destination, overwrite }) => {
        try {
            const absSource = await resolveAllowedPath(source);
            const absDestination = await resolveAllowedPath(destination);
            await assertPathType(absSource, 'file');
            const finalDestination = await moveFilePath(absSource, absDestination, overwrite ?? false);
            return { content: [{ type: 'text', text: `Moved ${absSource} to ${finalDestination}` }] };
        } catch (err) {
            return errorResult('Failed to move file', err);
        }
    },
);

server.registerTool(
    'move_directory',
    {
        description: 'Move or rename a directory to an exact final path. IMPORTANT: destination must include the directory name, not just its existing parent. Existing destinations are rejected unless merge is explicitly true.',
        inputSchema: {
            source: z.string().describe('Source directory path.'),
            destination: z.string().describe('Exact final directory path, including the moved directory name. Example: to move /clients/acme under /projects, use /projects/acme, not /projects.'),
            merge: z.boolean().optional().describe('Explicitly merge the source contents into an existing destination directory. Defaults to false. Never enable this merely because the destination parent already exists.'),
            overwrite: z.boolean().optional().describe('When merge is true, allow conflicts to replace existing destination paths. Defaults to false.'),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        },
    },
    async ({ source, destination, merge, overwrite }) => {
        try {
            const absSource = await resolveAllowedPath(source);
            const absDestination = await resolveAllowedPath(destination);
            await assertPathType(absSource, 'directory');
            if (overwrite && !merge) throw new Error('overwrite is only valid when merge is explicitly true.');
            const operation = await moveDirectoryPath(absSource, absDestination, merge ?? false, overwrite ?? false);
            return { content: [{ type: 'text', text: `${operation === 'merged' ? 'Merged' : 'Moved'} directory ${absSource} ${operation === 'merged' ? 'into' : 'to'} ${absDestination}` }] };
        } catch (err) {
            return errorResult('Failed to move directory', err);
        }
    },
);

server.registerTool(
    'create_zip_archive',
    {
        description: 'Create a ZIP archive from one or more files/directories. Inputs keep their top-level names.',
        inputSchema: {
            filePaths: z.array(z.string()).min(1).describe('Files and/or directories to include in the ZIP archive.'),
            destination: z.string().describe('Destination .zip file path.'),
            overwrite: z.boolean().optional().describe('Replace an existing ZIP file. Defaults to false.'),
        },
    },
    async ({ filePaths, destination, overwrite }) => {
        try {
            await createZipArchive(filePaths, destination, overwrite ?? false);
            const absDestination = await resolveAllowedPath(destination);
            return { content: [{ type: 'text', text: `Created ZIP archive: ${absDestination}` }] };
        } catch (err) {
            return errorResult('Failed to create ZIP archive', err);
        }
    },
);

server.registerTool(
    'extract_zip_archive',
    {
        description: 'Safely extract a ZIP archive. Rejects entries that escape the destination and avoids overwriting files by default.',
        inputSchema: {
            archivePath: z.string().describe('ZIP archive file path.'),
            destination: z.string().optional().describe('Extraction directory. Defaults to a sibling directory named after the archive.'),
            overwrite: z.boolean().optional().describe('Replace existing destination files. Defaults to false.'),
        },
    },
    async ({ archivePath, destination, overwrite }) => {
        try {
            const extractedTo = await extractZipArchive(archivePath, destination, overwrite ?? false);
            return { content: [{ type: 'text', text: `Extracted ZIP archive to: ${extractedTo}` }] };
        } catch (err) {
            return errorResult('Failed to extract ZIP archive', err);
        }
    },
);

server.registerTool(
    'delete_file',
    {
        description: 'Delete a single file.',
        inputSchema: { path: z.string().describe('File path to delete.') },
    },
    async ({ path: inputPath }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const stats = await fs.lstat(absPath);
            if (!stats.isFile()) throw new Error('Path is not a file.');
            await fs.unlink(absPath);
            return { content: [{ type: 'text', text: `Deleted file: ${absPath}` }] };
        } catch (err) {
            return errorResult('Failed to delete file', err);
        }
    },
);

server.registerTool(
    'delete_directory',
    {
        description: 'Delete a directory. Set recursive to true to remove non-empty directories.',
        inputSchema: {
            path: z.string().describe('Directory path to delete.'),
            recursive: z.boolean().optional().describe('Delete directory contents recursively. Defaults to false.'),
        },
    },
    async ({ path: inputPath, recursive }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const stats = await fs.lstat(absPath);
            if (!stats.isDirectory()) throw new Error('Path is not a directory.');
            if (recursive) {
                await fs.rm(absPath, { recursive: true });
            } else {
                const entries = await fs.readdir(absPath);
                if (entries.length > 0) {
                    throw Object.assign(new Error(`Directory is not empty (${entries.length} direct entr${entries.length === 1 ? 'y' : 'ies'}). Recursive deletion is disabled by default.`), { code: 'ENOTEMPTY' });
                }
                await fs.rmdir(absPath);
            }
            return { content: [{ type: 'text', text: `Deleted directory: ${absPath}` }] };
        } catch (err) {
            return errorResult('Failed to delete directory', err);
        }
    },
);

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log(`File Access MCP server running on stdio. Allowed directories: ${ALLOWED_DIRECTORIES.join(', ')}`);
}

main().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
});
