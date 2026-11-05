# MCP errors

How Nawi's MCP endpoint (and the `nawi` CLI, which calls the same endpoint) reports a call it refused or could
not finish. Every tool follows this; `src/main/mcp/tools.contract.test.ts` checks each tool against it and fails
when this page drifts from the code.

## The shape

A refused or failed `tools/call` is a JSON-RPC error on an HTTP 200 response (a 4xx would make transports retry a
deterministic refusal). The typed code is in `error.data.code`; the rest of `data` is machine-readable context
that never contains secrets:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32000,
    "message": "No saved run 20261102T103900123Z-a1b2c3. Call list_runs for the runs that exist.",
    "data": { "code": "NOT_FOUND", "run_id": "20261102T103900123Z-a1b2c3" }
  }
}
```

- `error.code` is `-32000` (implementation-defined) for every tool error: branch on `error.data.code`, not on it.
- `error.message` is a sentence for a person or a model: what was refused and, where there is one, what to do.
- Schema failures are `INVALID_ARGUMENTS` with `data.issues`, one `{ "path": "shapes.0.color", "message": "..." }`
  per problem (`path` is the argument's dotted path).
- A step that fails inside `run_flow` is **not** an error: the run report comes back as a result with status
  `failed`. Errors are for calls that could not run at all.
- A call that succeeds is a `result` with `content` (the value as JSON text), `structuredContent` (the object) and
  `isError: false`.

Outside tool calls:

- A request without the bearer token, or with an `Origin` header, is refused before any method runs: HTTP 401
  (`UNAUTHORIZED`) or 403 (`FORBIDDEN_ORIGIN`), `id` null, the same `data.code`.
- `tools/call` without a string `name` is `-32602` (invalid params) with no `data.code`.
- Prompts (`prompts/get`): an unknown prompt or a bad argument is `-32602` with `data.code` `NOT_FOUND` or
  `INVALID_ARGUMENTS`.
- Resources (`resources/read`): a run or file that doesn't exist is `-32002` (`NOT_FOUND`), a URI that isn't one of
  Nawi's `-32602` (`INVALID_ARGUMENTS`); other failures `-32000`.

## Codes

<!-- generated:codes -->
| `data.code` | Who can return it | Meaning |
|---|---|---|
| `AGENT_ACCESS_PAUSED` | any tool | Agent access is paused in Nawi (the kill switch). Nothing was read, run or created. |
| `UNAUTHORIZED` | any tool | No bearer token, or not the one in userData/mcp.json. |
| `FORBIDDEN_ORIGIN` | any tool | The request carried an Origin header (a web page); only local, non-browser clients are served. |
| `INVALID_ARGUMENTS` | any tool | The arguments failed the tool's input schema (`data.issues`: `path` + `message` each), or a value the schema cannot judge was refused (an empty region, a path outside your home, a flow that does not parse). |
| `UNKNOWN_TOOL` | a call naming no tool | No tool by that name (`data.tool`). |
| `NOT_FOUND` | declared | The capture, run, flow file or display named in the arguments does not exist. |
| `NO_BROWSER_ATTACHED` | declared | The tool needs a browser attached over CDP and none is. |
| `NOT_IMPLEMENTED` | declared | This build cannot do that yet (a listed tool such as `redact`, with `data.tool`; or a desktop-target flow). Nothing was changed. |
| `UNAVAILABLE` | declared | The target exists but cannot serve this call (no state layer, no input events, a browser that cannot be used). |
| `INTERNAL` | any tool | An unexpected failure inside Nawi. The message says what failed; retrying may help. |
<!-- /generated -->

## Per tool

Every call to a tool can end with the "any tool" codes, because the dispatch layer checks the token, the origin, the kill
switch, the tool name and the arguments before a tool body runs. On top of those, a tool can return only the codes
it declares (`errors` in `src/main/mcp/tools.ts`). `tools/list` publishes the full list for each tool under
`_meta["nawi/errors"]`, so a client can learn it without reading this page:

<!-- generated:tools -->
| Tool | Its own codes (on top of the dispatch codes) |
|---|---|
| `capture_screen` | `NOT_FOUND` |
| `capture_region` | `NOT_FOUND` |
| `capture_element` | `NO_BROWSER_ATTACHED` |
| `start_recording` | `NOT_IMPLEMENTED` |
| `stop_recording` | `NOT_IMPLEMENTED` |
| `get_capture` | `NOT_FOUND` |
| `get_state_layer` | `NOT_FOUND`, `UNAVAILABLE` |
| `list_captures` | (none) |
| `search_captures` | (none) |
| `annotate` | `NOT_FOUND` |
| `redact` | `NOT_FOUND`, `NOT_IMPLEMENTED` |
| `export_guide` | `NOT_FOUND`, `NOT_IMPLEMENTED` |
| `export_flow` | `NOT_FOUND`, `UNAVAILABLE` |
| `run_flow` | `NOT_FOUND`, `NOT_IMPLEMENTED`, `UNAVAILABLE` |
| `list_runs` | (none) |
| `get_run` | `NOT_FOUND` |
| `inspect_apk` | `NOT_FOUND`, `NOT_IMPLEMENTED` |
| `mobile_doctor` | `NOT_FOUND`, `NOT_IMPLEMENTED` |
| `mobile_open` | `NOT_FOUND`, `NOT_IMPLEMENTED` |
| `mobile_study` | (none) |
<!-- /generated -->

## Adding a tool or a code

- A new tool declares `errors: [...]` (use `[]` when its body adds none). The contract test compares that list with
  the codes its body raises (`new ToolError('X')`, directly or through the helpers it calls, such as `requireItem`
  or `runFlowFile`) in both directions, and drives every tool through the token, origin,
  kill-switch and schema checks over the real server.
- A new code goes in `ToolErrorCode` and `TOOL_ERROR_MEANINGS` (`src/main/mcp/errors.ts`). The tables above are
  generated from the code: `UPDATE_MCP_ERRORS_DOC=1 npx vitest run src/main/mcp/tools.contract.test.ts` rewrites
  them, and the test fails while they differ.
- A module other than those the test knows that starts throwing `ToolError` fails the test until it is listed
  there with the call that reaches it.
