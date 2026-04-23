/**
 * pi-tool-search — hide all tools behind a manifest-aware tool_search.
 *
 * The LLM sees a single tool whose description embeds a compact name+one-liner
 * manifest of every available tool. It calls tool_search with the names it
 * needs; those tools become active for the rest of the session.
 *
 * Design:
 *  - session_start       → snapshot all tools, seed unlocked set with core tools
 *  - before_agent_start  → rebuild manifest, re-register tool_search, setActiveTools
 *  - tool_search.execute → validate names, add to unlocked set, call setActiveTools
 *
 * User config (settings.json):
 *  "toolSearch": { "alwaysEnabled": ["lsp", "grep"], "showStatus": true }
 */

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "fs";
import { join } from "path";

const CORE_TOOLS = ["read", "write", "edit", "bash"];

interface UserConfig {
  alwaysEnabled: string[];
  showStatus: boolean;
}

function readUserConfig(): UserConfig {
  try {
    const raw = readFileSync(join(getAgentDir(), "settings.json"), "utf-8");
    const s = JSON.parse(raw)?.toolSearch ?? {};
    return {
      alwaysEnabled: Array.isArray(s.alwaysEnabled)
        ? s.alwaysEnabled.filter((n: unknown): n is string => typeof n === "string")
        : [],
      showStatus: s.showStatus !== false,
    };
  } catch {}
  return { alwaysEnabled: [], showStatus: true };
}

export default function toolSearchExtension(pi: ExtensionAPI) {
  // Compact snapshot: name + first-sentence description (≤80 chars)
  let manifest: { name: string; blurb: string }[] = [];

  // Names enabled so far this session (persists across turns)
  const unlocked = new Set<string>();

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
    const lines = manifest
      .map(t => `  ${t.name}: ${t.blurb}`)
      .join("\n");

    return (
      `Enable tools by name before calling them. ` +
      `All tools below are hidden until you enable them here.\n\n` +
      `Available tools:\n${lines}\n\n` +
      `Pass one or more exact tool names. ` +
      `After enabling, call those tools directly.`
    );
  }

  function registerToolSearch() {
    pi.registerTool({
      name: "tool_search",
      label: "Tool Search",
      description: buildDescription(),
      promptSnippet: "Enable hidden tools by name before using them",
      parameters: Type.Object({
        names: Type.Array(Type.String(), {
          description:
            "Exact tool names to enable (from the list in this tool's description)",
        }),
      }),
      async execute(_toolCallId, params) {
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
        pi.setActiveTools(["tool_search", ...unlocked]);

        const parts: string[] = [];
        if (valid.length)   parts.push(`Enabled: ${valid.join(", ")}`);
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

  let showStatus = true;

  pi.on("session_start", (_event, ctx) => {
    unlocked.clear();

    const config = readUserConfig();
    showStatus = config.showStatus;
    for (const name of [...CORE_TOOLS, ...config.alwaysEnabled]) unlocked.add(name);

    buildManifest();
    registerToolSearch();
    pi.setActiveTools(["tool_search", ...unlocked]);

    ctx.ui.notify(
      `pi-tool-search: ${manifest.length} tools hidden behind tool_search`,
      "info",
    );
  });

  pi.on("before_agent_start", (_event, ctx) => {
    // Re-snapshot in case other extensions registered tools after session_start
    buildManifest();
    registerToolSearch(); // replaces previous registration (same name)

    // Re-apply active set so any newly registered unlocked tools stay active
    pi.setActiveTools(["tool_search", ...unlocked]);

    if (showStatus) {
      ctx.ui.setStatus("tool-search", `${unlocked.size} / ${manifest.length + 1} tools`);
    }
  });

}
