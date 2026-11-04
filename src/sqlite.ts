import * as fs from "node:fs";
import initSqlJs, { Database } from "sql.js";
import { ExportMessage, ExportRole } from "./types";

let sqlPromise: ReturnType<typeof initSqlJs> | undefined;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
  }
  return sqlPromise;
}

function roleFor(kind: string): ExportRole {
  switch (kind) {
    case "user_message": return "user";
    case "agent_message": return "assistant";
    case "agent_thought": return "thought";
    case "tool_call": return "tool";
    default: return "unknown";
  }
}

function extractText(payload: any): string {
  const chunks: string[] = [];
  const visit = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    // Extract only explicit text content blocks; never rawInput/command/title/tool metadata.
    if (value.type === "text" && typeof value.text === "string") {
      chunks.push(value.text);
      return;
    }
    if (value.content !== undefined) visit(value.content);
  };
  visit(payload?.content);
  return chunks.join("");
}

function firstTimestamp(payload: any): string | undefined {
  const direct = payload?.content;
  if (Array.isArray(direct)) {
    for (const item of direct) {
      const ts = item?._meta?.["cognition.ai/timestamp"];
      if (typeof ts === "string") return ts;
    }
  }
  const nested = direct?._meta?.["cognition.ai/timestamp"];
  return typeof nested === "string" ? nested : undefined;
}

function listTables(db: Database): string[] {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return result[0]?.values.map(row => String(row[0])) ?? [];
}

function readTitle(db: Database): string | undefined {
  for (const table of listTables(db)) {
    if (!/meta|info/i.test(table)) continue;
    try {
      const safe = table.replace(/"/g, '""');
      const result = db.exec(`SELECT * FROM "${safe}" LIMIT 100`);
      if (!result[0]) continue;
      for (const values of result[0].values) {
        for (const value of values) {
          let obj: unknown = value;
          if (typeof value === "string") {
            try { obj = JSON.parse(value); } catch { continue; }
          }
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            const title = (obj as Record<string, unknown>).title;
            if (typeof title === "string" && title.trim()) return title.trim();
          }
        }
      }
    } catch { /* metadata is optional */ }
  }
  return undefined;
}

export async function readSession(dbPath: string): Promise<{ messages: ExportMessage[]; title?: string }> {
  const SQL = await getSql();
  const bytes = await fs.promises.readFile(dbPath);
  const db = new SQL.Database(bytes);
  try {
    const tableCheck = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'");
    if (!tableCheck.length || !tableCheck[0].values.length) {
      throw new Error("数据库中不存在 messages 表");
    }
    const result = db.exec("SELECT position, kind, payload FROM messages ORDER BY position");
    const title = readTitle(db);
    if (!result.length) return { messages: [], title };
    const messages: ExportMessage[] = [];
    for (const row of result[0].values) {
      const position = Number(row[0]);
      const kind = String(row[1] ?? "");
      let payload: any;
      try { payload = JSON.parse(String(row[2] ?? "")); }
      catch { continue; }

      const role = roleFor(kind);
      const text = extractText(payload);
      const contentArray = Array.isArray(payload?.content) ? payload.content : [];
      const clientMessageId = contentArray
        .map((x: any) => x?._meta?.["cognition.ai/clientMessageId"])
        .find((x: unknown) => typeof x === "string") as string | undefined;

      messages.push({
        position, role, kind, text,
        timestamp: firstTimestamp(payload),
        id: typeof payload?.id === "string" ? payload.id : undefined,
        turnId: typeof payload?.turnId === "string" ? payload.turnId : undefined,
        clientMessageId,
        raw: payload
      });
    }
    return { messages, title };
  } finally {
    db.close();
  }
}

// Fast path for the picker: only counts rows per kind and reads the title.
// Payloads are not parsed — that happens later for the selected sessions only.
export async function scanSessionMeta(dbPath: string): Promise<{
  title?: string;
  userCount: number;
  assistantCount: number;
  total: number;
  mtime: number;
  snippet?: string;
  hasWal: boolean;
}> {
  const SQL = await getSql();
  const [bytes, stat, walStat] = await Promise.all([
    fs.promises.readFile(dbPath),
    fs.promises.stat(dbPath),
    fs.promises.stat(`${dbPath}-wal`).catch(() => undefined)
  ]);
  const db = new SQL.Database(bytes);
  try {
    const tableCheck = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'");
    if (!tableCheck.length || !tableCheck[0].values.length) {
      throw new Error("数据库中不存在 messages 表");
    }
    const result = db.exec("SELECT kind, COUNT(*) FROM messages GROUP BY kind");
    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of result[0]?.values ?? []) {
      counts[String(row[0])] = Number(row[1]);
      total += Number(row[1]);
    }
    let snippet: string | undefined;
    const firstRow = db.exec("SELECT payload FROM messages WHERE kind='user_message' ORDER BY position LIMIT 1");
    const raw = firstRow[0]?.values[0]?.[0];
    if (typeof raw === "string") {
      try {
        const text = extractText(JSON.parse(raw)).replace(/\s+/g, " ").trim();
        if (text) snippet = text.slice(0, 60);
      } catch { /* malformed payload */ }
    }
    return {
      title: readTitle(db),
      userCount: counts["user_message"] ?? 0,
      assistantCount: counts["agent_message"] ?? 0,
      total,
      mtime: stat.mtimeMs,
      snippet,
      hasWal: !!walStat && walStat.size > 0
    };
  } finally {
    db.close();
  }
}
