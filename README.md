# Devin Session Exporter

VS Code / Devin Desktop 扩展：扫描本地 Devin ACP SQLite 会话数据库，把选中的会话导出为 **Markdown / JSON / HTML**。

## 功能一览

### 侧边栏面板（活动栏聊天气泡图标）

- **Devin Sessions**：会话列表（标题、消息数、相对时间），自动按修改时间倒序；悬停显示 ID、路径、首条消息预览；标题栏有刷新按钮；每条会话有行内导出/预览按钮，右键可复制 Session ID、定位数据库文件；支持 Ctrl 多选后批量导出。
- **操作与设置**：常驻控制面板——
  - 操作：扫描并导出 / 导出全部（带确认） / 搜索会话内容 / 打开导出目录
  - 开关设置：消息类型×5、输出格式×3、Markdown 显示项×3、行为（增量导出、强制导出 WAL），单击即切换并持久化
  - 参数设置：文件名模板、用户/Devin 显示名、导出目录、数据库目录，点击弹输入框修改

### 导出

- 选择器：多选 + 实时筛选（标题/ID/路径）+ 排序切换按钮 + 全选按钮；无标题会话用首条用户消息兜底显示
- 输出格式：Markdown、JSON、自包含 HTML（聊天气泡样式、暗色自适应），可同时输出多种
- 消息类型：user_message / agent_message 默认导出；agent_thought、tool_call、未识别类型可选
- thought/tool/unknown 记录在 Markdown 中渲染为 `<details>` 折叠块、HTML 中为可展开区域，对话流保持干净
- 可配置：Session 信息头、角色标题、时间戳开关；自定义 `用户`/`Devin` 显示名；文件名模板支持 `{sessionId}`、`{date}`、`{index}`、`{name}`
- **增量导出**：记录每个会话已导出的最大 position，无新消息的会话自动跳过
- **WAL 处理**：数据库有未落盘 `-wal` 数据时（Devin 正在写入），默认跳过并在导出时实时复检；可在设置中开启"强制导出 WAL 会话"
- 单文件导出完成可直接"打开文件"或"复制内容"到剪贴板；单会话失败不中断批次

### 全文搜索

`Devin Export: Search Messages`：输入即搜（150ms 防抖、流式加载各库消息、150 条结果截断），命中消息显示会话名 + 角色 + 上下文片段，勾选后直接导出对应会话。

### 预览

`Devin Export: Preview Session` / 会话行内按钮：右侧 Webview 聊天气泡预览（与 HTML 导出共用渲染器），先看内容再决定导出。

### 配置向导

仅在**首次导出**（未配置过）时自动弹出五步引导：消息类型 → 输出格式 → 显示项 → 角色显示名 → 文件名模板；完成后持久保存，此后导出不再打扰。命令面板可主动运行 `Devin Export: Configure Export Content and Naming` 再走一遍。

### 性能

- 扫描只跑 `GROUP BY kind` 计数 + 标题读取，不解析 payload（解析推迟到导出选中会话时）
- 扫描结果按 `路径 + mtime + size + walSize` 缓存，复扫只处理变化的库
- `sql.js` wasm 实例全局复用；数据库文件并发读取
- Windows 下 `Devin`/`devin` 大小写路径去重，同 session ID 兜底去重

## 安装

```powershell
npm install
npm run compile
npx vsce package
```

生成 `devin-session-exporter-0.1.0.vsix`，在 Devin Desktop 中 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` 安装，然后 Reload Window。

## 命令

| 命令 | 说明 |
|---|---|
| `Devin Export: Scan Sessions and Export` | 扫描数据库，勾选会话后导出 |
| `Devin Export: Export Selected Sessions` | 复用上次扫描结果选择导出 |
| `Devin Export: Export All Sessions` | 导出全部（带确认） |
| `Devin Export: Search Messages` | 全文搜索消息内容 |
| `Devin Export: Preview Session` | 预览会话 |
| `Devin Export: Refresh Sessions` | 刷新会话列表 |
| `Devin Export: Export Session` | 导出指定会话（侧栏右键/行内按钮） |
| `Devin Export: Copy Session ID` | 复制 Session ID（侧栏右键） |
| `Devin Export: Reveal Database in Explorer` | 定位数据库文件（侧栏右键） |
| `Devin Export: Configure Export Content and Naming` | 配置向导 |
| `Devin Export: Open Export Folder` | 打开导出目录 |

## 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `devinExporter.databaseDirectory` | `""` | 数据库目录，留空自动检测 `%APPDATA%\Devin` |
| `devinExporter.exportDirectory` | `""` | 导出目录，留空用 `Documents/Devin-Exports` |
| `devinExporter.includeUser` / `includeAssistant` | `true` | 用户消息 / Devin 回复 |
| `devinExporter.includeThoughts` / `includeToolCalls` / `includeUnknown` | `false` | Agent 思考 / 工具调用 / 未识别类型 |
| `devinExporter.writeMarkdown` | `true` | 输出 Markdown |
| `devinExporter.writeJson` | `true` | 输出 JSON |
| `devinExporter.writeHtml` | `false` | 输出自包含 HTML |
| `devinExporter.showSessionInfo` / `showRoleHeading` / `showTimestamp` | `true` | 信息头 / 角色标题 / 时间戳 |
| `devinExporter.userLabel` / `assistantLabel` | `用户` / `Devin` | 角色显示名 |
| `devinExporter.filenameTemplate` | `{sessionId}` | 文件名模板 |
| `devinExporter.incrementalExport` | `false` | 跳过无新消息的会话 |
| `devinExporter.forceExportWal` | `false` | 强制导出含 WAL 未落盘数据的会话 |

## 实现说明

- 数据库结构：`messages(position, kind, payload)`，payload 为 ACP JSON；标题从名称含 `meta`/`info` 的表中提取，读不到时用首条用户消息兜底
- 仅提取 payload content 树中显式的 `type:"text"` 内容块；不导出 rawInput、命令参数等工具元数据
- 同一 `clientMessageId` 的用户分片合并；assistant 分片按 position 保留，避免误并不同回复
- `sql.js`（wasm SQLite）只读快照读库，不写入原数据库
- WAL 未 checkpoint 时，`-wal` 中的新消息不在 `.db` 主文件内——扩展会标记、警告并按配置跳过

## 环境要求

- Node.js 20+（构建）
- Devin Desktop 或 VS Code ≥ 1.85
- Windows 为主要目标平台（数据库目录可手动指定以适配其他平台）
