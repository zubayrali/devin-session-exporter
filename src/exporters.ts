import * as fs from "node:fs";
import * as path from "node:path";
import { marked } from "marked";
import { ExportMessage, ExportOptions, SessionInfo } from "./types";

marked.setOptions({ gfm: true, breaks: false });

function safeFilename(input: string): string {
  const cleaned = input.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim();
  return (cleaned || "devin-session").slice(0, 160);
}

function selected(messages: ExportMessage[], options: ExportOptions): ExportMessage[] {
  return messages.filter(m => {
    if (m.role === "user") return options.includeUser;
    if (m.role === "assistant") return options.includeAssistant;
    if (m.role === "thought") return options.includeThoughts;
    if (m.role === "tool") return options.includeToolCalls;
    return options.includeUnknown;
  });
}

function mergeAdjacent(messages: ExportMessage[]): ExportMessage[] {
  const out: ExportMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    // Only coalesce user chunks sharing the same clientMessageId. Agent chunks are
    // kept separate to avoid merging distinct assistant replies within one turn.
    if (msg.role === "user" && prev?.role === "user" &&
        msg.clientMessageId && msg.clientMessageId === prev.clientMessageId) {
      prev.text += msg.text;
      if (!prev.timestamp && msg.timestamp) prev.timestamp = msg.timestamp;
      prev.position = Math.min(prev.position, msg.position);
    } else {
      out.push({ ...msg });
    }
  }
  return out;
}

/** Filter by enabled roles and coalesce user chunks — the exact set that gets exported. */
export function prepareMessages(messages: ExportMessage[], options: ExportOptions): ExportMessage[] {
  return mergeAdjacent(selected(messages, options));
}

export function roleLabel(m: ExportMessage, options: ExportOptions): string {
  return m.role === "user" ? options.userLabel :
    m.role === "assistant" ? options.assistantLabel :
    m.role === "thought" ? "Agent Thought" :
    m.role === "tool" ? "Tool Call" : `Other (${m.kind})`;
}

function messageBody(m: ExportMessage): string {
  const text = m.text.trim();
  if (text) return m.text;
  return m.raw !== undefined ? JSON.stringify(m.raw, null, 2) : "";
}

function renderMarkdown(session: SessionInfo, messages: ExportMessage[], options: ExportOptions): string {
  const lines = [`# ${session.title || session.id}`, ""];
  if (options.showSessionInfo) {
    lines.push(`- Session ID: \`${session.id}\``, `- Messages: ${messages.length}`, "");
  }
  for (const m of messages) {
    const body = messageBody(m) || "_(no extractable text)_";
    // Tool calls, thoughts and unknown records are folded away so the dialogue
    // stays readable; the raw detail is one click behind <details>.
    const collapsible = m.role === "thought" || m.role === "tool" || m.role === "unknown";
    if (options.showRoleHeading && !collapsible) lines.push(`## ${roleLabel(m, options)}`);
    if (m.timestamp && options.showTimestamp && !collapsible) lines.push(`_${m.timestamp}_`, "");
    if (collapsible) {
      lines.push(
        `<details><summary>${roleLabel(m, options)}${m.timestamp && options.showTimestamp ? ` · ${m.timestamp}` : ""}</summary>`,
        "",
        "```json",
        body,
        "```",
        "",
        "</details>",
        ""
      );
    } else {
      lines.push(body, "");
    }
  }
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const HTML_STYLE = `
:root{
--bg:#f8f7f3;--ink:#20242b;--muted:#676c76;--faint:#8b8f98;
--hair:#e6e4dc;--accent:#2b54c4;--accent-soft:#e3eaf9;
--code-bg:#efeee9;--tool-bg:#f1f0eb;
--sel:#c7d6f5;
--k-exec:#2b54c4;--k-read:#2f7d4f;--k-edit:#986018;
--k-fetch:#7a4dab;--k-skill:#1f7a8c;
}
@media(prefers-color-scheme:dark){
:root{--bg:#151619;--ink:#e4e5e2;--muted:#9ba0a9;--faint:#6e727b;
--hair:#2a2c31;--accent:#8aa7f0;--accent-soft:#25304a;
--code-bg:#1d1f24;--tool-bg:#1b1d21;--sel:#2d3f66;
--k-exec:#8aa7f0;--k-read:#6fbf8f;--k-edit:#d9a45b;
--k-fetch:#b48fe0;--k-skill:#5fb8c9}
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;
margin:0;background:var(--bg);color:var(--ink);line-height:1.6;
-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:var(--sel)}
a{color:var(--accent);text-decoration:underline;text-underline-offset:3px;
text-decoration-thickness:1px;text-decoration-color:color-mix(in srgb,var(--accent) 40%,transparent)}
a:hover{text-decoration-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--hair);border-radius:5px;border:2px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}

.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:16px;
flex-wrap:wrap;row-gap:6px;
padding:10px 24px;background:color-mix(in srgb,var(--bg) 82%,transparent);
backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);
border-bottom:1px solid var(--hair);font-size:.82rem}
.top .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top .c{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.top .sp{flex:1;min-width:8px}
.top button{background:none;border:1px solid var(--hair);color:var(--muted);
font:inherit;font-size:.75rem;padding:5px 12px;border-radius:20px;cursor:pointer}
.top button:hover{color:var(--ink);border-color:var(--faint)}

.doc{max-width:780px;margin:0 auto;padding:48px 28px 96px}
h1{font-family:'New York',ui-serif,Georgia,serif;font-weight:600;
font-size:1.9rem;line-height:1.25;letter-spacing:-.01em;margin:0 0 10px;
text-wrap:balance}
.meta{color:var(--muted);font-size:.84rem;margin:0 0 8px;overflow-wrap:anywhere}
.meta code{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:.92em;
word-break:break-all}
.divider{border:0;border-top:1px solid var(--hair);margin:32px 0 8px}

.turn{display:grid;grid-template-columns:76px minmax(0,1fr);gap:18px;
padding:20px 0;border-bottom:1px solid var(--hair)}
.rail{text-align:right;padding-top:2px}
.role{display:block;font-size:.72rem;font-weight:700;letter-spacing:.08em;
text-transform:uppercase;color:var(--muted)}
.user .role{color:var(--accent)}
.role.tk-execute{color:var(--k-exec)}
.role.tk-read{color:var(--k-read)}
.role.tk-edit{color:var(--k-edit)}
.role.tk-fetch{color:var(--k-fetch)}
.role.tk-skill{color:var(--k-skill)}
.time{display:block;font-size:.7rem;color:var(--faint);margin-top:3px;
font-variant-numeric:tabular-nums}
.body{min-width:0}
.body>*:first-child{margin-top:0}
.body>*:last-child{margin-bottom:0}
.body p{margin:.55em 0}
.body h1,.body h2,.body h3,.body h4{font-family:inherit;font-weight:650;
letter-spacing:-.01em;text-wrap:balance}
.body h2{font-size:1.12rem;margin:1.4em 0 .5em}
.body h3{font-size:1rem;margin:1.3em 0 .45em}
.body h4{font-size:.94rem;margin:1.2em 0 .4em}
.body ul,.body ol{margin:.55em 0;padding-left:1.5em}
.body li{margin:.2em 0}
.body li::marker{color:var(--faint)}
.body code{font-family:ui-monospace,'SF Mono',Menlo,monospace;
font-size:.86em;background:var(--code-bg);padding:.12em .4em;border-radius:5px}
.body pre{background:var(--code-bg);border-radius:10px;padding:14px 16px;
overflow-x:auto;font-size:.83rem;line-height:1.55;margin:.7em 0}
.body pre code{background:none;padding:0;font-size:inherit}
.body blockquote{margin:.7em 0;padding:2px 0 2px 14px;border-left:2px solid var(--hair);
color:var(--muted)}
.body table{border-collapse:collapse;font-size:.86rem;margin:.8em 0;width:100%}
.body th,.body td{border:1px solid var(--hair);padding:6px 12px;text-align:left;
font-variant-numeric:tabular-nums}
.body th{background:var(--tool-bg);font-weight:600}
.body img{max-width:100%;border-radius:8px}
.body hr{border:0;border-top:1px solid var(--hair);margin:1.4em 0}

details.turn{display:block;padding:0}
details.turn>summary{list-style:none;cursor:pointer;display:grid;
grid-template-columns:76px minmax(0,1fr);gap:18px;padding:12px 0;
border-radius:6px;user-select:none}
details.turn>summary::-webkit-details-marker{display:none}
details.turn>summary:hover .tt{color:var(--ink)}
details.turn .tt{padding-top:1px;font-family:ui-monospace,'SF Mono',Menlo,monospace;
font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:8px;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
details.turn .tt::before{content:'›';font-family:inherit;font-size:.85rem;
color:var(--faint);transition:transform .18s ease;flex:none}
details.turn[open] .tt::before{transform:rotate(90deg)}
details.turn>.body{background:var(--tool-bg);border-radius:10px;
padding:12px 16px;margin:0 0 14px;margin-left:94px}
details.turn>.body pre{margin:0;background:none;padding:0;font-size:.8rem;
white-space:pre-wrap;word-break:break-word}
details.turn>.body code{background:none;padding:0}
details.thought>.body{color:var(--muted);font-size:.92rem}

@media(max-width:720px){
.doc{padding:28px 16px 64px}
h1{font-size:1.5rem}
.top{padding:8px 14px;gap:10px;font-size:.78rem}
.turn,details.turn>summary{grid-template-columns:1fr;gap:2px}
.turn{padding:14px 0}
details.turn>summary{padding:10px 0}
.rail{text-align:left;padding-top:0}
.rail .role{display:inline}
.rail .time{display:inline;margin:0 0 0 8px}
details.turn>.body{margin-left:0;padding:10px 12px}
.body pre{font-size:.78rem}
.body table{display:block;overflow-x:auto;max-width:100%}
.body blockquote{padding-left:10px}
.body{overflow-wrap:break-word}
}
@media print{
:root{--bg:#fff;--ink:#20242b;--muted:#676c76;--faint:#6e727b;
--hair:#ddd;--accent:#2b54c4;--code-bg:#f2f1ec;--tool-bg:#f6f5f1;
--k-exec:#2b54c4;--k-read:#2f7d4f;--k-edit:#986018;
--k-fetch:#7a4dab;--k-skill:#1f7a8c}
.top{display:none}
body{background:#fff}
details.turn>.body{display:block}
}
`;

function hhmm(ts?: string): string {
  return ts ? ts.slice(11, 16) : "";
}

function toolKind(m: ExportMessage): string {
  const c = (m.raw as any)?.content;
  return c?.kind || c?._meta?.["cognition.ai/inferenceToolName"] || "tool";
}

function toolTitle(m: ExportMessage): string {
  const c = (m.raw as any)?.content;
  return (typeof c?.title === "string" && c.title) || m.text.split("\n")[0] || "tool call";
}

function toolLabel(kind: string): string {
  const map: Record<string, string> = { execute: "Exec", get_output: "Shell" };
  return map[kind] ?? kind.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/ /g, "");
}

function md(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

/** Self-contained HTML rendering — shared by the .html export and the preview webview. */
export function renderHtml(session: SessionInfo, messages: ExportMessage[], options: ExportOptions): string {
  const title = escapeHtml(session.title || session.id);
  const nMsgs = messages.filter(m => m.role === "user" || m.role === "assistant").length;
  const nTools = messages.filter(m => m.role === "tool").length;
  const updated = new Date(session.mtime).toLocaleString();
  const parts: string[] = [];

  for (const m of messages) {
    const time = options.showTimestamp ? hhmm(m.timestamp) : "";
    const timeEl = time ? `<span class='time'>${time}</span>` : "";
    if (m.role === "user" || m.role === "assistant") {
      const who = m.role === "user" ? options.userLabel : options.assistantLabel;
      const cls = m.role === "user" ? "user" : "devin";
      const whoEl = options.showRoleHeading ? `<span class='role'>${escapeHtml(who)}</span>` : "";
      parts.push(
        `<div class='turn ${cls}'><div class='rail'>${whoEl}${timeEl}</div>` +
        `<div class='body'>${md(messageBody(m).trim() || "_(no extractable text)_")}</div></div>`
      );
    } else if (m.role === "thought") {
      parts.push(
        `<details class='turn thought'><summary>` +
        `<span class='rail'><span class='role'>Thinking</span>${timeEl}</span>` +
        `<span class='tt'>reasoning</span></summary>` +
        `<div class='body'>${md(messageBody(m).trim() || "_(no extractable text)_")}</div></details>`
      );
    } else if (m.role === "tool") {
      const kind = toolKind(m);
      const label = escapeHtml(toolLabel(kind));
      const cls = `tk-${kind.replace(/_/g, "-")}`;
      parts.push(
        `<details class='turn tool'><summary>` +
        `<span class='rail'><span class='role ${cls}'>${label}</span>${timeEl}</span>` +
        `<span class='tt'>${escapeHtml(toolTitle(m))}</span></summary>` +
        `<div class='body'><pre>${escapeHtml(messageBody(m).trim() || "(no extractable text)")}</pre></div></details>`
      );
    } else {
      parts.push(
        `<details class='turn tool'><summary>` +
        `<span class='rail'><span class='role'>Other</span>${timeEl}</span>` +
        `<span class='tt'>${escapeHtml(m.kind)}</span></summary>` +
        `<div class='body'><pre>${escapeHtml(messageBody(m).trim() || "(no extractable text)")}</pre></div></details>`
      );
    }
  }

  const meta = options.showSessionInfo
    ? `<p class='meta'><code>${escapeHtml(session.id)}</code> · updated ${escapeHtml(updated)} · exported ${escapeHtml(new Date().toLocaleString())}</p><hr class='divider'>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Devin session</title><style>${HTML_STYLE}</style></head>
<body><div class='top'><span class='t'>${title}</span><span class='c'>${nMsgs} messages · ${nTools} tool calls</span><span class='sp'></span><button onclick='expandAll(true)'>Expand all</button><button onclick='expandAll(false)'>Collapse</button></div>
<div class='doc'><h1>${title}</h1>${meta}
${parts.join("\n")}</div>
<script>function expandAll(v){document.querySelectorAll('details').forEach(d=>d.open=v)}</script>
</body></html>`;
}

export function writeSession(
  session: SessionInfo,
  messages: ExportMessage[],
  options: ExportOptions,
  outputDir: string,
  index: number
): string[] {
  const chosen = prepareMessages(messages, options);
  fs.mkdirSync(outputDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const template = options.customName.trim() || options.filenameTemplate || "{sessionId}";
  const base = safeFilename(template
    .replaceAll("{sessionId}", session.id)
    .replaceAll("{date}", date)
    .replaceAll("{index}", String(index))
    .replaceAll("{name}", session.title || session.id));
  const written: string[] = [];

  if (options.writeMarkdown) {
    const file = path.join(outputDir, `${base}.md`);
    fs.writeFileSync(file, renderMarkdown(session, chosen, options), "utf8");
    written.push(file);
  }
  if (options.writeHtml) {
    const file = path.join(outputDir, `${base}.html`);
    fs.writeFileSync(file, renderHtml(session, chosen, options), "utf8");
    written.push(file);
  }
  if (options.writeJson) {
    const file = path.join(outputDir, `${base}.json`);
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: "1.0",
      session: { id: session.id, title: session.title, database: path.basename(session.dbPath) },
      exportedAt: new Date().toISOString(),
      options: {
        includeUser: options.includeUser,
        includeAssistant: options.includeAssistant,
        includeThoughts: options.includeThoughts,
        includeToolCalls: options.includeToolCalls,
        includeUnknown: options.includeUnknown
      },
      messages: chosen.map(({ raw, ...m }) => m)
    }, null, 2), "utf8");
    written.push(file);
  }
  return written;
}
