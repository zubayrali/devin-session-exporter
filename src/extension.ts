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
const CONFIGURED_KEY = "devinExporter.preferencesConfigured";

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
    userLabel: c.get<string>("userLabel", "用户"),
    assistantLabel: c.get<string>("assistantLabel", "Devin"),
    incremental: c.get<boolean>("incrementalExport", false),
    forceExportWal: c.get<boolean>("forceExportWal", false)
  };
}

function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ms).toLocaleDateString();
}

async function configureAndGetOptions(): Promise<ExportOptions | undefined> {
  const options = readOptions();
  const picks = await vscode.window.showQuickPick([
    { label: "$(account) 用户消息", description: "user_message", picked: options.includeUser, key: "user" },
    { label: "$(sparkle) Devin 回复", description: "agent_message", picked: options.includeAssistant, key: "assistant" },
    { label: "$(brain) Agent 思考", description: "agent_thought", picked: options.includeThoughts, key: "thought" },
    { label: "$(tools) 工具调用", description: "tool_call", picked: options.includeToolCalls, key: "tool" },
    { label: "$(code) 未识别类型", description: "以原始 JSON 记录导出", picked: options.includeUnknown, key: "unknown" }
  ], { canPickMany: true, title: "配置向导：选择要导出的消息类型（设置会保存，后续可在侧边栏随时修改）", placeHolder: "可多选；不选择任何项则导出空消息列表" });

  if (!picks) return undefined;
  options.includeUser = picks.some(p => p.key === "user");
  options.includeAssistant = picks.some(p => p.key === "assistant");
  options.includeThoughts = picks.some(p => p.key === "thought");
  options.includeToolCalls = picks.some(p => p.key === "tool");
  options.includeUnknown = picks.some(p => p.key === "unknown");

  const formats = await vscode.window.showQuickPick([
    { label: "Markdown", key: "md", picked: options.writeMarkdown },
    { label: "JSON", key: "json", picked: options.writeJson },
    { label: "HTML（单文件网页）", key: "html", picked: options.writeHtml }
  ], { canPickMany: true, title: "选择导出格式", placeHolder: "可多选" });
  if (!formats?.length) return undefined;
  options.writeMarkdown = formats.some(f => f.key === "md");
  options.writeJson = formats.some(f => f.key === "json");
  options.writeHtml = formats.some(f => f.key === "html");

  const display = await vscode.window.showQuickPick([
    { label: "Session 信息", description: "文档头部的 Session ID、消息数", picked: options.showSessionInfo, key: "session" },
    { label: "角色标题", description: `## ${options.userLabel} / ## ${options.assistantLabel}`, picked: options.showRoleHeading, key: "role" },
    { label: "时间戳", description: "每条消息的时间", picked: options.showTimestamp, key: "ts" },
    { label: "增量导出", description: "跳过自上次导出后没有新消息的会话", picked: options.incremental, key: "incremental" },
    { label: "强制导出 WAL 会话", description: "数据库有未落盘数据的会话也照常导出（内容可能不是最新）", picked: options.forceExportWal, key: "wal" }
  ], { canPickMany: true, title: "选择导出内容显示项", placeHolder: "可多选；不选择任何项则只导出纯文本对话" });
  if (!display) return undefined;
  options.showSessionInfo = display.some(p => p.key === "session");
  options.showRoleHeading = display.some(p => p.key === "role");
  options.showTimestamp = display.some(p => p.key === "ts");
  options.incremental = display.some(p => p.key === "incremental");
  options.forceExportWal = display.some(p => p.key === "wal");

  const labels = await vscode.window.showInputBox({
    title: "自定义角色显示名",
    prompt: "格式：用户显示名,Devin显示名（英文或中文逗号分隔）",
    value: `${options.userLabel},${options.assistantLabel}`,
    placeHolder: "用户,Devin"
  });
  if (labels === undefined) return undefined;
  const [u, a] = labels.split(/[,，]/);
  options.userLabel = u?.trim() || "用户";
  options.assistantLabel = a?.trim() || "Devin";

  const defaultName = options.filenameTemplate;
  const custom = await vscode.window.showInputBox({
    title: "自定义导出文件名",
    prompt: "可输入固定名称，或使用 {sessionId}、{date}、{index}、{name}。多 Session 时建议使用 {sessionId} 避免重名。",
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
    c.update("incrementalExport", options.incremental, g),
    c.update("forceExportWal", options.forceExportWal, g)
  ]);
  await extensionContext.globalState.update(CONFIGURED_KEY, true);
}

const SCAN_CACHE_KEY = "devinExporter.scanCache";
let lastWalWarnCount = -1;

type ScanMeta = {
  title?: string; userCount: number; assistantCount: number; total: number;
  mtime: number; snippet?: string; hasWal: boolean;
};

async function scanSessions(): Promise<SessionInfo[]> {
  const dbs = findDatabases();
  if (!dbs.length) {
    vscode.window.showWarningMessage("没有找到 Devin ACP 数据库。可在设置 devinExporter.databaseDirectory 中指定目录。");
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
    title: "正在扫描 Devin Sessions",
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
        console.warn(`跳过数据库 ${dbPath}`, e);
      }
      progress.report({ message: `${++done}/${dbs.length}` });
    }));
  });
  await extensionContext.globalState.update(SCAN_CACHE_KEY, cache);
  console.log(`[Devin Session Exporter] 扫描完成：${found.length} 个会话，缓存命中 ${cacheHits}/${dbs.length}`);
  const walCount = found.filter(s => s.hasWal).length;
  if (walCount && walCount !== lastWalWarnCount) {
    lastWalWarnCount = walCount;
    vscode.window.showWarningMessage(
      `${walCount} 个会话的数据库有未落盘的最新消息（WAL），导出的内容可能不完整。建议先重启 Devin 或稍后再导出。`
    );
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  cachedSessions = found;
  sessionsProvider?.setSessions(found);
  return found;
}

const SORT_DESC_KEY = "devinExporter.sessionSortDesc";

type SessionPick = vscode.QuickPickItem & { session: SessionInfo };

async function selectSessions(sessions: SessionInfo[]): Promise<SessionInfo[] | undefined> {
  let sortDesc = extensionContext.globalState.get<boolean>(SORT_DESC_KEY, true);
  const btnDesc: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("arrow-down"), tooltip: "当前：按修改时间新→旧（点击切换为旧→新）" };
  const btnAsc: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("arrow-up"), tooltip: "当前：按修改时间旧→新（点击切换为新→旧）" };

  const btnAll: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("checklist"), tooltip: "全选 / 全不选" };

  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick<SessionPick>();
    qp.canSelectMany = true;
    qp.title = "选择要导出的 Session";
    qp.placeholder = "支持多选；输入可筛选标题、ID 或路径";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    const render = () => {
      const keep = new Set((qp.selectedItems ?? []).map(i => i.session.id));
      const sorted = [...sessions].sort((a, b) => sortDesc ? b.mtime - a.mtime : a.mtime - b.mtime);
      qp.items = sorted.map(s => ({
        label: `${s.hasWal ? "$(warning) " : ""}${s.title || s.snippet || s.id}`,
        description: `用户 ${s.userCount} 条 · Devin ${s.assistantCount} 条 · ${ago(s.mtime)}`,
        detail: `ID: ${s.id}\n${s.dbPath}${s.snippet ? `\n首条消息：${s.snippet}` : ""}`,
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
  let walSkipped = 0;
  const failures: string[] = [];
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "正在导出 Devin Sessions",
    cancellable: false
  }, async progress => {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      progress.report({ message: `${i + 1}/${sessions.length}` });
      // Re-check WAL state at export time — the scan-time flag can be stale
      // (Devin may have checkpointed the WAL since the last scan).
      const walStat = await fs.promises.stat(`${s.dbPath}-wal`).catch(() => undefined);
      const hasWalNow = !!walStat && walStat.size > 0;
      if (hasWalNow && !options.forceExportWal) {
        walSkipped++;
        continue;
      }
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
    console.warn("[Devin Session Exporter] 导出失败：\n" + failures.join("\n"));
    const detail = failures.slice(0, 3).join("\n") + (failures.length > 3 ? `\n…共 ${failures.length} 条` : "");
    const act = await vscode.window.showErrorMessage(
      `${failures.length} 个会话导出失败`,
      "查看详情", "复制详情"
    );
    if (act === "查看详情") {
      vscode.window.showInformationMessage(detail, { modal: true });
    } else if (act === "复制详情") {
      await vscode.env.clipboard.writeText(failures.join("\n"));
    }
  }
  const skippedTotal = skipped + walSkipped;
  if (!allFiles.length && skippedTotal) {
    vscode.window.showInformationMessage(
      `没有需要导出的新消息，${skippedTotal} 个会话已跳过${walSkipped ? `（其中 ${walSkipped} 个含未落盘 WAL 数据，可在设置中开启"强制导出 WAL 会话"）` : ""}。`
    );
    return;
  }
  const notes = [
    skipped ? `${skipped} 个无新消息` : "",
    walSkipped ? `${walSkipped} 个含 WAL 数据` : ""
  ].filter(Boolean).join("、");
  const skipNote = notes ? `，跳过 ${notes}` : "";
  const single = allFiles.length === 1;
  const action = await vscode.window.showInformationMessage(
    `导出完成：${sessions.length - skippedTotal - failures.length} 个 Session，${allFiles.length} 个文件${skipNote}。目录：${outputDir}`,
    ...(single ? ["打开文件", "复制内容", "打开导出目录"] : ["打开导出目录"])
  );
  if (action === "打开文件") await vscode.window.showTextDocument(vscode.Uri.file(allFiles[0]));
  else if (action === "复制内容") {
    await vscode.env.clipboard.writeText(await fs.promises.readFile(allFiles[0], "utf8"));
    vscode.window.showInformationMessage("已复制导出内容到剪贴板。");
  }
  else if (action) await vscode.commands.executeCommand("devinExporter.openFolder");
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
  qp.title = "搜索会话内容";
  qp.placeholder = `正在加载会话 0/${sessions.length}…`;
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
        description: message.role === "user" ? "用户" : message.role === "assistant" ? "Devin" : message.kind,
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
      qp.placeholder = `已加载 ${loaded}/${sessions.length} 个会话，输入关键词实时搜索，勾选导出`;
      applyFilter();
    }
    qp.busy = false;
    if (!loaded) qp.placeholder = "没有可搜索的消息";
  })();

  await done;
}

async function previewSession(s: SessionInfo): Promise<void> {
  const options = readOptions();
  let prepared: ExportMessage[];
  try {
    prepared = prepareMessages(await sessionMessages(s), options);
  } catch (e) {
    vscode.window.showErrorMessage(`无法读取会话：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "devinSessionPreview",
    `预览：${s.title || s.snippet || s.id}`,
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
    item.description = `用户${s.userCount} · Devin${s.assistantCount} · ${ago(s.mtime)}`;
    item.tooltip = new vscode.MarkdownString(
      `**ID**: \`${s.id}\`\n\n\`${s.dbPath}\`${s.snippet ? `\n\n> ${s.snippet}` : ""}${s.hasWal ? `\n\n$(warning) 有未落盘的最新消息` : ""}`
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
        vscode.window.showInformationMessage("没有识别到可导出的 Session。");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `即将导出全部 ${sessions.length} 个会话到 ${getExportDirectory()}，确认继续？`,
        { modal: true },
        "导出"
      );
      if (confirm === "导出") await doExport(sessions);
    }),
    vscode.commands.registerCommand("devinExporter.toggleSetting", async (key: string) => {
      const c = vscode.workspace.getConfiguration("devinExporter");
      await c.update(key, !c.get<boolean>(key, boolSettingDefault(key)), vscode.ConfigurationTarget.Global);
      await context.globalState.update(CONFIGURED_KEY, true);
    }),
    vscode.commands.registerCommand("devinExporter.editSetting", async (key: string, prompt: string) => {
      const c = vscode.workspace.getConfiguration("devinExporter");
      const value = await vscode.window.showInputBox({
        title: `设置 ${key}`,
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
      else vscode.window.showInformationMessage("没有识别到包含 user_message / agent_message 文本的 Session。");
    }),
    vscode.commands.registerCommand("devinExporter.exportSelected", async () => {
      const sessions = cachedSessions.length ? cachedSessions : await scanSessions();
      if (sessions.length) await doExport((await selectSessions(sessions)) || []);
    }),
    vscode.commands.registerCommand("devinExporter.configureExport", async () => {
      const options = await configureAndGetOptions();
      if (!options) return;
      await persistOptions(options);
      vscode.window.showInformationMessage("导出偏好已保存，后续导出将直接使用这些设置。");
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
    }),
    vscode.commands.registerCommand("devinExporter.searchMessages", searchMessagesCommand),
    vscode.commands.registerCommand("devinExporter.previewSession", async (item?: SessionInfo) => {
      const s = item ?? (await selectSessions(cachedSessions.length ? cachedSessions : await scanSessions()))?.[0];
      if (s) await previewSession(s);
    }),
    vscode.commands.registerCommand("devinExporter.copySessionId", async (item: SessionInfo) => {
      await vscode.env.clipboard.writeText(item.id);
      vscode.window.showInformationMessage(`已复制 Session ID：${item.id}`);
    }),
    vscode.commands.registerCommand("devinExporter.revealDatabase", async (item: SessionInfo) => {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(item.dbPath));
    })
  );
}

export function deactivate() {}