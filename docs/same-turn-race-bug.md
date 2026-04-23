# Same-turn tool activation race — findings

## Bug

When the LLM emits parallel tool calls in a single assistant message — for
example `tool_search(["subagent"])` together with `subagent(...)` — the second
call fails with `Tool subagent not found`.

Live repro (observed in this project, 2026-04-23):

1. Turn A: `tool_search(["subagent"])` → `Enabled: subagent`; `subagent(...)`
   in the same reply → ❌ `Tool not found`.
2. Turn B (agent continuation, no user input): `subagent(...)` → ❌ still not
   found.
3. Turn C (after fresh user message): `subagent(...)` → ✅ works.

## Root cause

Two compounding issues in pi-coding-agent core.

### 1. Tool schema is frozen per provider request

`setActiveTools(["tool_search", ...unlocked])` updates `agent.state.tools`, but
the outgoing LLM request payload (`tools: [...]`) is built **before**
`tool_search` executes. The model that produced the parallel call never saw
`subagent` in its tool schema — it guessed based on `tool_search`'s
description.

### 2. `before_agent_start` only fires on user-initiated turns

The extension's hook that re-applies `setActiveTools` runs once per fresh user
turn. Agentic-loop continuations (model → tool → model → tool…) do **not**
re-trigger it. So even after `tool_search` mutates state in Turn A, the next
LLM call in the same loop still uses the stale schema from Turn A's start.

## What we checked

- `pi-coding-agent/dist/core/agent-session.js:550` —
  `setActiveToolsByName` assigns `this.agent.state.tools = tools`. Pure state
  mutation, no schema re-send.
- `pi-coding-agent/dist/core/agent-session.js:172` — `beforeToolCall` hook
  fires only for resolved tools; unknown names never reach it.
- `pi-coding-agent/dist/core/sdk.js:195` — `onPayload(payload, model)`
  receives the **already-built, provider-specific** request. Tools are baked
  in.
- `ExtensionAPI.getAllTools(): ToolInfo[]` — `ToolInfo = Pick<ToolDefinition,
  "name"|"description"|"parameters"> & { sourceInfo }`. **No `execute`.**
- `ExtensionAPI.on("tool_call", ...)` result type is `{ block?, reason? }` —
  cannot replace the tool result.

## Extension-only fixes considered

| Option | Fixes parallel calls | Fixes mid-loop | Fragile | Viable |
|---|---|---|---|---|
| Prompt mitigation (tell model to call `tool_search` alone) | ❌ | ❌ | — | ✅ shipped |
| `before_provider_request` payload rewrite | ❌ (too late) | ✅ | ✅ yes | ⚠️ |
| Proxy `invoke(tool, args)` tool | ✅ | ✅ | — | ❌ dead |

### Why the proxy `invoke` pattern is dead

`pi.getAllTools()` returns metadata only. The callable `execute()` lives on
`ToolDefinition` / `RegisteredTool`, but no public API returns those. An
extension cannot dispatch another extension's tool programmatically.

### Why `before_provider_request` rewrite is fragile

The hook receives the raw provider payload. To inject unlocked tool schemas
mid-loop you would need per-provider surgery:

- OpenAI: `payload.tools = [{ type: "function", function: { name, description, parameters } }]`
- Anthropic: `payload.tools = [{ name, description, input_schema }]`
- Gemini: `payload.tools = [{ functionDeclarations: [...] }]`
- plus Azure / Copilot / Codex adapters, plus TypeBox → JSON-Schema
  conversion with provider-specific quirks (Gemini's restricted subset, etc.).

Breaks every time a provider is added or its payload shape changes. Duplicates
logic pi-coding-agent already has internally.

It also does **not** fix the parallel-call case — by the time
`before_provider_request` fires, the model has already emitted both calls.

## Current mitigation (shipped)

`extensions/index.ts` updates:

- `tool_search` description explicitly says: "STOP after calling
  tool_search. Do NOT call newly-enabled tools in same response. Tool
  schema is frozen for current response."
- `promptSnippet` reinforces rule.
- Active tools now refresh on every `turn_start`, not only fresh user prompts,
  so unlocked tools stay available during agent-loop continuations.
- Successful `tool_search` queues hidden steer hint telling model to continue
  original task in next turn and retry any same-response failure immediately.

This does not make same-response parallel call succeed, but it removes need for
fresh user message in common recovery path.

## Real fix (upstream)

The structural fix belongs in `pi-coding-agent`:

1. **Re-resolve active tools per batch iteration.** Don't snapshot at batch
   start; look up each tool name when it's about to be dispatched.
2. **Sequential dispatch when a mutating tool is in the batch.** Or always
   sequential — parallel `Promise.all` dispatch races `setActiveTools`.
3. **Re-send schema after mid-loop `setActiveTools`.** Or mark the active-tool
   set as dirty and rebuild payload on next provider request.
4. **Graceful unknown-tool result.** When a dispatched tool name is not in the
   active set, return a structured tool_result (`"tool X not active this
   turn — retry next turn"`) instead of falling through to MCP or throwing.

With (1)+(2) alone, the parallel-call case works. With (3), mid-loop
continuations also work. (4) makes the failure mode recoverable by the model
when it does speculate.

## Recommended action

- Keep prompt mitigation + per-turn refresh + hidden retry hint in
  `extensions/index.ts`.
- Document remaining limitation in README (same-response parallel call with
  `tool_search` can still fail until core is fixed).
- File upstream issue against `pi-coding-agent` referencing this doc.

## File map

| Path | Role |
|---|---|
| `extensions/index.ts` | This extension; prompt mitigation lives here |
| `pi-coding-agent/dist/core/agent-session.js:550` | `setActiveToolsByName` — state-only mutation |
| `pi-coding-agent/dist/core/agent-session.js:172` | `beforeToolCall` hook — only fires for resolved tools |
| `pi-coding-agent/dist/core/sdk.js:195` | `onPayload` — already-built payload; provider-specific |
| `pi-coding-agent/dist/core/extensions/types.d.ts` | `ToolInfo` (metadata only), `ToolCallEventResult` (`{block, reason}`) |
