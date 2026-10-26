# 第三方组件

## 随仓库分发

| 组件 | 用途 | 许可 |
|---|---|---|
| [Lora](https://github.com/cyrealtype/Lora-Cyrillic)（`fonts/`） | 笔记正文的拉丁字体 | SIL Open Font License 1.1，见 `fonts/Lora-OFL.txt` |

## 安装时由 npm 获取（打包进插件）

| 组件 | 用途 | 许可 |
|---|---|---|
| [KaTeX](https://katex.org) 0.16.22（含字体） | 笔记与评论中的公式 | MIT |
| [sanitize-html](https://github.com/apostrophecms/sanitize-html) 2.18.0 | 过滤 Zotero 笔记的 HTML | MIT |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) 1.32.1 | MCP 服务端 | MIT |
| [@modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) 1.7.5 | MCP 应用面板 | MIT |
| [zod](https://zod.dev) 4.3.6 | 工具参数校验 | MIT |

构建工具（不进插件）：esbuild（MIT）、puppeteer-core（Apache-2.0，仅预检使用）。

## 由用户自行安装

| 组件 | 用途 | 许可 |
|---|---|---|
| [PyMuPDF](https://pymupdf.readthedocs.io) | 可选的 PDF 文字修复 | GNU AGPL 3.0（或 Artifex 商业许可）。不随本仓库分发；插件通过独立的 Python 进程调用它 |
| Apple PDFKit | PDF 渲染 | macOS 系统框架 |

## Optional local layout and OCR integration

- `@openai/mcp-extensions` (Apache-2.0): OpenAI MCP Apps context/message capability adapters.
- `fflate` (MIT): in-memory reading of selected JSON members in MinerU result archives.
- PP-DocLayoutV2: PaddlePaddle's Apache-2.0 model, downloaded separately; weights are not redistributed in the plugin. The pinned ONNX artifact is hosted at `opendatalab/MinerU-4_models_onnx`, revision `358310b4f64b95f9fefc372ad899356e4111f376`, SHA-256 `cd540dc296ff3115fe78efa65b68501e6a8dc74b198acc9834a725ffaa095aac`.
- ONNX Runtime (MIT), NumPy (BSD), Pillow (HPND), and fontTools (MIT) are installed into the user's optional local Python environment. PyMuPDF's existing licensing note above still applies.
- The local inference wrapper is independently implemented against the published model contract. MinerU source was consulted, but its application code is not bundled. MinerU cloud OCR is an external service, enabled only by user action.
