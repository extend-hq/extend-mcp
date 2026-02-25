# extend-mcp

MCP server for [Extend](https://extend.ai) — parse, extract, classify, split, and edit documents from any MCP-compatible client.

## Quick Start

Get your API key at [dashboard.extend.ai/developers](https://dashboard.extend.ai/developers).

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "extend": {
      "command": "npx",
      "args": ["-y", "github:extend-hq/extend-mcp"],
      "env": {
        "EXTEND_API_KEY": "xt_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The Extend tools will appear.

> **Note:** Claude Desktop does not automatically send local files to MCP tools. When asking Claude to process a document, reference the full file path explicitly — e.g. *"Extract data from `/Users/me/Documents/invoice.pdf`"*.

<details>
<summary>Alternative: run from a local clone</summary>

```bash
git clone https://github.com/extend-hq/extend-mcp.git
cd extend-mcp
npm install  # builds automatically
```

```json
{
  "mcpServers": {
    "extend": {
      "command": "node",
      "args": ["/absolute/path/to/extend-mcp/build/index.js"],
      "env": {
        "EXTEND_API_KEY": "xt_your_key_here"
      }
    }
  }
}
```

</details>

## Cursor

[Install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=extend&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdpdGh1YjpleHRlbmQtaHEvZXh0ZW5kLW1jcCJdLCJlbnYiOnsiRVhURU5EX0FQSV9LRVkiOiJ4dF95b3VyX2tleV9oZXJlIn19)

Or add to `.cursor/mcp.json` in your project root manually:

```json
{
  "mcpServers": {
    "extend": {
      "command": "npx",
      "args": ["-y", "github:extend-hq/extend-mcp"],
      "env": {
        "EXTEND_API_KEY": "xt_your_key_here"
      }
    }
  }
}
```

Restart Cursor. The Extend tools will be available in Agent mode.

> **Note:** When asking Cursor to process a local file, reference the full file path explicitly — e.g. *"Extract data from `/Users/me/Documents/invoice.pdf`"*.

## Claude Code

```bash
claude mcp add --transport stdio --env EXTEND_API_KEY=xt_your_key_here extend -- npx -y github:extend-hq/extend-mcp
```

The Extend tools will be available in your next conversation.

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `EXTEND_API_KEY` | Yes | — | Your Extend API key |
| `EXTEND_ENVIRONMENT` | No | `us` | API region: `us`, `us2` (HIPAA), or `eu` |
| `EXTEND_TOOLS` | No | `all` | Comma-separated tool groups to enable (see below) |
| `EXTEND_DISABLE_FILE_PATH` | No | — | Set to disable `file_path` params and `upload_file` (for remote deployments) |

### Filtering tools

By default all tool groups are enabled. Set `EXTEND_TOOLS` to a comma-separated list to only register the ones you need:

```json
{
  "env": {
    "EXTEND_API_KEY": "xt_...",
    "EXTEND_TOOLS": "parse,extract"
  }
}
```

Available groups:

| Group | Tools |
|---|---|
| `parse` | `parse_document` |
| `extract` | `extract_data`, `list_extractors`, `get_extractor` |
| `classify` | `classify_document`, `list_classifiers`, `get_classifier` |
| `split` | `split_document`, `list_splitters`, `get_splitter` |
| `edit` | `edit_document` |
| `files` | `upload_file`, `list_files`, `get_file` |

## Tools

### Document processing

Every document processing tool accepts a file via one of:
- `file_path` — local file path (uploaded to Extend automatically; disabled when `EXTEND_DISABLE_FILE_PATH` is set)
- `file_url` — public URL
- `file_id` — existing Extend file ID

**parse_document** — Parse a document into structured markdown chunks.

**extract_data** — Extract structured data using a pre-configured extractor (`extractor_id`) or an inline JSON schema (`config`).

**classify_document** — Classify a document using a pre-configured classifier (`classifier_id`) or inline type definitions (`config`).

**split_document** — Split a multi-document file using a pre-configured splitter (`splitter_id`) or inline config.

**edit_document** — Fill PDF form fields using natural language `instructions` or explicit field values via `config`.

### Configuration discovery

**list_extractors** / **get_extractor** — Browse and inspect extractors.

**list_classifiers** / **get_classifier** — Browse and inspect classifiers.

**list_splitters** / **get_splitter** — Browse and inspect splitters.

### File management

**upload_file** — Upload a local file to Extend, returns a file ID.

**list_files** — List files in your Extend account.

**get_file** — Get file details and metadata.

## License

MIT
