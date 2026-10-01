# Penpot Headless MCP

An unofficial MCP server that reads and edits Penpot through its backend API.
It does not need an open browser, an active tab, or a Penpot plugin.

```text
MCP client -- stdio --> this server -- HTTP + personal access token --> Penpot backend
```

The server uses explicit file and page IDs. It reads back each page or shape change
to check that Penpot stored it. The integration tests use Penpot's backend,
PostgreSQL, and Valkey only. No frontend, exporter, or browser runs in that stack.

## Status and supported operations

Version 0.1.0 supports basic document editing. Tested against **Penpot 2.18.0**.
Penpot Cloud and other server versions have not been verified. The server uses
Penpot's internal RPC API, so compatibility must be checked after an upgrade.

| Tools | Operations |
| --- | --- |
| `get_profile`, `list_teams`, `list_projects`, `list_files` | Check authentication and find files |
| `get_file`, `get_page`, `get_shapes` | Read metadata, revisions, pages, and complete shape data |
| `get_assets` | Read local component, color, typography, media, and token data |
| `create_file`, `create_page`, `rename_page` | Create files and pages; rename pages |
| `create_shapes` | Create rectangles, ellipses, frames, and fixed-size text |
| `update_shapes` | Change names, fills, opacity, corner radii, visibility, text, and simple geometry |
| `delete_shapes` | Delete shapes and their descendants |

Shape creation and updates accept batches. New shapes can use an existing frame
or a frame created earlier in the same batch as their parent. Coordinates are
absolute page coordinates, including for children of a frame. Text supports
Unicode and multiple lines. Supply explicit text bounds; this server does not
measure fonts.

This is not a replacement for every Plugin API operation. It does not execute
plugin JavaScript, calculate automatic layouts, synchronize component instances,
render previews, or export images. Read operations can inspect those designs, but
write operations reject component instances and automatic layouts. Geometry edits
also reject rotated shapes, populated containers, and children of groups.
Text replacement uses the first span's style and removes mixed formatting.
External library resolution and token writes are not implemented.

## Setup

Requirements: Node.js 22 or later, a Penpot instance, and a **personal access token**
from Penpot account settings. Use HTTPS except for a local test instance. The key
from Penpot's official MCP integration is a different credential and does not work
with this server. After token creation, no browser session is needed.

```sh
git clone https://github.com/rafazafar/penpot-headless-mcp.git
cd penpot-headless-mcp
npm ci
npm run build
cp .env.example .env
```

Set `PENPOT_URL` and `PENPOT_ACCESS_TOKEN` in `.env`. The file is ignored by Git.
Use the Penpot instance's base URL, not an MCP URL or an `/api` URL.

```sh
node --env-file=.env dist/index.js
```

The process waits for MCP messages on standard input. It does not print an
interactive prompt. Standard output is reserved for MCP messages.

Configure your MCP client to launch the compiled server. A common JSON format is:

```json
{
  "mcpServers": {
    "penpot-headless": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/penpot-headless-mcp/.env",
        "/absolute/path/to/penpot-headless-mcp/dist/index.js"
      ]
    }
  }
}
```

Use an absolute Node executable path if your MCP client cannot find `node`.
You can also pass the variables through the client's environment configuration.
The server does not read `.env` automatically; `--env-file` makes Node read it.

| Variable | Requirement or default |
| --- | --- |
| `PENPOT_URL` | Required instance base URL |
| `PENPOT_ACCESS_TOKEN` | Required personal access token |
| `PENPOT_READ_ONLY` | `false`; set to `true` to remove write tools |
| `PENPOT_TIMEOUT_MS` | `30000`; allowed range: 100–300000 |

The token's Penpot permissions apply to every request. Tokens are not accepted as
tool arguments, included in tool results, or written to logs. This server exposes
stdio only; it does not start an HTTP listener.

## First use

Ask your MCP client:

> Check my Penpot connection. List my projects and files. Read the pages in the file I select.

Then use a test file:

> Create a file named Headless test in this project. Add a 320 by 240 board,
> a pink rectangle with 8-pixel corners, and a fixed-size text title. Read back
> the shapes and report the stored values.

Each write to an existing file needs `expectedRevision` and `expectedVersion`
from a recent `get_file`, `get_page`, or `get_shapes` result. For example, after
reading revision 0 and version 0:

```json
{
  "fileId": "<file UUID>",
  "pageId": "<page UUID>",
  "expectedRevision": 0,
  "expectedVersion": 0,
  "shapes": [
    {
      "type": "rect",
      "name": "Button",
      "x": 20,
      "y": 20,
      "width": 160,
      "height": 40,
      "fill": "#EE648A",
      "radius": 8
    }
  ]
}
```

Call `create_shapes` with these arguments. Use UUIDs returned by the read tools.
For repeatable creation requests, supply each new shape's `id`; the server rejects
duplicate IDs instead of silently adding another shape.

## Write results and concurrent edits

An accepted change returns `status: "applied"`, the new `revision` and `version`,
and `verification: "passed"` if the read-back check succeeds. A mismatch means
the stored result differs from the requested result. `verification: "read_failed"`
means Penpot accepted the write but the subsequent read failed. Inspect the file
before proceeding in either case.

The server serializes its own writes to each file and rejects stale revisions
before sending a write. **This is not an atomic compare-and-swap.** Penpot can
accept stale revisions. Another client can write between the check and the update.
`concurrentChangesDetected` reports unexpected revision or version movement during
the read-back check. Avoid simultaneous edits to the same file.

Writes are never retried automatically. On a timeout, connection failure, or
server error, a tool can report `outcome: "unknown"`. The backend may have stored
the change. Read the file before any retry. When available, the error includes
the affected IDs. Failed parameter or permission checks report `not_applied`.

## Development and verification

```sh
npm run check
npm run build
npm run test:integration
```

The integration command requires Docker Compose. It starts a disposable Penpot
2.18.0 backend on `127.0.0.1:19061`, creates test users through HTTP, and tests the
compiled MCP server over stdio. It checks reads, batches, text and geometry edits,
deletion, stale revisions, access control, and persistence across MCP restarts.
It removes its containers and test data on completion. Port 19061 must be free;
the Compose project name `penpot-headless-mcp-test` is reserved for these tests.

These tests prove backend persistence for the supported operations. They do not
prove visual rendering, font availability, or full editor parity.

## Implementation references

The implementation targets Penpot's personal access token mechanism
and the JSON forms of its RPC schemas:

- [Access tokens](https://help.penpot.app/technical-guide/integration/#access-tokens)
- [File reads in Penpot 2.18.0](https://github.com/penpot/penpot/blob/2.18.0/backend/src/app/rpc/commands/files.clj)
- [File updates](https://github.com/penpot/penpot/blob/2.18.0/backend/src/app/rpc/commands/files_update.clj)
- [Change operations](https://github.com/penpot/penpot/blob/2.18.0/common/src/app/common/files/changes.cljc)
- [Shape schemas](https://github.com/penpot/penpot/blob/2.18.0/common/src/app/common/types/shape.cljc)

The official Penpot MCP uses the Plugin API. This project is separate and is not
affiliated with the Penpot team.
