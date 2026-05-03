/**
 * pi-tool-search — hide all tools behind a manifest-aware tool_search.
 *
 * The LLM sees a single tool whose description embeds a compact name+one-liner
 * manifest of every available tool. It calls tool_search with the names it
 * needs; those tools become active for the rest of the session.
 *
 * Design:
 *  - session_start       → snapshot all tools, seed unlocked set with core tools
 *  - turn_start          → rebuild manifest before every LLM call, re-register tool_search, setActiveTools
 *  - tool_search.execute → validate names, add to unlocked set, call setActiveTools, queue hidden retry hint
 *
 *  "toolSearch": { "alwaysEnabled": ["lsp", "grep"], "showToolSearchFooterStatus": true, "showStartupNotification": true }
 *  Set "showToolSearchFooterStatus": false to hide the tool-search footer status line.
 *  Set "showStartupNotification": false to hide the startup notification; omitted follows quietStartup.
 */

import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CORE_TOOLS = ["read", "write", "edit", "bash", "grep", "find"];

interface UserConfig {
  alwaysEnabled: string[];
  showToolSearchFooterStatus: boolean;
  showStartupNotification: boolean;
}

function getToolSearchSettings(settings: unknown): Record<string, unknown> {
  if (typeof settings !== "object" || settings === null) {
    return {};
  }

  const value = (settings as Record<string, unknown>).toolSearch;
  if (typeof value !== "object" || value === null) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readUserConfig(cwd = process.cwd()): UserConfig {
  try {
    const manager = SettingsManager.create(cwd, getAgentDir());
    const globalSettings = manager.getGlobalSettings();
    const projectSettings = manager.getProjectSettings();
    const s = {
      ...getToolSearchSettings(globalSettings),
      ...getToolSearchSettings(projectSettings),
    };

    const quietStartup = manager.getQuietStartup();
    const showStartupNotification = typeof s.showStartupNotification === "boolean"
      ? s.showStartupNotification
      : quietStartup === false;

    return {
      alwaysEnabled: Array.isArray(s.alwaysEnabled)
        ? s.alwaysEnabled.filter((n: unknown): n is string => typeof n === "string")
        : [],
      showToolSearchFooterStatus: s.showToolSearchFooterStatus !== false && s.showFooterStatus !== false && s.showStatus !== false,
      showStartupNotification,
    };
  } catch {}
  return { alwaysEnabled: [], showToolSearchFooterStatus: true, showStartupNotification: true };
}

export default function toolSearchExtension(pi: ExtensionAPI) {
  // Compact snapshot: name + first-sentence description (≤80 chars)
  let manifest: { name: string; blurb: string }[] = [];

  // Names enabled so far this session (persists across turns)
  const unlocked = new Set<string>();

  let showToolSearchFooterStatus = true;

  // ── helpers ────────────────────────────────────────────────────────────────

  function buildManifest() {
    manifest = pi.getAllTools()
      .filter(t => t.name !== "tool_search")
      .map(t => ({
        name: t.name,
        blurb: (t.description ?? "").split(/[.\n]/)[0].trim().slice(0, 80),
      }));
  }

  function buildDescription(): string {
    const active = manifest.filter(t => unlocked.has(t.name));
    const hidden = manifest.filter(t => !unlocked.has(t.name));

    const activeLines = active
      .map(t => `  ${t.name}: ${t.blurb}`)
      .join("\n");
    const hiddenLines = hidden
      .map(t => `  ${t.name}: ${t.blurb}`)
      .join("\n");

    const parts: string[] = [];

    parts.push(`Enable tools by name before calling them. All tools below are hidden until you enable them here.

IMPORTANT: After calling tool_search, STOP and wait for the result. Do NOT call any newly-enabled tool in the same response as tool_search — the tool schema is fixed for the current response, so the call will fail with "Tool not found". Call tool_search alone, then invoke the unlocked tools in your next response.`);

    if (active.length) {
      parts.push(`Already active (do NOT call tool_search for these):\n${activeLines}`);
    }

    if (hidden.length) {
      parts.push(`Available tools (hidden — enable via tool_search):\n${hiddenLines}`);
    }

    parts.push(`Pass one or more exact tool names. After enabling, call those tools directly in a SUBSEQUENT response (not the same one as tool_search).`);

    return parts.join("\n\n");
  }

  function activeToolCount(): number {
    return 1 + manifest.filter(t => unlocked.has(t.name)).length;
  }

  function hiddenToolCount(): number {
    return manifest.filter(t => !unlocked.has(t.name)).length;
  }

  function totalToolCount(): number {
    return manifest.length + 1;
  }

  function refreshActiveTools(ctx?: ExtensionContext) {
    showToolSearchFooterStatus = readUserConfig(ctx?.cwd).showToolSearchFooterStatus;

    buildManifest();
    registerToolSearch();
    pi.setActiveTools(["tool_search", ...unlocked]);

    if (!ctx) return;

    if (showToolSearchFooterStatus) {
      ctx.ui.setStatus("tool-search", `${activeToolCount()} / ${totalToolCount()} tools`);
    } else {
      ctx.ui.setStatus("tool-search", undefined);
    }
  }

  function registerToolSearch() {
    pi.registerTool({
      name: "tool_search",
      label: "Tool Search",
      description: buildDescription(),
      promptSnippet: "Enable hidden tools by name. Call tool_search ALONE, then use unlocked tools in next turn. If same-response call fails, retry next turn.",
      parameters: Type.Object({
        names: Type.Array(Type.String(), {
          description:
            "Exact tool names to enable (from the list in this tool's description)",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const allNames = new Set(manifest.map(t => t.name));
        const valid: string[] = [];
        const invalid: string[] = [];
        const already: string[] = [];

        for (const n of params.names) {
          if (!allNames.has(n)) {
            invalid.push(n);
          } else if (unlocked.has(n)) {
            already.push(n);
          } else {
            valid.push(n);
          }
        }

        valid.forEach(n => unlocked.add(n));
        refreshActiveTools(ctx);

        if (valid.length) {
          pi.sendMessage({
            customType: "tool-search-hint",
            content:
              `tool_search update: ${valid.join(", ")} now active. Continue original task in next turn only if work still unfinished. Do not repeat any tool call that already succeeded. Retry only tool calls that explicitly failed because tool was inactive or not found earlier.`,
            display: false,
            details: { enabled: valid },
          }, {
            deliverAs: ctx.isIdle() ? "followUp" : "steer",
            triggerTurn: true,
          });
        }

        const parts: string[] = [];
        if (valid.length) {
          parts.push(`Enabled: ${valid.join(", ")}`);
        }
        if (already.length) parts.push(`Already active: ${already.join(", ")}`);
        if (invalid.length) parts.push(`Unknown (ignored): ${invalid.join(", ")}`);

        return {
          content: [{ type: "text", text: parts.join("\n") || "Nothing changed." }],
          details: { enabled: valid, alreadyActive: already, unknown: invalid, active: [...unlocked] },
        };
      },
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function shouldNotifyStartup(event: SessionStartEvent, ctx: ExtensionContext, config: UserConfig): boolean {
    return ctx.hasUI === true &&
      event.reason === "startup" &&
      config.showStartupNotification === true &&
      hiddenToolCount() > 0;
  }

  pi.on("session_start", (event, ctx) => {
    unlocked.clear();

    const config = readUserConfig(ctx.cwd);
    showToolSearchFooterStatus = config.showToolSearchFooterStatus;
    for (const name of [...CORE_TOOLS, ...config.alwaysEnabled]) unlocked.add(name);

    refreshActiveTools(ctx);

    if (shouldNotifyStartup(event, ctx, config)) {
      ctx.ui.notify(
        `pi-tool-search: ${hiddenToolCount()} tools hidden behind tool_search`,
        "info",
      );
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    // Re-snapshot before every LLM call, not only fresh user prompts.
    // This keeps unlocked tools active for agent-loop continuations too.
    refreshActiveTools(ctx);
  });

}
