export type ExportRole = "user" | "assistant" | "thought" | "tool" | "unknown";

export interface ExportMessage {
  position: number;
  role: ExportRole;
  kind: string;
  text: string;
  timestamp?: string;
  id?: string;
  turnId?: string;
  clientMessageId?: string;
  raw?: unknown;
}

export interface SessionInfo {
  id: string;
  dbPath: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
  title?: string;
  mtime: number;
  snippet?: string;
  hasWal?: boolean;
}

export interface ExportOptions {
  includeUser: boolean;
  includeAssistant: boolean;
  includeThoughts: boolean;
  includeToolCalls: boolean;
  includeUnknown: boolean;
  writeMarkdown: boolean;
  writeHtml: boolean;
  writeJson: boolean;
  filenameTemplate: string;
  customName: string;
  showSessionInfo: boolean;
  showRoleHeading: boolean;
  showTimestamp: boolean;
  userLabel: string;
  assistantLabel: string;
  incremental: boolean;
  forceExportWal: boolean;
}