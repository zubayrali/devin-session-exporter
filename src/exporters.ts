import * as fs from "node:fs";
import * as path from "node:path";
import { ExportMessage, ExportOptions, SessionInfo } from "./types";

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
    m.role === "tool" ? "Tool Call" : `其他（${m.kind}）`;
}

function messageBody(m: ExportMessage): string {
  const text = m.text.trim();
  if (text) return m.text;
  return m.raw !== undefined ? JSON.stringify(m.raw, null, 2) : "";
}

function renderMarkdown(session: SessionInfo, messages: ExportMessage[], options: ExportOptions): string {
  const lines = [`# ${session.title || session.id}`, ""];
  if (options.showSessionInfo) {
    lines.push(`- Session ID: \`${session.id}\``, `- 消息数：${messages.length}`, "");
  }
  for (const m of messages) {
    const body = messageBody(m) || "_（此记录没有可提取的文本内容）_";
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
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; margin: 0;
         padding: 24px 16px; background: #f6f8fa; color: #1f2328; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 1.35em; margin: 0 0 6px; }
  .meta { font-size: .82em; color: #57606a; margin-bottom: 20px; word-break: break-all; }
  .msg { margin: 14px 0; max-width: 78%; }
  .msg .who { font-size: .78em; font-weight: 600; color: #57606a; margin-bottom: 4px; }
  .msg .ts { font-size: .72em; color: #8c959f; margin-bottom: 4px; }
  .msg .body { padding: 10px 14px; border-radius: 14px; line-height: 1.6;
               white-space: pre-wrap; word-break: break-word; }
  .msg.user { margin-left: auto; }
  .msg.user .who, .msg.user .ts { text-align: right; }
  .msg.user .body { background: #d1ebff; }
  .msg.assistant .body { background: #ffffff; border: 1px solid #e3e6ea; }
  .msg.unknown .body { background: #fff4e0; }
  details.aux { margin: 14px 0; }
  details.aux summary { cursor: pointer; font-size: .78em; font-weight: 600; color: #57606a; }
  details.aux pre { background: #ffffff; border: 1px solid #e3e6ea; border-radius: 10px;
                    padding: 12px 14px; font-size: .8em; line-height: 1.5; overflow-x: auto;
                    white-space: pre-wrap; word-break: break-word; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    h1 { color: #e6edf3; }
    .meta, .msg .who, details.aux summary { color: #9198a1; }
    .msg .ts { color: #6e7681; }
    .msg.user .body { background: #1f4d73; }
    .msg.assistant .body { background: #161b22; border-color: #30363d; }
    .msg.unknown .body { background: #3a2e15; }
    details.aux pre { background: #161b22; border-color: #30363d; }
  }
`;

/** Self-contained HTML rendering — shared by the .html export and the preview webview. */
export function renderHtml(session: SessionInfo, messages: ExportMessage[], options: ExportOptions): string {
  const title = escapeHtml(session.title || session.id);
  const parts = messages.map(m => {
    const label = escapeHtml(roleLabel(m, options));
    const ts = m.timestamp && options.showTimestamp ? `<div class="ts">${escapeHtml(m.timestamp)}</div>` : "";
    const body = escapeHtml(messageBody(m).trim() || "（此记录没有可提取的文本内容）");
    if (m.role === "thought" || m.role === "tool" || m.role === "unknown") {
      return `<details class="aux"><summary>${label}${m.timestamp && options.showTimestamp ? ` · ${escapeHtml(m.timestamp)}` : ""}</summary><pre>${body}</pre></details>`;
    }
    const who = options.showRoleHeading ? `<div class="who">${label}</div>` : "";
    return `<div class="msg ${m.role}">${who}${ts}<div class="body">${body}</div></div>`;
  });
  const meta = options.showSessionInfo
    ? `<div class="meta">Session ID: ${escapeHtml(session.id)} &nbsp;·&nbsp; 消息数 ${messages.length}</div>` : "";
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${HTML_STYLE}</style></head>
<body><div class="wrap"><h1>${title}</h1>${meta}${parts.join("\n")}</div></body></html>`;
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
