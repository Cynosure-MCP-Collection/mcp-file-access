# File Access MCP

MCP server for safe file access, editing, directory browsing, and image thumbnails.

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
- `get_image_thumbnails`
- `write_file`
- `edit_file`
- `create_directory`
- `move_file`
- `delete_file`
- `delete_directory`

Common generated and dependency folders such as `node_modules`, `.git`, `dist`, `build`, `.next`, and cache directories are excluded from traversal by default.
