import * as vscode from "vscode";

type Node = { item: vscode.TreeItem; children?: Node[] };

const BOOL_GROUPS: Array<{ section: string; icon: string; items: Array<{ key: string; label: string; def: boolean }> }> = [
  {
    section: "Message types", icon: "filter",
    items: [
      { key: "includeUser", label: "User messages", def: true },
      { key: "includeAssistant", label: "Devin messages", def: true },
      { key: "includeThoughts", label: "Devin thoughts", def: false },
      { key: "includeToolCalls", label: "Tool calls", def: false },
      { key: "includeUnknown", label: "Other kinds", def: false }
    ]
  },
  {
    section: "Output formats", icon: "file",
    items: [
      { key: "writeMarkdown", label: "Markdown", def: true },
      { key: "writeHtml", label: "HTML (single file)", def: false },
      { key: "writeJson", label: "JSON", def: true }
    ]
  },
  {
    section: "Markdown display", icon: "markdown",
    items: [
      { key: "showSessionInfo", label: "Session info header", def: true },
      { key: "showRoleHeading", label: "Role headings", def: true },
      { key: "showTimestamp", label: "Timestamps", def: true }
    ]
  },
  {
    section: "Behavior", icon: "settings-gear",
    items: [
      { key: "incrementalExport", label: "Incremental export", def: false }
    ]
  }
];

const TEXT_SETTINGS: Array<{ key: string; label: string; prompt: string }> = [
  { key: "filenameTemplate", label: "Filename template", prompt: "Tokens: {sessionId}, {date}, {index}, {name}" },
  { key: "userLabel", label: "User display name", prompt: "Label for user messages in exports" },
  { key: "assistantLabel", label: "Devin display name", prompt: "Label for Devin messages in exports" },
  { key: "exportDirectory", label: "Export directory", prompt: "Blank = Documents/Devin-Exports" },
  { key: "databaseDirectory", label: "Database directory", prompt: "Blank = auto-detect" }
];

const ACTIONS: Array<{ label: string; icon: string; command: string }> = [
  { label: "Scan & export sessions…", icon: "play", command: "devinExporter.scanAndExport" },
  { label: "Export all sessions", icon: "export", command: "devinExporter.exportAll" },
  { label: "Search messages…", icon: "search", command: "devinExporter.searchMessages" },
  { label: "Open export folder", icon: "folder-opened", command: "devinExporter.openFolder" }
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

    const actions = section("Actions", "rocket", ACTIONS.map(a =>
      leaf(a.label, new vscode.ThemeIcon(a.icon), { command: a.command, title: a.label })
    ));

    const groups = BOOL_GROUPS.map(g => section(g.section, g.icon, g.items.map(({ key, label }) => {
      const v = c.get<boolean>(key, boolSettingDefault(key));
      return leaf(
        label,
        new vscode.ThemeIcon(v ? "pass-filled" : "circle-large-outline", v ? green : gray),
        { command: "devinExporter.toggleSetting", title: label, arguments: [key] },
        v ? "On" : "Off"
      );
    })));

    const params = section("Parameters", "symbol-field", TEXT_SETTINGS.map(({ key, label, prompt }) => {
      const v = c.get<string>(key, "").trim();
      return leaf(
        label,
        new vscode.ThemeIcon("edit", gray),
        { command: "devinExporter.editSetting", title: label, arguments: [key, prompt] },
        v || "Default",
        `${label}: ${v || "(not set)"}`
      );
    }));

    return [actions, ...groups, params];
  }
}
