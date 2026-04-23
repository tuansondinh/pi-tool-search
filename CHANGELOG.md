# Changelog

## 0.3.0

- Renamed from `pi-lazy-tools` to `pi-tool-search`
- Config key changed: `lazyTools` → `toolSearch` in `settings.json`
- `showStatus` config option: show/hide `N / total tools` footer status (default: on)
- Provider-agnostic: removed payload-level filtering, relies solely on `setActiveTools`
- `readUserConfig()` consolidates all settings reads into one call

## 0.2.0

- User config: add `"toolSearch": { "alwaysEnabled": ["lsp", "grep"] }` to `settings.json` to pre-unlock tools beyond the defaults
- Reads config at each `session_start` — no reinstall needed after changes

## 0.1.0

- Initial release
- Manifest-aware `tool_search` gate
- `names: string[]` batch enabling
- Per-turn manifest refresh via `before_agent_start`
