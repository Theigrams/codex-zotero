# 架构

## 总览

```
Codex 桌面版
├── 对话（模型）── 模型工具 ──┐
└── 面板（沙箱 iframe）── 面板工具 ──┤
                                    ▼
                        MCP 服务端（Node，Codex 自带）
                        ├── PDFKit 辅助进程 ×4（Swift，常驻）：渲染、字形、链接、目录
                        ├── 文字修复进程（Python + PyMuPDF，常驻，可选）
                        ├── Zotero 本地 API（http://127.0.0.1:23119）：读条目、PDF、批注、笔记；写批注与笔记
                        ├── Codex CLI（按需）：生成论文地图
                        └── 本机状态与缓存
```

## 各部分职责

| 部分 | 负责 | 不负责 |
|---|---|---|
| **面板**（`src/panel/`） | 布局与虚拟化、滚动与缩放、选区命中、批注即时上屏、快捷键、标签页、设置；把阅读状态同步给对话 | 渲染 PDF、访问 Zotero、调用模型 |
| **服务端**（`src/server/`） | 文档与缓存、条带渲染调度、文字合并、批注写入队列、笔记渲染、论文地图、导读与精读笔记、模型工具 | 界面 |
| **PDFKit 辅助进程**（`native/PDFKitHelper.swift`） | 按渲染方式渲染条带；逐字几何；链接与目标；正文边界；PDF 书签 | 文字内容修复 |
| **文字修复**（`native/text_*.py`） | 连字、嵌入字形名（Σ、Λ）等文字内容修复 | 显示 |
| **skill**（`skills/zotero-reader/`） | 告诉模型何时用哪个工具、怎么存问答、怎么导读 | — |

服务端与原生进程之间是 JSON-lines 协议；进程常驻，PDF 保持打开。

## 数据归属

| 数据 | 存放 |
|---|---|
| 批注、问答批注、笔记、论文地图、精读笔记 | Zotero（只经本地 API 读写，写入前需用户授权） |
| 阅读位置、标签页、设置、待写入队列、写入授权 | `~/.codex/codex-zotero` |
| 渲染条带与文字缓存（按 PDF 指纹） | `~/Library/Caches/codex-zotero` |

## 关键流程

- **打开论文**：模型调用 `reader_open`（唯一挂界面资源的工具，每次调用 Codex 会新建面板，旧面板自动让位）→ 服务端经 Zotero 找到 PDF → 面板按真实页面尺寸排好占位，先显示低清预览，再换清晰条带。
- **渲染**：PDFKit 渲染，图片以 base64 经工具调用传给面板（沙箱不允许 blob 与本机 URL）。两种方式可选：`aligned`（位图宽度 = 显示宽度 × 设备像素比，1:1 显示，只对近中性灰像素做 γ1.3 加深，默认）与 `rounded`（倍率取整到 0.5 档，由浏览器缩放）。
- **选区与提问**：命中判断在面板本地完成；"提问"把修复后的文字和原图裁片作为一条用户消息发到对话。面板随时把论文、页码、选区同步进对话上下文。
- **批注**：面板立即画出；服务端分配 Zotero key、写入队列持久化，失败按 2/5/15/30/60 秒退避重试；写入前读回 Zotero 中的当前值，被别处改过则标为冲突、不覆盖。面板每 3 秒按版本号增量刷新。
- **问答批注**：模型回答针对某处的问题后调用 `annotate`，同一处再问时相近的问题替换答案、不同的问题追加。
- **跳转**：模型调用 `show_location` → 服务端记录导航请求 → 面板轮询取到后滚动并闪框。
- **论文地图**：用户要求时，服务端准备结构索引与修复后的全文，调用 `codex exec` 生成 Markdown，转成 Zotero 笔记（公式为 Zotero 公式节点，页码与式、图、表转为 `zotero://open-pdf` 链接）。
- **导读与精读笔记**：模型用 `reading_guide` 读精读问题与已有笔记，一步步引导用户；每读完一个问题调用 `reading_note_save`，按节更新这篇论文的精读笔记，末尾记录阅读进度。
- **笔记显示**：服务端过滤 Zotero 笔记的 HTML，用 KaTeX 排版公式，交给面板显示。

## 工具

**模型工具**（`src/server/tools.mjs`）：`reader_state`、`paper_context`、`paper_outline`、`read_pages`、`find_in_paper`、`paper_map`、`paper_map_generate`、`reading_guide`、`reading_note_save`、`list_annotations`、`annotate`、`update_annotation`、`delete_annotation`、`search_annotations`、`read_notes`、`show_location`、`search_library`；打开论文用挂界面资源的 `reader_open`。

**面板工具**（`src/server/index.mjs` 的 `appTools`）：面板生命周期、标签页、渲染与文字、批注读写与撤销、笔记、设置等，只供面板调用。

## 本地开发模式

`node out/plugin/dist/server.mjs --standalone` 在本机起一个 HTTP 服务，用普通浏览器打开面板（模拟 Codex 的沙箱限制）；浏览器预检（`test/preflight.mjs`）就用这种方式，配合假 Zotero 与假 Codex CLI。
