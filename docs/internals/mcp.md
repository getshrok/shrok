# MCP

MCP (Model Context Protocol) is how Shrok connects to external tool servers. Any process that speaks MCP — a local CLI, a remote HTTP service, a third-party integration — can expose tools to Shrok's agents without any code changes on Shrok's side.

The integration lives in `src/mcp/registry.ts` and `src/sub-agents/mcp-stdio.ts`. Configuration is a plain JSON file, `mcp.json`, at the path set by `mcpConfigPath` in config (default `./mcp.json`). If the file doesn't exist, Shrok starts without error and no MCP tools are loaded.

## mcp.json format

Each key is a **capability name** — the namespace that prefixes every tool from that server. Each value describes how to reach the server:

```json
{
  "email": {
    "command": "npx @my-org/mcp-email-server"
  },
  "search": {
    "command": "python -m mcp_search_server",
    "env": { "SEARCH_API_KEY": "sk-..." }
  },
  "analytics": {
    "url": "http://localhost:4100"
  }
}
```

Two transports are supported:

| Field | Transport |
|-------|-----------|
| `command` | stdio — Shrok spawns the process |
| `url` | HTTP — Shrok calls the endpoint |

`env` is optional and only applies to stdio entries. The provided keys are merged on top of `process.env` before spawning.

## How the registry works

`McpRegistryImpl.fromFile(filePath, timeoutMs?)` reads and Zod-validates `mcp.json`. It returns an empty registry (no error) if the file is absent.

Tools are loaded lazily, one capability at a time, via `loadTools(capability)`. This returns `AgentToolEntry[]` — the same shape as any other tool available to an agent:

```ts
{
  definition: ToolDefinition,   // name, description, inputSchema (JSON Schema)
  execute: (input, ctx) => Promise<string>
}
```

Tool names are prefixed with the capability name: a tool called `send_email` in the `email` capability becomes `email__send_email`. Agents call it by that full name and Shrok routes the execution to the right server.

## stdio transport

For `command` entries, Shrok spawns the subprocess and communicates over stdin/stdout using the `@modelcontextprotocol/sdk` client:

1. `parseStdioCommand(commandStr, env?)` splits the command string on whitespace into `[command, ...args]` and merges env vars.
2. A `StdioClientTransport` is created and connected to the subprocess.
3. `client.listTools()` fetches the tool schema list.
4. `client.callTool({ name, arguments })` executes a specific tool.

Every async step — connect, listTools, callTool — is wrapped in `withTimeout()` using `mcpTimeoutMs` (default 30 s). The subprocess is cleaned up after each operation (the registry creates a fresh connection per call rather than holding a long-lived process).

## HTTP transport

For `url` entries, Shrok sends JSON-RPC 2.0 requests over plain HTTP.

**List tools:**
```
POST <url>
{ "jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 1 }
```

**Call a tool:**
```
POST <url>
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": { "name": "tool_name", "arguments": { ... } },
  "id": 1
}
```

The response `result.content` is an array of `{ type: "text", text: "..." }` items; Shrok concatenates them into a single string returned to the agent. If the response contains an `error` field, it's re-thrown as an exception. Non-2xx HTTP status codes throw immediately.

## How tools surface to agents

When an agent is assembled, the tool loader asks the registry for tools from each configured capability. Each `AgentToolEntry.execute` is a closure that knows which capability and server to call. From the agent's perspective these tools are indistinguishable from built-in ones — they appear in the tool schema list passed to the model and are invoked through the same tool-call loop.

## Dashboard

The dashboard exposes `GET /api/mcp/capabilities` and per-capability tool listings via `src/dashboard/routes/mcp.ts`. This is read-only; the registry is not reconfigured at runtime.

## Debugging

- Errors during `loadTools` are surfaced as warnings; the capability is skipped rather than crashing startup.
- Tool call errors are returned to the agent as error text rather than thrown, so the agent can decide how to proceed.
- The `mcpTimeoutMs` config field controls all timeouts (connect, listTools, callTool).

## Related docs

- [architecture.md](./architecture.md) — where tool execution sits in the agent loop
- [channel-integrations.md](./channel-integrations.md) — how messages arrive before reaching agents
