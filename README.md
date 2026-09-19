# File Access MCP

MCP server for safe file access, editing, directory browsing, ZIP archives, and image thumbnails.

## Configuration

By default, the server allows access to the process working directory only.

Set `FILE_ACCESS_ALLOWED_DIRECTORIES` to a platform path-list to grant access to specific roots:

```bash
FILE_ACCESS_ALLOWED_DIRECTORIES="/path/to/project:/path/to/assets"
```

On Windows, use `;` as the separator.

## Tools

- `info` — inspect a path, or list allowed roots when `path` is omitted
- `list_directory` — flat, size-aware, or tree listings
- `search` — find files and directories by name/path
- `read_file` — read one or many text/media files, thumbnails, or an image collage
- `write_file`
- `edit_file` — sed-like ordered, exact-text replacements with preview-only behavior by default
- `create_directory`
- `move` — move a file or directory
- `merge` — merge one directory into another
- `archive` — create or extract ZIP archives
- `delete` — delete a file or directory

Common generated and dependency folders such as `node_modules`, `.git`, `dist`, `build`, `.next`, and cache directories are excluded from traversal by default.

`read_file` uses text mode by default. Set `mode` to `media`, `thumbnails`, or `collage` for binary media workflows. Collage mode accepts 1-6 image paths and returns a single PNG contact sheet with file-name captions.

`edit_file` works like `sed`: provide `path` and an `edits` array of `{ "oldText": "exact text", "newText": "replacement" }` objects. Edits are applied in order. Set `replaceAll: true` on an edit to replace every occurrence, and set `dryRun: false` on the tool call to write the result. It accepts literal replacements, not unified diffs or patch strings.

`move` detects whether its source is a file or directory. For files, an existing destination directory receives the file. For directories, the destination is an exact new path that must not exist and must include the directory name—for example, use `/projects/acme`, not `/projects`.

`merge` moves the source directory's contents directly into an existing destination directory and removes the emptied source. It checks all conflicts before moving anything and rejects them by default. Set `overwrite: true` only when existing destination paths may be replaced.

`delete` removes files or empty directories when only `path` is supplied. Deleting a non-empty directory requires the explicit `recursive: true` option.

`archive` validates every extracted entry against path traversal and does not overwrite existing files unless `overwrite: true` is supplied.
