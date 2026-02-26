# Windsurf MCP Server

## Overview

This repository includes a standalone MCP server at `src/mcp_server.ts` that exposes the existing Windsurf HTTP API (`http://localhost:47923` by default) as MCP tools and resources.

It supports:
- `stdio` transport (default)
- `sse` transport

## What Was Implemented

### File Added
- `src/mcp_server.ts`

### Package Updates
- Added dependency: `@modelcontextprotocol/sdk`
- Added dependency: `zod`
- Added script: `build:mcp`
- Added bin entry: `windsurf-mcp -> ./out/mcp-server.js`

### MCP Tools

1. `windsurf_prompt`
- Sends a prompt to `POST /prompt`
- Optional polling behavior when `wait=true` (default), using `GET /response`
- Supports: `text`, `images`, `model`, `mode`, `cascadeId`, `wait`

2. `windsurf_chat_completion`
- Proxies `POST /api/v1/chat/completions`
- Supports: `messages`, `model`, `mode`

3. `windsurf_get_response`
- Proxies `GET /response`
- Supports: `cascadeId` or `messageId` (at least one required)

4. `windsurf_get_status`
- Proxies `GET /status`
- Supports: `cascadeId`

### MCP Resources

- `windsurf://health` -> `GET /health`
- `windsurf://models` -> `GET /models`
- `windsurf://models/details` -> `GET /models?details=1`
- `windsurf://trajectories` -> `GET /trajectories`
- `windsurf://queue` -> `GET /queue`
- `windsurf://queue/{messageId}` -> `GET /queue/:messageId`

## Build

```bash
pnpm install
pnpm run build:mcp
```

Build output:
- `out/mcp-server.js`

## Usage

### Prerequisite
Start the Windsurf API HTTP server first (inside Windsurf extension), typically on port `47923`.

### Stdio (default)

```bash
node out/mcp-server.js
```

Custom Windsurf HTTP URL:

```bash
node out/mcp-server.js --url http://localhost:47923
```

### SSE transport

```bash
node out/mcp-server.js --transport sse --port 3001
```

SSE endpoint:
- `GET /sse`

Message endpoint:
- `POST /messages?sessionId=<id>`

### CLI Arguments

- `--url` (default: `http://localhost:47923`)
- `--transport` (`stdio` or `sse`, default: `stdio`)
- `--port` (default: `3001`, SSE only)

## Validation

### 1. Verify Windsurf HTTP API is reachable

```bash
curl -fsS http://localhost:47923/health
```

Expected: JSON response with `status`.

### 2. Build MCP server

```bash
pnpm run build:mcp
```

Expected: `out/mcp-server.js` generated without build errors.

### 3. Validate with MCP Inspector (stdio)

```bash
npx @modelcontextprotocol/inspector node out/mcp-server.js
```

Use Inspector to:
- list available tools
- list resources
- invoke `windsurf_prompt` with a test message
- read `windsurf://health`

### 4. Optional SSE validation

Run server:

```bash
node out/mcp-server.js --transport sse --port 3001
```

Then connect an SSE-capable MCP client to:
- `http://localhost:3001/sse`

## Example MCP Client Config

```json
{
  "mcpServers": {
    "windsurf": {
      "command": "node",
      "args": ["/absolute/path/to/windsurf-api/out/mcp-server.js"]
    }
  }
}
```

## Error Behavior

- If Windsurf HTTP API is unavailable, tools return an error indicating the configured base URL is unreachable.
- HTTP endpoint errors are surfaced back through MCP tool errors with the original message when available.

## Notes

- This MCP server depends on the existing Windsurf extension HTTP server and does not replace it.
- Polling timeout for `windsurf_prompt` (`wait=true`) is 5 minutes with 1-second polling intervals.
