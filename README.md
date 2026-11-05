# Devin Session Exporter

A VS Code / Devin Desktop extension that scans local Devin ACP session databases and exports
conversations to **Markdown, JSON, or self-contained HTML**.

Fork of [marktwainme/devin-session-exporter](https://github.com/marktwainme/devin-session-exporter),
translated to English and extended with macOS/Linux support, live WAL reads, and a redesigned
responsive HTML export.

## Features

### Sidebar panel (bottom panel)
* **Devin Sessions**: session list (title, message counts, relative time), sorted by modification
  time. Hover for ID, path, and first-message preview. Inline export/preview buttons, right-click
  to copy the session ID or reveal the database file, Ctrl/Cmd multi-select for batch export.
* **Actions & Settings**: scan & export, export all, search messages, open export folder, plus
  toggles for message types, output formats, and display options.

### Export
* Picker: multi-select with live filtering (title/ID/path), sort toggle, select-all button.
  Untitled sessions fall back to the first user message.
* Formats: Markdown, JSON, and a self-contained responsive HTML page (rail layout, dark-mode aware,
  print-friendly, collapsible tool calls and thoughts).
* Message types: `user_message` / `agent_message` / `tool_call` on by default; `agent_thought`
  and unrecognized kinds optional.
* Reads the live database via `node:sqlite` — **unflushed WAL data is included**, so exports of
  active sessions contain the newest messages.
* Configurable: filename template (`{sessionId}`, `{date}`, `{index}`, `{name}`), role display
  names, export directory, database directory.
* After export: auto-opens single-session exports, "Reveal in Finder", and a persistent log in the
  **Devin Session Exporter** output channel.

### Search
`Devin Export: Search Messages` — live full-text search across all sessions (debounced, streamed,
150-result cap). Check results to export the matching sessions.

### Preview
`Devin Export: Preview Session` — in-app webview preview using the same renderer as the HTML export.

## Install

Build a `.vsix` and install it:

```bash
npm install
npm run compile
npx vsce package
devin-desktop --install-extension devin-session-exporter-<version>.vsix
# or in VS Code: Extensions view → "..." → Install from VSIX
```

## Usage

1. `Cmd+Shift+P` → **Devin Export: Scan Sessions and Export**
2. Pick sessions → files land in `~/Documents/Devin-Exports` (configurable)
3. Or use the **Devin Sessions** panel (bottom panel, ⌘J) for the full session list

## How it works

* Devin Desktop stores sessions as SQLite databases at:
  * macOS: `~/Library/Application Support/Devin/User/acp-messages/*.db`
  * Windows: `%APPDATA%\Devin\User\acp-messages\*.db`
  * Linux: `~/.config/Devin/User/acp-messages/*.db`
* Schema: `messages(position, kind, payload)` where payload is ACP JSON; titles come from the
  meta table, falling back to the first user message.
* Only explicit `type:"text"` content blocks are extracted — tool `rawInput`, command arguments,
  and other metadata are not exported.
* User chunks sharing a `clientMessageId` are merged; assistant chunks stay separate.

## Development

```bash
npm install
npm run compile   # tsc → out/
npm run watch     # tsc --watch
```

Press `F5` in VS Code to launch an Extension Development Host.

## License

MIT
