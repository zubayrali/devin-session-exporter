import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";

export function findDatabases(): string[] {
  const cfg = vscode.workspace.getConfiguration("devinExporter");
  const configured = cfg.get<string>("databaseDirectory", "").trim();
  const appSupport =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const roots = configured
    ? [configured]
    : ["Devin", "devin"].map(name => path.join(appSupport, name, "User", "acp-messages"));
  const found: string[] = [];
  const visited = new Set<string>();

  const walk = (dir: string, depth: number) => {
    if (depth > 5 || !fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".db")) {
        const resolved = path.resolve(full);
        const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
        if (!visited.has(key)) {
          visited.add(key);
          found.push(resolved);
        }
      }
    }
  };
  roots.forEach(root => walk(root, 0));
  return found.sort();
}

export function getExportDirectory(): string {
  const configured = vscode.workspace.getConfiguration("devinExporter").get<string>("exportDirectory", "").trim();
  return configured || path.join(os.homedir(), "Documents", "Devin-Exports");
}