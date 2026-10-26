# 配置

## 设置（面板内 ⌘,）

| 项目 | 说明 |
|---|---|
| 渲染方式 | 像素对齐 + 近灰加深（默认，最锐利）/ 0.5 档渲染（边缘略柔和） |
| 批注颜色与标签 | 1–9 种，可增删、改名、换色（Zotero 预设色）；按键 1–9 依次对应，H 用第一种。标签叫「问答」的那一行是 Codex 存问答批注用的颜色 |
| 快捷键 | 点一项后按新组合键；冲突时互换。1–9、Esc、⌘C、⌘1–9 固定 |
| 论文地图 | 模型（默认 `gpt-6.1-sol`）、推理强度（低 / 中 / 高，默认中）、提示词 |
| 精读问题 | 导读时 Codex 带着读的问题；`##` 分组、`###` 问题标题、其下一段为问题全文 |
| 增强识别 | 总开关（默认关）、MinerU Key、自部署 MinerU 的地址与 Key（mineru-kit api-server，填服务根地址，须 https）、自部署失败时是否改用官方（默认否）。Key 存在 macOS 钥匙串；"测试连接"检查地址与 Key，不上传 |

设置保存在 `~/.codex/codex-zotero/preferences.json`，对所有论文生效。

## 环境变量

在**运行安装脚本之前**设置。Codex 启动插件服务时不会带上终端里的环境，所以安装脚本会把当时设置的 `CODEX_ZOTERO_*` 写进插件的启动配置（`.mcp.json`）。改了之后重新运行 `npm run install-plugin`，再 ⌘Q 重启 Codex。

| 变量 | 默认 | 作用 |
|---|---|---|
| `CODEX_ZOTERO_PYTHON` | 当前终端的 `python3` | 带 PyMuPDF 和 fontTools 的 Python，用于文字修复 |
| `CODEX_ZOTERO_CODEX` | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` | Codex CLI：安装插件、生成论文地图 |
| `CODEX_ZOTERO_NODE` | `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` | 运行插件服务的 Node（只在安装时使用，不写入启动配置） |
| `CODEX_ZOTERO_MAP_MODEL` | `gpt-6.1-sol` | 论文地图的默认模型（设置里填了模型时以设置为准） |
| `CODEX_ZOTERO_API` | `http://127.0.0.1:23119/api/` | Zotero 本地 API |
| `CODEX_ZOTERO_STATE` | `~/.codex/codex-zotero` | 阅读位置、标签页、设置、写入队列 |
| `CODEX_ZOTERO_CACHE` | `~/Library/Caches/codex-zotero` | 页面与文字缓存 |
| `CODEX_ZOTERO_SUPPORT` | `~/Library/Application Support/codex-zotero` | 增强识别结果（要再上传才能重建，不放缓存目录） |
| `CODEX_ZOTERO_HELPERS` | `4` | 并行的 PDFKit 辅助进程数 |
