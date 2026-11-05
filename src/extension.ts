import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { findDatabases, getExportDirectory } from "./paths";
import { readSession, scanSessionMeta } from "./sqlite";
import { prepareMessages, renderHtml, writeSession } from "./exporters";
import { ExportMessage, ExportOptions, SessionInfo } from "./types";
import { SettingsProvider, boolSettingDefault } from "./settingsView";

let cachedSessions: SessionInfo[] = [];
let extensionContext: vscode.ExtensionContext;
let logChannel: vscode.OutputChannel | undefined;
const CONFIGURED_KEY = "devinExporter.preferencesConfigured";

function log(): vscode.OutputChannel {
  return (logChannel ??= vscode.window.createOutputChannel("Devin Session Exporter"));
}

function readOptions(): ExportOptions {
  const c = vscode.workspace.getConfiguration("devinExporter");
  return {
    includeUser: c.get<boolean>("includeUser", true),
    includeAssistant: c.get<boolean>("includeAssistant", true),
    includeThoughts: c.get<boolean>("includeThoughts", false),
    includeToolCalls: c.get<boolean>("includeToolCalls", false),
    includeUnknown: c.get<boolean>("includeUnknown", false),
    writeMarkdown: c.get<boolean>("writeMarkdown", true),
    writeHtml: c.get<boolean>("writeHtml", false),
    writeJson: c.get<boolean>("writeJson", true),
    filenameTemplate: c.get<string>("filenameTemplate", "{sessionId}"),
    customName: "",
    showSessionInfo: c.get<boolean>("showSessionInfo", true),
    showRoleHeading: c.get<boolean>("showRoleHeading", true),
    showTimestamp: c.get<boolean>("showTimestamp", true),
    userLabel: c.get<string>("userLabel", "User"),
    assistantLabel: c.get<string>("assistantLabel", "Devin"),
    incremental: c.get<boolean>("incrementalExport", false)
  };
}

function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

async function configureAndGetOptions(): Promise<ExportOptions | undefined> {
  const options = readOptions();
  const picks = await vscode.window.showQuickPick([
    { label: "$(account) User messages", description: "user_message", picked: options.includeUser, key: "user" },
    { label: "$(sparkle) Devin messages", description: "agent_message", picked: options.includeAssistant, key: "assistant" },
    { label: "$(brain) Devin thoughts", description: "agent_thought", picked: options.includeThoughts, key: "thought" },
    { label: "$(tools) Tool calls", description: "tool_call", picked: options.includeToolCalls, key: "tool" },
    { label: "$(code) Other kinds", description: "Exported as raw JSON", picked: options.includeUnknown, key: "unknown" }
  ], { canPickMany: true, title: "Setup: choose message types to export (saved; editable in the sidebar)", placeHolder: "Multi-select; selecting none exports nothing" });

  if (!picks) return undefined;
  options.includeUser = picks.some(p => p.key === "user");
  options.includeAssistant = picks.some(p => p.key === "assistant");
  options.includeThoughts = picks.some(p => p.key === "thought");
  options.includeToolCalls = picks.some(p => p.key === "tool");
  options.includeUnknown = picks.some(p => p.key === "unknown");

  const formats = await vscode.window.showQuickPick([
    { label: "Markdown", key: "md", picked: options.writeMarkdown },
    { label: "JSON", key: "json", picked: options.writeJson },
    { label: "HTML (single-file page)", key: "html", picked: options.writeHtml }
  ], { canPickMany: true, title: "Choose export formats", placeHolder: "Multi-select" });
  if (!formats?.length) return undefined;
  options.writeMarkdown = formats.some(f => f.key === "md");
  options.writeJson = formats.some(f => f.key === "json");
  options.writeHtml = formats.some(f => f.key === "html");

  const display = await vscode.window.showQuickPick([
    { label: "Session info", description: "Session ID and message count at the top", picked: options.showSessionInfo, key: "session" },
    { label: "Role headings", description: `## ${options.userLabel} / ## ${options.assistantLabel}`, picked: options.showRoleHeading, key: "role" },
    { label: "Timestamps", description: "Timestamp for each message", picked: options.showTimestamp, key: "ts" },
    { label: "Incremental export", description: "Skip sessions with no new messages since last export", picked: options.incremental, key: "incremental" }
  ], { canPickMany: true, title: "Choose what to include in exports", placeHolder: "Multi-select; selecting none exports plain text only" });
  if (!display) return undefined;
  options.showSessionInfo = display.some(p => p.key === "session");
  options.showRoleHeading = display.some(p => p.key === "role");
  options.showTimestamp = display.some(p => p.key === "ts");
  options.incremental = display.some(p => p.key === "incremental");

  const labels = await vscode.window.showInputBox({
    title: "Custom role display names",
    prompt: "Format: user name,Devin name",
    value: `${options.userLabel},${options.assistantLabel}`,
    placeHolder: "User,Devin"
  });
  if (labels === undefined) return undefined;
  const [u, a] = labels.split(/[,，]/);
  options.userLabel = u?.trim() || "User";
  options.assistantLabel = a?.trim() || "Devin";

  const defaultName = options.filenameTemplate;
  const custom = await vscode.window.showInputBox({
    title: "Custom export filename",
    prompt: "Fixed name, or tokens {sessionId}, {date}, {index}, {name}. Use {sessionId} to avoid collisions.",
    value: defaultName,
    placeHolder: "{sessionId}"
  });
  if (custom === undefined) return undefined;
  options.customName = custom.trim();
  return options;
}

async function persistOptions(options: ExportOptions): Promise<void> {
  const c = vscode.workspace.getConfiguration("devinExporter");
  const g = vscode.ConfigurationTarget.Global;
  await Promise.all([
    c.update("includeUser", options.includeUser, g),
    c.update("includeAssistant", options.includeAssistant, g),
    c.update("includeThoughts", options.includeThoughts, g),
    c.update("includeToolCalls", options.includeToolCalls, g),
    c.update("includeUnknown", options.includeUnknown, g),
    c.update("writeMarkdown", options.writeMarkdown, g),
    c.update("writeHtml", options.writeHtml, g),
    c.update("writeJson", options.writeJson, g),
    c.update("filenameTemplate", options.customName.trim() || options.filenameTemplate, g),
    c.update("showSessionInfo", options.showSessionInfo, g),
    c.update("showRoleHeading", options.showRoleHeading, g),
    c.update("showTimestamp", options.showTimestamp, g),
    c.update("userLabel", options.userLabel, g),
    c.update("assistantLabel", options.assistantLabel, g),
    c.update("incrementalExport", options.incremental, g)
  ]);
  await extensionContext.globalState.update(CONFIGURED_KEY, true);
}

const SCAN_CACHE_KEY = "devinExporter.scanCache";

type ScanMeta = {
  title?: string; userCount: number; assistantCount: number; total: number;
  mtime: number; snippet?: string; hasWal: boolean;
};

async function scanSessions(): Promise<SessionInfo[]> {
  const dbs = findDatabases();
  if (!dbs.length) {
    vscode.window.showWarningMessage("No Devin ACP databases found. Set devinExporter.databaseDirectory to point at them.");
    return [];
  }
  const cache = extensionContext.globalState.get<Record<string,
    { mtime: number; size: number; walSize: number; meta: ScanMeta }>>(SCAN_CACHE_KEY, {});
  const found: SessionInfo[] = [];
  const seenIds = new Set<string>();
  let done = 0;
  let cacheHits = 0;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Scanning Devin sessions",
    cancellable: false
  }, async progress => {
    await Promise.all(dbs.map(async dbPath => {
      try {
        const id = path.basename(dbPath, path.extname(dbPath));
        const [stat, walStat] = await Promise.all([
          fs.promises.stat(dbPath),
          fs.promises.stat(`${dbPath}-wal`).catch(() => undefined)
        ]);
        const walSize = walStat?.size ?? 0;
        const hit = cache[dbPath];
        const result = hit && hit.mtime === stat.mtimeMs && hit.size === stat.size && hit.walSize === walSize
          ? (cacheHits++, hit.meta)
          : await scanSessionMeta(dbPath);
        cache[dbPath] = { mtime: stat.mtimeMs, size: stat.size, walSize, meta: result };
        if (!seenIds.has(id) && (result.userCount || result.assistantCount)) {
          seenIds.add(id);
          found.push({
            id, dbPath, messageCount: result.total,
            userCount: result.userCount, assistantCount: result.assistantCount,
            title: result.title, mtime: result.mtime,
            snippet: result.snippet, hasWal: result.hasWal
          });
        }
      } catch (e) {
        console.warn(`Skipping database ${dbPath}`, e);
      }
      progress.report({ message: `${++done}/${dbs.length}` });
    }));
  });
  await extensionContext.globalState.update(SCAN_CACHE_KEY, cache);
  console.log(`[Devin Session Exporter] Scan complete: ${found.length} sessions, ${cacheHits}/${dbs.length} cache hits`);
  log().appendLine(`[${new Date().toLocaleString()}] scan: ${found.length} sessions from ${dbs.length} databases`);
  // WAL data is read live via node:sqlite — no staleness warning needed.
  found.sort((a, b) => a.id.localeCompare(b.id));
  cachedSessions = found;
  sessionsProvider?.setSessions(found);
  return found;
}

const SORT_DESC_KEY = "devinExporter.sessionSortDesc";

type SessionPick = vscode.QuickPickItem & { session: SessionInfo };

async function selectSessions(sessions: SessionInfo[]): Promise<SessionInfo[] | undefined> {
  let sortDesc = extensionContext.globalState.get<boolean>(SORT_DESC_KEY, true);
  const btnDesc: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("arrow-down"), tooltip: "Newest first (click for oldest first)" };
  const btnAsc: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("arrow-up"), tooltip: "Oldest first (click for newest first)" };

  const btnAll: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("checklist"), tooltip: "Select all / none" };

  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick<SessionPick>();
    qp.canSelectMany = true;
    qp.title = "Select sessions to export";
    qp.placeholder = "Multi-select; type to filter by title, ID, or path";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    const render = () => {
      const keep = new Set((qp.selectedItems ?? []).map(i => i.session.id));
      const sorted = [...sessions].sort((a, b) => sortDesc ? b.mtime - a.mtime : a.mtime - b.mtime);
      qp.items = sorted.map(s => ({
        label: `${s.hasWal ? "$(warning) " : ""}${s.title || s.snippet || s.id}`,
        description: `${s.userCount} user · ${s.assistantCount} Devin · ${ago(s.mtime)}`,
        detail: `ID: ${s.id}\n${s.dbPath}${s.snippet ? `\nFirst message: ${s.snippet}` : ""}`,
        picked: keep.has(s.id),
        session: s
      }));
      qp.buttons = [btnAll, sortDesc ? btnDesc : btnAsc];
    };

    qp.onDidTriggerButton(btn => {
      if (btn === btnAll) {
        qp.selectedItems = qp.selectedItems.length === qp.items.length ? [] : [...qp.items];
        return;
      }
      sortDesc = !sortDesc;
      extensionContext.globalState.update(SORT_DESC_KEY, sortDesc);
      render();
    });
    qp.onDidAccept(() => {
      // resolve BEFORE dispose — dispose() fires onDidHide synchronously, and
      // the first resolve() wins.
      resolve(qp.selectedItems.map(i => i.session));
      qp.dispose();
    });
    qp.onDidHide(() => {
      resolve(undefined);
    });
    render();
    qp.show();
  });
}

const EXPORTED_POS_KEY = "devinExporter.exportedPositions";

async function doExport(sessions: SessionInfo[]) {
  if (!sessions.length) return;
  const configured = extensionContext.globalState.get<boolean>(CONFIGURED_KEY, false);
  const options = configured ? readOptions() : await configureAndGetOptions();
  if (!options) return;
  if (!configured) await persistOptions(options);
  const outputDir = getExportDirectory();
  const allFiles: string[] = [];
  const positions = extensionContext.globalState.get<Record<string, number>>(EXPORTED_POS_KEY, {});
  let skipped = 0;
  const failures: string[] = [];
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Exporting Devin sessions",
    cancellable: false
  }, async progress => {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      progress.report({ message: `${i + 1}/${sessions.length}` });
      try {
        const data = await readSession(s.dbPath);
        const maxPos = data.messages.reduce((m, x) => Math.max(m, x.position), 0);
        if (options.incremental && (positions[s.id] ?? -1) >= maxPos) {
          skipped++;
          continue;
        }
        allFiles.push(...writeSession(s, data.messages, options, outputDir, i + 1));
        positions[s.id] = maxPos;
      } catch (e) {
        failures.push(`${s.title || s.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
  await extensionContext.globalState.update(EXPORTED_POS_KEY, positions);
  if (failures.length) {
    console.warn("[Devin Session Exporter] Export failed:\n" + failures.join("\n"));
    const detail = failures.slice(0, 3).join("\n") + (failures.length > 3 ? `\n…${failures.length} total` : "");
    const act = await vscode.window.showErrorMessage(
      `${failures.length} sessions failed to export`,
      "Show details", "Copy details"
    );
    if (act === "Show details") {
      vscode.window.showInformationMessage(detail, { modal: true });
    } else if (act === "Copy details") {
      await vscode.env.clipboard.writeText(failures.join("\n"));
    }
  }
  if (!allFiles.length && skipped) {
    log().appendLine(`[${new Date().toLocaleString()}] ${skipped} sessions skipped (no new messages since last export)`);
    vscode.window.showInformationMessage(
      `No new messages; ${skipped} sessions skipped.`
    );
    return;
  }
  const skipNote = skipped ? `, skipped ${skipped} with no new messages` : "";
  log().appendLine(`[${new Date().toLocaleString()}] export → ${outputDir}`);
  for (const f of allFiles) log().appendLine(`  wrote ${f}`);
  if (!allFiles.length) return;
  const singleSession = sessions.length - skipped - failures.length === 1;
  const msg = singleSession
    ? `Exported ${allFiles.length} file(s) → ${outputDir}`
    : `Exported ${sessions.length - skipped - failures.length} sessions (${allFiles.length} files) → ${outputDir}${skipNote}`;
  const action = await vscode.window.showInformationMessage(
    msg,
    ...(singleSession
      ? ["Reveal in Finder", "Copy content", "Open folder"]
      : ["Reveal in Finder", "Open folder", "View log"])
  );
  if (singleSession) {
    // open the first file right away — the editor tab shows exactly where it landed
    await vscode.window.showTextDocument(vscode.Uri.file(allFiles[0]));
  }
  if (action === "Reveal in Finder") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(allFiles[0]));
  } else if (action === "Copy content") {
    await vscode.env.clipboard.writeText(await fs.promises.readFile(allFiles[0], "utf8"));
    vscode.window.showInformationMessage("Export copied to clipboard.");
  } else if (action === "Open folder") {
    await vscode.commands.executeCommand("devinExporter.openFolder");
  } else if (action === "View log") {
    log().show();
  }
}

const messageCache = new Map<string, { mtime: number; messages: ExportMessage[] }>();

async function sessionMessages(s: SessionInfo): Promise<ExportMessage[]> {
  const hit = messageCache.get(s.dbPath);
  if (hit && hit.mtime === s.mtime) return hit.messages;
  const { messages } = await readSession(s.dbPath);
  messageCache.set(s.dbPath, { mtime: s.mtime, messages });
  return messages;
}

type SearchPick = vscode.QuickPickItem & { session: SessionInfo };

const MAX_SEARCH_RESULTS = 150;
const SEARCH_DEBOUNCE_MS = 150;

async function searchMessagesCommand(): Promise<void> {
  const sessions = cachedSessions.length ? cachedSessions : await scanSessions();
  if (!sessions.length) return;

  // Messages stream into this pool session by session; filtering runs against
  // whatever is loaded so far. Only references are stored — no text copies.
  const pool: Array<{ session: SessionInfo; message: ExportMessage }> = [];
  let keyword = "";
  let loaded = 0;
  let disposed = false;
  let debounce: NodeJS.Timeout | undefined;

  const qp = vscode.window.createQuickPick<SearchPick>();
  qp.canSelectMany = true;
  qp.busy = true;
  qp.title = "Search session messages";
  qp.placeholder = `Loading sessions 0/${sessions.length}…`;
  qp.matchOnDescription = true;

  const applyFilter = () => {
    if (disposed) return;
    const kw = keyword.toLowerCase();
    if (!kw) { qp.items = []; return; }
    const items: SearchPick[] = [];
    for (const { session, message } of pool) {
      const idx = message.text.toLowerCase().indexOf(kw);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 40);
      items.push({
        label: session.title || session.snippet || session.id,
        description: message.role === "user" ? "User" : message.role === "assistant" ? "Devin" : message.kind,
        detail: (start > 0 ? "…" : "") + message.text.slice(start, idx + kw.length + 60).replace(/\s+/g, " ") + "…",
        session
      });
      if (items.length >= MAX_SEARCH_RESULTS) break;
    }
    qp.items = items;
  };

  const scheduleFilter = () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyFilter, SEARCH_DEBOUNCE_MS);
  };

  const done = new Promise<void>(resolve => {
    qp.onDidChangeValue(v => { keyword = v.trim(); scheduleFilter(); });
    qp.onDidAccept(() => {
      const unique = [...new Map([...qp.selectedItems]
        .map(i => [i.session.id, i.session])).values()];
      resolve();
      qp.dispose();
      if (unique.length) void doExport(unique);
    });
    qp.onDidHide(() => { disposed = true; qp.dispose(); resolve(); });
    qp.show();
  });

  (async () => {
    for (const s of sessions) {
      if (disposed) break;
      try {
        for (const m of await sessionMessages(s)) pool.push({ session: s, message: m });
      } catch { /* skip unreadable db */ }
      loaded++;
      if (disposed) break;
      qp.placeholder = `Loaded ${loaded}/${sessions.length} sessions — type to search, check to export`;
      applyFilter();
    }
    qp.busy = false;
    if (!loaded) qp.placeholder = "No messages to search";
  })();

  await done;
}

async function previewSession(s: SessionInfo): Promise<void> {
  const options = readOptions();
  let prepared: ExportMessage[];
  try {
    prepared = prepareMessages(await sessionMessages(s), options);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not read session: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "devinSessionPreview",
    `Preview: ${s.title || s.snippet || s.id}`,
    vscode.ViewColumn.Beside
  );
  panel.webview.html = renderHtml(s, prepared, options);
}

class SessionsProvider implements vscode.TreeDataProvider<SessionInfo> {
  private emitter = new vscode.EventEmitter<SessionInfo | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private items: SessionInfo[] = [];
  private scanPromise: Promise<SessionInfo[]> | undefined;

  setSessions(sessions: SessionInfo[]): void {
    this.items = sessions;
    this.emitter.fire(undefined);
  }

  getTreeItem(s: SessionInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(s.title || s.snippet || s.id);
    item.description = `${s.userCount} user · ${s.assistantCount} Devin · ${ago(s.mtime)}`;
    item.tooltip = new vscode.MarkdownString(
      `**ID**: \`${s.id}\`\n\n\`${s.dbPath}\`${s.snippet ? `\n\n> ${s.snippet}` : ""}${s.hasWal ? `\n\n$(warning) session still writing — includes latest messages` : ""}`
    );
    item.iconPath = new vscode.ThemeIcon(s.hasWal ? "warning" : "comment-discussion");
    item.contextValue = "devinSession";
    return item;
  }

  getChildren(): vscode.ProviderResult<SessionInfo[]> {
    if (!this.items.length) {
      if (!this.scanPromise) {
        this.scanPromise = scanSessions()
          .then(s => { this.items = s; return s; })
          .finally(() => { this.scanPromise = undefined; });
      }
      return this.scanPromise;
    }
    return this.items;
  }
}

let sessionsProvider: SessionsProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  sessionsProvider = new SessionsProvider();
  const settingsProvider = new SettingsProvider();
  context.subscriptions.push(
    vscode.window.createTreeView("devinSessionExporter.sessions", {
      treeDataProvider: sessionsProvider,
      canSelectMany: true
    }),
    vscode.window.createTreeView("devinSessionExporter.settings", {
      treeDataProvider: settingsProvider
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("devinExporter")) settingsProvider.refresh();
    }),
    vscode.commands.registerCommand("devinExporter.exportAll", async () => {
      const sessions = await scanSessions();
      if (!sessions.length) {
        vscode.window.showInformationMessage("No exportable sessions found.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Export all ${sessions.length} sessions to ${getExportDirectory()}?`,
        { modal: true },
        "Export"
      );
      if (confirm === "Export") await doExport(sessions);
    }),
    vscode.commands.registerCommand("devinExporter.toggleSetting", async (key: string) => {
      const c = vscode.workspace.getConfiguration("devinExporter");
      await c.update(key, !c.get<boolean>(key, boolSettingDefault(key)), vscode.ConfigurationTarget.Global);
      await context.globalState.update(CONFIGURED_KEY, true);
    }),
    vscode.commands.registerCommand("devinExporter.editSetting", async (key: string, prompt: string) => {
      const c = vscode.workspace.getConfiguration("devinExporter");
      const value = await vscode.window.showInputBox({
        title: `Set ${key}`,
        prompt,
        value: c.get<string>(key, "")
      });
      if (value === undefined) return;
      await c.update(key, value.trim(), vscode.ConfigurationTarget.Global);
      await context.globalState.update(CONFIGURED_KEY, true);
    }),
    vscode.commands.registerCommand("devinExporter.scanAndExport", async () => {
      const sessions = await scanSessions();
      if (sessions.length) await doExport((await selectSessions(sessions)) || []);
      else vscode.window.showInformationMessage("No sessions containing user/agent messages found.");
    }),
    vscode.commands.registerCommand("devinExporter.exportSelected", async () => {
      const sessions = cachedSessions.length ? cachedSessions : await scanSessions();
      if (sessions.length) await doExport((await selectSessions(sessions)) || []);
      else vscode.window.showInformationMessage("No exportable sessions found.");
    }),
    vscode.commands.registerCommand("devinExporter.configureExport", async () => {
      const options = await configureAndGetOptions();
      if (!options) return;
      await persistOptions(options);
      vscode.window.showInformationMessage("Export preferences saved.");
    }),
    vscode.commands.registerCommand("devinExporter.openFolder", async () => {
      const dir = getExportDirectory();
      const fs = await import("node:fs");
      fs.mkdirSync(dir, { recursive: true });
      await vscode.env.openExternal(vscode.Uri.file(dir));
    }),
    vscode.commands.registerCommand("devinExporter.refreshSessions", async () => {
      sessionsProvider?.setSessions(await scanSessions());
    }),
    vscode.commands.registerCommand("devinExporter.exportSession", async (item?: SessionInfo, items?: SessionInfo[]) => {
      if (items?.length) return doExport(items);
      if (item) return doExport([item]);
      const sessions = cachedSessions.length ? cachedSessions : await scanSessions();
      if (sessions.length) await doExport((await selectSessions(sessions)) || []);
      else vscode.window.showInformationMessage("No exportable sessions found.");
    }),
    vscode.commands.registerCommand("devinExporter.searchMessages", searchMessagesCommand),
    vscode.commands.registerCommand("devinExporter.previewSession", async (item?: SessionInfo) => {
      const s = item ?? (await selectSessions(cachedSessions.length ? cachedSessions : await scanSessions()))?.[0];
      if (s) await previewSession(s);
    }),
    vscode.commands.registerCommand("devinExporter.copySessionId", async (item: SessionInfo) => {
      await vscode.env.clipboard.writeText(item.id);
      vscode.window.showInformationMessage(`Copied session ID: ${item.id}`);
    }),
    vscode.commands.registerCommand("devinExporter.revealDatabase", async (item: SessionInfo) => {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(item.dbPath));
    })
  );
}

export function deactivate() {}