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

- `list_allowed_directories`
- `get_file_info`
- `list_directory`
- `list_directory_with_sizes`
- `directory_tree`
- `search_files`
- `read_text_file`
- `read_multiple_files`
- `read_media_file`
- `read_multiple_media_files`
- `get_image_thumbnails`
- `write_file`
- `edit_file`
- `create_directory`
- `move_file`
- `move_directory`
- `create_zip_archive`
- `extract_zip_archive`
- `delete_file`
- `delete_directory`

Common generated and dependency folders such as `node_modules`, `.git`, `dist`, `build`, `.next`, and cache directories are excluded from traversal by default.

`read_multiple_media_files` accepts 1-6 image paths and returns a single PNG collage/contact sheet with file-name captions, which is useful for compact visual comparison and classification.

`move_file` moves files only. When its destination is an existing directory, the file is placed inside that directory. `move_directory` renames or moves a directory when the destination does not exist, and safely merges into an existing destination directory after checking for conflicts. Set `overwrite: true` only when existing destination paths may be replaced.

`delete_directory` deletes empty directories when only `path` is supplied. Deleting a non-empty directory requires the explicit `recursive: true` option.

`extract_zip_archive` validates every archive entry against path traversal and does not overwrite existing files unless `overwrite: true` is supplied.
