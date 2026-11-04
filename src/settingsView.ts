import * as vscode from "vscode";

type Node = { item: vscode.TreeItem; children?: Node[] };

const BOOL_GROUPS: Array<{ section: string; icon: string; items: Array<{ key: string; label: string; def: boolean }> }> = [
  {
    section: "消息类型", icon: "filter",
    items: [
      { key: "includeUser", label: "用户消息", def: true },
      { key: "includeAssistant", label: "Devin 回复", def: true },
      { key: "includeThoughts", label: "Agent 思考", def: false },
      { key: "includeToolCalls", label: "工具调用", def: false },
      { key: "includeUnknown", label: "未识别类型", def: false }
    ]
  },
  {
    section: "输出格式", icon: "file",
    items: [
      { key: "writeMarkdown", label: "Markdown", def: true },
      { key: "writeHtml", label: "HTML 单文件网页", def: false },
      { key: "writeJson", label: "JSON", def: true }
    ]
  },
  {
    section: "Markdown 显示", icon: "markdown",
    items: [
      { key: "showSessionInfo", label: "Session 信息头", def: true },
      { key: "showRoleHeading", label: "角色标题", def: true },
      { key: "showTimestamp", label: "时间戳", def: true }
    ]
  },
  {
    section: "行为", icon: "settings-gear",
    items: [
      { key: "incrementalExport", label: "增量导出", def: false },
      { key: "forceExportWal", label: "强制导出 WAL 会话", def: false }
    ]
  }
];

const TEXT_SETTINGS: Array<{ key: string; label: string; prompt: string }> = [
  { key: "filenameTemplate", label: "文件名模板", prompt: "支持 {sessionId}、{date}、{index}、{name}" },
  { key: "userLabel", label: "用户显示名", prompt: "Markdown/HTML 中用户消息的显示名" },
  { key: "assistantLabel", label: "Devin 显示名", prompt: "Markdown/HTML 中 Devin 消息的显示名" },
  { key: "exportDirectory", label: "导出目录", prompt: "留空使用 Documents/Devin-Exports" },
  { key: "databaseDirectory", label: "数据库目录", prompt: "留空自动检测 %APPDATA%/Devin" }
];

const ACTIONS: Array<{ label: string; icon: string; command: string }> = [
  { label: "扫描并导出会话…", icon: "play", command: "devinExporter.scanAndExport" },
  { label: "导出全部会话", icon: "export", command: "devinExporter.exportAll" },
  { label: "搜索会话内容…", icon: "search", command: "devinExporter.searchMessages" },
  { label: "打开导出目录", icon: "folder-opened", command: "devinExporter.openFolder" }
];

export function boolSettingDefault(key: string): boolean {
  for (const g of BOOL_GROUPS) {
    const found = g.items.find(s => s.key === key);
    if (found) return found.def;
  }
  return false;
}

export class SettingsProvider implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.item;
  }

  getChildren(element?: Node): Node[] {
    if (element) return element.children ?? [];
    return this.buildTree();
  }

  private buildTree(): Node[] {
    const c = vscode.workspace.getConfiguration("devinExporter");
    const green = new vscode.ThemeColor("charts.green");
    const gray = new vscode.ThemeColor("descriptionForeground");

    const section = (label: string, icon: string, children: Node[]): Node => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(icon);
      return { item, children };
    };
    const leaf = (label: string, icon: vscode.ThemeIcon, command?: vscode.Command, description?: string, tooltip?: string): Node => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = icon;
      if (command) item.command = command;
      if (description) item.description = description;
      if (tooltip) item.tooltip = tooltip;
      return { item };
    };

    const actions = section("操作", "rocket", ACTIONS.map(a =>
      leaf(a.label, new vscode.ThemeIcon(a.icon), { command: a.command, title: a.label })
    ));

    const groups = BOOL_GROUPS.map(g => section(g.section, g.icon, g.items.map(({ key, label }) => {
      const v = c.get<boolean>(key, boolSettingDefault(key));
      return leaf(
        label,
        new vscode.ThemeIcon(v ? "pass-filled" : "circle-large-outline", v ? green : gray),
        { command: "devinExporter.toggleSetting", title: label, arguments: [key] },
        v ? "开" : "关"
      );
    })));

    const params = section("参数", "symbol-field", TEXT_SETTINGS.map(({ key, label, prompt }) => {
      const v = c.get<string>(key, "").trim();
      return leaf(
        label,
        new vscode.ThemeIcon("edit", gray),
        { command: "devinExporter.editSetting", title: label, arguments: [key, prompt] },
        v || "默认",
        `${label}: ${v || "（未设置）"}`
      );
    }));

    return [actions, ...groups, params];
  }
}
