import * as fs from "node:fs";
import { ExportMessage, ExportRole } from "./types";

// Node ≥22 built-in SQLite: reads the live database including unflushed WAL
// data, which is where the newest messages of an active session live.
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean }
  ) => {
    prepare(sql: string): {
      all(...args: unknown[]): Record<string, unknown>[];
      get(...args: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

function openDb(dbPath: string): Db {
  return new DatabaseSync(dbPath, { readOnly: true });
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

function listTables(db: Db): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();
  return rows.map(row => String(row.name));
}

function readTitle(db: Db): string | undefined {
  for (const table of listTables(db)) {
    if (!/meta|info/i.test(table)) continue;
    try {
      const safe = table.replace(/"/g, '""');
      const rows = db.prepare(`SELECT * FROM "${safe}" LIMIT 100`).all();
      for (const row of rows) {
        for (const value of Object.values(row)) {
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

function requireMessagesTable(db: Db) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get();
  if (!row) throw new Error("messages table not found in database");
}

export async function readSession(dbPath: string): Promise<{ messages: ExportMessage[]; title?: string }> {
  const db = openDb(dbPath);
  try {
    requireMessagesTable(db);
    const title = readTitle(db);
    const rows = db.prepare(
      "SELECT position, kind, payload FROM messages ORDER BY position"
    ).all();
    const messages: ExportMessage[] = [];
    for (const row of rows) {
      const position = Number(row.position);
      const kind = String(row.kind ?? "");
      let payload: any;
      try { payload = JSON.parse(String(row.payload ?? "")); }
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
  const db = openDb(dbPath);
  try {
    requireMessagesTable(db);
    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of db.prepare(
      "SELECT kind, COUNT(*) AS n FROM messages GROUP BY kind"
    ).all()) {
      counts[String(row.kind)] = Number(row.n);
      total += Number(row.n);
    }
    let snippet: string | undefined;
    const firstRow = db.prepare(
      "SELECT payload FROM messages WHERE kind='user_message' ORDER BY position LIMIT 1"
    ).get();
    const raw = firstRow?.payload;
    if (typeof raw === "string") {
      try {
        const text = extractText(JSON.parse(raw)).replace(/\s+/g, " ").trim();
        if (text) snippet = text.slice(0, 60);
      } catch { /* malformed payload */ }
    }
    const [stat, walStat] = await Promise.all([
      fs.promises.stat(dbPath),
      fs.promises.stat(`${dbPath}-wal`).catch(() => undefined)
    ]);
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
