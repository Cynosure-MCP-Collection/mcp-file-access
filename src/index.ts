#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { EOL } from 'node:os';
import sharp from 'sharp';

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

function errorResult(prefix: string, err: unknown) {
    return {
        content: [{ type: 'text' as const, text: `${prefix}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
    };
}

const server = new McpServer({
    name: 'File Access',
    version: '1.0.0',
    title: 'File Access',
    description: 'Safe file access, editing, directory browsing, media reads, and image thumbnails.',
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
        description: 'Move or rename a file or directory.',
        inputSchema: {
            source: z.string().describe('Source path.'),
            destination: z.string().describe('Destination path.'),
        },
    },
    async ({ source, destination }) => {
        try {
            const absSource = await resolveAllowedPath(source);
            const absDestination = await resolveAllowedPath(destination);
            await fs.mkdir(path.dirname(absDestination), { recursive: true });
            await fs.rename(absSource, absDestination);
            return { content: [{ type: 'text', text: `Moved ${absSource} to ${absDestination}` }] };
        } catch (err) {
            return errorResult('Failed to move file', err);
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
            await fs.rm(absPath, { recursive: recursive ?? false });
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
