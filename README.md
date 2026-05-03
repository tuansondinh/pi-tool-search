# pi-tool-search

Hide non-core tools behind a manifest-aware `tool_search` gate. Core tools stay enabled by default; everything else can be unlocked on demand. Purpose: reduce prompt context / token usage by avoiding full tool schemas for rarely used tools.

## Why

Full tool schemas are expensive (~500 bytes each). With 50 tools that's ~25KB of schema noise every turn. Purpose of this extension is to reduce prompt context / token usage: keep core tools active, replace rest with compact manifest in `tool_search`, and only load full schemas when explicitly unlocked.

## How it works

- **`session_start`** — snapshots all tools into compact manifest, seeds `unlocked` set with core tools enabled by default (`read`, `write`, `edit`, `bash`, `grep`, `find`)
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

## Install

```bash
pi install npm:pi-tool-search
```

Or configure manually in `settings.json`:

```json
{
  "extensions": ["/path/to/pi-tool-search"]
}
```

## Usage

Once installed, all tools except core defaults (`read`, `write`, `edit`, `bash`, `grep`, `find`) are hidden behind `tool_search`. Call `tool_search` with tool names to unlock them on demand.

## Configuration

Add a `toolSearch` block to `settings.json`:

```json
{
  "toolSearch": {
    "alwaysEnabled": ["lsp", "grep", "find"],
    "showToolSearchFooterStatus": true,
    "showStartupNotification": true
  }
}
```

| Key | Default | Description |
|---|---|---|
| `alwaysEnabled` | `[]` | Tool names to pre-unlock beyond default core tools (`read`, `write`, `edit`, `bash`, `grep`, `find`) |
| `showToolSearchFooterStatus` | `true` | Show tool-search `N / total tools` in the footer status bar |
| `showStartupNotification` | follows `quietStartup` | Show the `tools hidden behind tool_search` startup notification. Set `false` to always hide or `true` to always show |

Unknown names in `alwaysEnabled` are silently ignored until they appear in manifest. `alwaysEnabled` is read at each `session_start`, so changes take effect on next session without reinstall. `showToolSearchFooterStatus` is re-read on refresh; set it to `false` to clear/hide the tool-search footer status. `showStartupNotification` is read on session start and defaults to hidden when Pi's `quietStartup` is enabled.

## Same-response activation caveat

If model emits `tool_search(...)` and newly enabled tool in same assistant response, second call can still fail because provider already received old tool schema for that response. Extension now mitigates this by:

- telling model to call `tool_search` alone
- re-applying active tools on every `turn_start`
- queueing hidden steer hint after successful enable so agent can retry in next turn without waiting for another user message

Result: failure no longer needs fresh user message to recover. Retry can happen in immediate next agent turn.
