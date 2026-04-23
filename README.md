# pi-tool-search

Hide all tools behind a manifest-aware `tool_search` gate. The LLM sees a single tool whose description embeds a compact name + one-liner manifest of every available tool. It calls `tool_search` with the names it needs; those tools become active for the rest of the session.

## Why

Full tool schemas are expensive (~500 bytes each). With 50 tools that's ~25KB of schema noise every turn. This extension reduces that to ~4KB — a compact manifest in the `tool_search` description, with schemas only loaded when explicitly unlocked.

## How it works

- **`session_start`** — snapshots all tools into compact manifest, seeds `unlocked` set with core tools
- **`turn_start`** — rebuilds manifest before every LLM call, re-registers `tool_search` with fresh description, re-applies active tools for agent-loop continuations too
- **`tool_search.execute`** — validates names, adds to `unlocked` set, persists across turns, queues hidden steer hint so agent can continue without waiting for another user message

## What the LLM sees

Pi's system prompt includes a lightweight tool index — names and one-liners for every registered tool. This is intentional: the LLM needs to know what tools exist so it can make targeted `tool_search` requests rather than guessing. The index costs ~4KB regardless of tool count; full schemas are never sent until unlocked.

The `tool_search` description itself carries the same manifest, reinforcing which tools are available and how to unlock them:

```
Enable tools by name before calling them. All tools below are hidden until you enable them here.

Available tools:
  read: Read file contents with optional offset/limit
  write: Write content to a file
  bash: Execute a shell command
  grep: Search files with ripgrep
  ...

Pass one or more exact tool names. After enabling, call those tools directly in next turn.
```

## Usage

Install via pi or point `settings.json` to the local path:

```json
{
  "extensions": ["/path/to/pi-tool-search"]
}
```

## Configuration

Add a `toolSearch` block to `settings.json`:

```json
{
  "toolSearch": {
    "alwaysEnabled": ["lsp", "grep", "find"],
    "showStatus": true
  }
}
```

| Key | Default | Description |
|---|---|---|
| `alwaysEnabled` | `[]` | Tool names to pre-unlock beyond the defaults (`read`, `write`, `edit`, `bash`) |
| `showStatus` | `true` | Show `N / total tools` in the footer status bar |

Unknown names in `alwaysEnabled` are silently ignored until they appear in manifest. Read at each `session_start`, so changes take effect on next session without reinstall.

## Same-response activation caveat

If model emits `tool_search(...)` and newly enabled tool in same assistant response, second call can still fail because provider already received old tool schema for that response. Extension now mitigates this by:

- telling model to call `tool_search` alone
- re-applying active tools on every `turn_start`
- queueing hidden steer hint after successful enable so agent can retry in next turn without waiting for another user message

Result: failure no longer needs fresh user message to recover. Retry can happen in immediate next agent turn.
