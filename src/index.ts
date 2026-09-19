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
    if (code === 'ENOTEMPTY') hints.push('The destination or directory is not empty. Use merge or the recursive deletion option if appropriate.');
    if (message.includes('outside allowed directories') || message.includes('Access denied')) {
        hints.push('Call info without a path and use a path inside one of the returned roots.');
    }
    if (prefix.includes('delete directory')) {
        hints.push('Path-only deletion is safe for empty directories. For a non-empty directory, retry with {"path":"...","recursive":true}.');
    }
    if (prefix.includes('move')) {
        hints.push('Destination is the exact final directory path, not merely its parent. For example, use "/projects/client" rather than "/projects".');
        hints.push('Moving a directory requires a new destination path. To combine the source contents with an existing directory, use merge.');
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
        throw new Error(`Path is not a ${expected}.`);
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

async function moveDirectoryPath(source: string, destination: string): Promise<void> {
    assertNotNested(source, destination);
    if (await pathExists(destination)) {
        throw Object.assign(new Error(
            `Destination already exists: ${destination}. ` +
            `move requires an exact new path, including the source directory name. ` +
            `Use merge only when you intend to move the source contents into an existing directory.`,
        ), { code: 'EEXIST' });
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
        await fs.rename(source, destination);
    } catch (err) {
        if (errorCode(err) !== 'EXDEV') throw err;
        await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
        await fs.rm(source, { recursive: true });
    }
}

async function mergeDirectoryPath(source: string, destination: string, overwrite: boolean): Promise<void> {
    assertNotNested(source, destination);
    if (!await pathExists(destination)) {
        throw Object.assign(new Error(
            `Merge destination does not exist: ${destination}. ` +
            `merge requires an existing destination directory. Use move to move or rename a directory to a new path.`,
        ), { code: 'ENOENT' });
    }
    const destinationStats = await fs.lstat(destination);
    if (!destinationStats.isDirectory()) throw new Error(`Merge destination is not a directory: ${destination}`);
    await mergeDirectory(source, destination, overwrite);
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
    version: '1.1.1',
    title: 'File Access',
    description: 'Safe file access, editing, directory browsing, ZIP archives, media reads, and image thumbnails.',
    icons: [{ src: 'https://unpkg.com/@cynosure-mcp/file-access@1.1.1/icon.png', mimeType: 'image/png' }],
});

server.registerTool(
    'info',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Get metadata for a file or directory. Omit path to list the directory roots this MCP may access.',
        inputSchema: { path: z.string().optional().describe('File or directory path. Omit to list allowed directory roots.') },
    },
    async ({ path: inputPath }) => {
        try {
            if (inputPath === undefined) {
                return { content: [{ type: 'text', text: JSON.stringify({ allowedDirectories: ALLOWED_DIRECTORIES }, null, 2) }] };
            }
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
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'List directory contents or return a directory tree. Common dependency/build/cache folders are excluded by default.',
        inputSchema: {
            path: z.string().describe('Directory path.'),
            tree: z.boolean().optional().describe('Return a nested tree instead of a flat listing. Defaults to false.'),
            depth: z.number().int().min(0).max(10).optional().describe('Tree depth. Used only when tree is true; defaults to 3.'),
            includeSizes: z.boolean().optional().describe('Calculate recursive directory sizes for a flat listing. Defaults to false.'),
            sortBy: z.enum(['name', 'size', 'modified']).optional().describe('Sort a flat listing. Defaults to name.'),
            excludePatterns: z.array(z.string()).optional().describe('Additional patterns to exclude from a tree.'),
        },
    },
    async ({ path: inputPath, tree, depth, includeSizes, sortBy, excludePatterns }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            if (tree) {
                const result = await buildTree(absPath, depth ?? 3, excludePatterns ?? []);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            const entries = await readDirectoryEntries(absPath, includeSizes ?? false, sortBy);
            const result = includeSizes
                ? entries.map(entry => ({ ...entry, sizeHuman: formatBytes(entry.size) }))
                : entries;
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            return errorResult('Failed to list directory', err);
        }
    },
);

server.registerTool(
    'search',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    'read_file',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Read one or more text or media files. Text is the default; use mode for media, thumbnails, or an image collage.',
        inputSchema: {
            path: z.string().optional().describe('One file path. Use either path or paths.'),
            paths: z.array(z.string()).min(1).max(100).optional().describe('One or more file paths. Use either path or paths.'),
            mode: z.enum(['text', 'media', 'thumbnails', 'collage']).optional().describe('Read mode. Defaults to text. Thumbnails and collage require images.'),
            head: z.number().int().positive().optional().describe('Return only the first N lines.'),
            tail: z.number().int().positive().optional().describe('Return only the last N lines.'),
            size: z.number().int().min(32).max(1024).optional().describe('Thumbnail size in pixels. Defaults to 256.'),
            tileSize: z.number().int().min(160).max(512).optional().describe('Collage tile size in pixels. Defaults to 320.'),
        },
    },
    async ({ path: inputPath, paths, mode, head, tail, size, tileSize }) => {
        try {
            if ((inputPath === undefined) === (paths === undefined)) {
                throw new Error('Provide exactly one of path or paths.');
            }
            const requestedPaths = inputPath === undefined ? paths! : [inputPath];
            const readMode = mode ?? 'text';

            if (readMode === 'collage') {
                const collage = await createImageCollage(requestedPaths, tileSize ?? 320);
                return {
                    content: [
                        { type: 'text', text: JSON.stringify({ mimeType: 'image/png', width: collage.width, height: collage.height, files: collage.files }, null, 2) },
                        { type: 'image', data: collage.data.toString('base64'), mimeType: 'image/png' },
                    ],
                };
            }

            if (readMode === 'thumbnails') {
                const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
                for (const filePath of requestedPaths) {
                    const absPath = await resolveAllowedPath(filePath);
                    if (!isImagePath(absPath)) throw new Error(`Not a supported image file: ${filePath}`);
                    const thumb = await sharp(absPath).rotate().resize({ width: size ?? 256, height: size ?? 256, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
                    content.push({ type: 'text', text: JSON.stringify({ name: path.basename(absPath), path: absPath, mimeType: 'image/png' }) });
                    content.push({ type: 'image', data: thumb.toString('base64'), mimeType: 'image/png' });
                }
                return { content };
            }

            if (readMode === 'media') {
                const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
                for (const filePath of requestedPaths) {
                    const absPath = await resolveAllowedPath(filePath);
                    const stats = await fs.stat(absPath);
                    if (stats.size > MAX_MEDIA_BYTES) throw new Error(`Media file is too large (${formatBytes(stats.size)}). Limit is ${formatBytes(MAX_MEDIA_BYTES)}.`);
                    const data = await fs.readFile(absPath);
                    const mimeType = mimeForPath(absPath);
                    const metadata = { path: absPath, mimeType, size: stats.size, sizeHuman: formatBytes(stats.size) };
                    if (isImagePath(absPath)) {
                        content.push({ type: 'text', text: JSON.stringify(metadata, null, 2) });
                        content.push({ type: 'image', data: data.toString('base64'), mimeType });
                    } else {
                        content.push({ type: 'text', text: JSON.stringify({ ...metadata, base64: data.toString('base64') }, null, 2) });
                    }
                }
                return { content };
            }

            const files = [];
            for (const filePath of requestedPaths) {
                const absPath = await resolveAllowedPath(filePath);
                files.push({ path: absPath, content: await readText(absPath, head, tail) });
            }
            return { content: [{ type: 'text', text: files.length === 1 ? files[0].content : JSON.stringify(files, null, 2) }] };
        } catch (err) {
            return errorResult('Failed to read file', err);
        }
    },
);

server.registerTool(
    'write_file',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Sed-like editing for a UTF-8 text file: apply ordered, exact oldText-to-newText replacements. Pass path plus an edits array; do not pass a unified diff or patch string. Preview-only by default; set dryRun to false to write.',
        inputSchema: {
            path: z.string({
                required_error: 'Required parameter "path" is missing. Use {"path":"/path/to/file","edits":[{"oldText":"exact text","newText":"replacement"}]}; the parameter is named "path", not "file", "filePath", or "file_path".',
                invalid_type_error: 'Parameter "path" must be a string containing the text file path.',
            }).describe('Text file path. The parameter name is path (not file, filePath, or file_path).'),
            edits: z.array(z.object({
                oldText: z.string({
                    required_error: 'Each edit requires an "oldText" string containing the exact text to find.',
                    invalid_type_error: 'Each edit\'s "oldText" must be a string.',
                }).describe('Exact literal text to find, like the search expression in sed.'),
                newText: z.string({
                    required_error: 'Each edit requires a "newText" string containing the replacement text.',
                    invalid_type_error: 'Each edit\'s "newText" must be a string.',
                }).describe('Literal replacement text, like the replacement expression in sed.'),
                replaceAll: z.boolean().optional().describe('Replace all occurrences. Defaults to false.'),
            }, {
                invalid_type_error: 'Each item in "edits" must be an object shaped like {"oldText":"exact text","newText":"replacement","replaceAll":false}.',
            }), {
                required_error: 'Required parameter "edits" is missing. It must be an array such as [{"oldText":"exact text","newText":"replacement"}].',
                invalid_type_error: 'Parameter "edits" must be an array of objects, for example [{"oldText":"exact text","newText":"replacement"}]. Do not pass a unified diff or patch string.',
            }).min(1, 'Parameter "edits" must contain at least one {"oldText":"...","newText":"..."} object.').describe('Ordered sed-like replacements. Example: [{"oldText":"exact text","newText":"replacement","replaceAll":false}].'),
            dryRun: z.boolean().optional().describe('Preview changes without writing. Defaults to true; explicitly set false to write.'),
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
            const previewOnly = dryRun ?? true;
            if (!previewOnly) await fs.writeFile(absPath, updated, 'utf8');
            return { content: [{ type: 'text', text: `${previewOnly ? 'Dry run only.' : `Edited file: ${absPath}`}\n\n${diff}` }] };
        } catch (err) {
            return errorResult('Failed to edit file', err);
        }
    },
);

server.registerTool(
    'create_directory',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    'move',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Move or rename a file or directory. Files may target an existing directory; directory destinations are exact new paths and must not exist.',
        inputSchema: {
            source: z.string().describe('Source file or directory path.'),
            destination: z.string().describe('Destination path. For a directory, provide the exact new path including its name.'),
            overwrite: z.boolean().optional().describe('Replace an existing destination file. Applies only when moving files; defaults to false.'),
        },
    },
    async ({ source, destination, overwrite }) => {
        try {
            const absSource = await resolveAllowedPath(source);
            const absDestination = await resolveAllowedPath(destination);
            const stats = await fs.lstat(absSource);
            if (stats.isFile()) {
                const finalDestination = await moveFilePath(absSource, absDestination, overwrite ?? false);
                return { content: [{ type: 'text', text: `Moved ${absSource} to ${finalDestination}` }] };
            }
            if (stats.isDirectory()) {
                if (overwrite) throw new Error('overwrite is only supported when moving files. Use merge to combine directories.');
                await moveDirectoryPath(absSource, absDestination);
                return { content: [{ type: 'text', text: `Moved directory ${absSource} to ${absDestination}` }] };
            }
            throw new Error('Source path is neither a regular file nor a directory.');
        } catch (err) {
            return errorResult('Failed to move', err);
        }
    },
);

server.registerTool(
    'merge',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Merge the contents of a source directory directly into an existing destination directory, then remove the emptied source directory. Conflicting paths are rejected unless overwrite is explicitly enabled.',
        inputSchema: {
            source: z.string().describe('Source directory whose contents should be moved. The source directory itself is removed after a successful merge.'),
            destination: z.string().describe('Existing destination directory that should directly receive the source contents. Do not append the source directory name.'),
            overwrite: z.boolean().optional().describe('Replace conflicting destination files or paths. Defaults to false.'),
        },
    },
    async ({ source, destination, overwrite }) => {
        try {
            const absSource = await resolveAllowedPath(source);
            const absDestination = await resolveAllowedPath(destination);
            await assertPathType(absSource, 'directory');
            await mergeDirectoryPath(absSource, absDestination, overwrite ?? false);
            return { content: [{ type: 'text', text: `Merged contents of ${absSource} into ${absDestination} and removed the source directory.` }] };
        } catch (err) {
            return errorResult('Failed to merge directory', err);
        }
    },
);

server.registerTool(
    'archive',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Create or safely extract a ZIP archive. Extraction rejects path traversal and does not overwrite by default.',
        inputSchema: {
            action: z.enum(['create', 'extract']).describe('Archive operation.'),
            filePaths: z.array(z.string()).min(1).optional().describe('Create only: files/directories to include.'),
            archivePath: z.string().optional().describe('Extract only: ZIP archive path.'),
            destination: z.string().optional().describe('Create: required destination .zip path. Extract: optional output directory.'),
            overwrite: z.boolean().optional().describe('Replace an existing archive or extracted files. Defaults to false.'),
        },
    },
    async ({ action, filePaths, archivePath, destination, overwrite }) => {
        try {
            if (action === 'create') {
                if (!filePaths || !destination) throw new Error('Creating an archive requires filePaths and destination.');
                if (archivePath !== undefined) throw new Error('archivePath is only valid when extracting an archive.');
                await createZipArchive(filePaths, destination, overwrite ?? false);
                const absDestination = await resolveAllowedPath(destination);
                return { content: [{ type: 'text', text: `Created ZIP archive: ${absDestination}` }] };
            }
            if (!archivePath) throw new Error('Extracting an archive requires archivePath.');
            if (filePaths !== undefined) throw new Error('filePaths is only valid when creating an archive.');
            const extractedTo = await extractZipArchive(archivePath, destination, overwrite ?? false);
            return { content: [{ type: 'text', text: `Extracted ZIP archive to: ${extractedTo}` }] };
        } catch (err) {
            return errorResult('Failed to process ZIP archive', err);
        }
    },
);

server.registerTool(
    'delete',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Delete a file or directory. Non-empty directories require recursive: true.',
        inputSchema: {
            path: z.string().describe('File or directory path to delete.'),
            recursive: z.boolean().optional().describe('Delete a non-empty directory recursively. Defaults to false and is ignored for files.'),
        },
    },
    async ({ path: inputPath, recursive }) => {
        try {
            const absPath = await resolveAllowedPath(inputPath);
            const stats = await fs.lstat(absPath);
            if (stats.isFile()) {
                await fs.unlink(absPath);
                return { content: [{ type: 'text', text: `Deleted file: ${absPath}` }] };
            }
            if (stats.isDirectory()) {
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
            }
            throw new Error('Path is neither a regular file nor a directory.');
        } catch (err) {
            return errorResult('Failed to delete', err);
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
