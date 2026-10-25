# 版面块与按需 OCR

## 交互

- 顶栏「版面」默认开启。鼠标悬停显示轻量边框和块类型；单击选择整个段落、公式、表格或图片。双击选词、拖选、⌥ 框选和已有批注操作继续有效。关闭「版面」后只保留原有选择方式。
- 选区工具条「加入上下文」把该块添加到当前 ChatGPT 对话的上下文，不自动发送问题。⇧ 单击版面块可直接加入。最多同时保留 8 块，可跨页、跨论文；底部条目可逐个移除或清空。再次加入相同块会去重。
- 内容保留论文、PDF 页序、块类型、文字来源、边界和原图缩略图。原图用于核对公式或扫描结果。视觉边界和引用页序都使用原 PDF，不受裁边、缩放影响。
- 顶栏「OCR…」打开独立面板，提供「识别本页」和「识别整篇」。只有明确点击才会向 MinerU 上传。任务异步执行，可继续阅读、查看进度或取消。
- 单页任务在本机先切出单页 PDF，只上传这一页；整篇按每批最多 200 页切片。每片仍须小于 200 MB，超过会给出错误，不悄悄缩小范围。
- OCR 完成后默认使用已识别页的结果。面板可切回「PDF 原文」。未识别的页继续用本机文字；识别失败或取消保留之前的缓存和阅读状态。
- 「块文字与全文读取」控制整块上下文与 `read_pages` / `find_in_paper` 的文字来源。原有逐字选择仍依据 PDFKit/MuPDF 的真实字形位置，不伪造 OCR 字符坐标。

## 分离的处理路径

**默认路径不请求云端：** PDFKit 渲染 → PP-DocLayoutV2 本地 ONNX 检测 → PyMuPDF 在框内提取文字。模型仅识别位置、类别和阅读顺序，不执行 OCR。模型尚未安装时退回 PyMuPDF 的原生文本/图片块，并显示提示，不将这种回退标成模型识别。

**用户触发的 OCR：** 在本机切片 → MinerU v4 `file-urls/batch` → PUT 到签名地址 → `extract-results/batch` 轮询 → 在内存中读取 ZIP 的结构化内容。`model_version=vlm`，`is_ocr=true`，公式和表格识别开启。支持 content-list v1/v2 与旧版 middle.json；规范化回原 PDF 页序和点坐标。任务最多等待 15 分钟，可取消；取消阻止迟到结果写入，已上传的远端任务不保证撤回。

布局和 OCR 分开缓存。OCR 不覆写原 PDF、Zotero 附件或本机原生文字缓存。版面缓存按 PDF 指纹和页面保存；OCR 结果与选用来源保存到该文档缓存内的 `ocr-v1.json`。上下文块归属当前会话，由 MCP 宿主保持，不写入 Zotero。

## 安装与配置

```sh
npm install
npm run setup-analysis
npm run configure-mineru
npm run install-plugin
```

`setup-analysis` 安装独立 Python 环境，下载约 204 MiB 的 PP-DocLayoutV2 ONNX 文件并核验 SHA-256。模型不进 Git、不打包进插件。环境默认是 `~/.codex/codex-zotero-runtime`，模型默认是 `~/.cache/codex-zotero/models/pp-doclayout-v2.onnx`。可用 `CODEX_ZOTERO_PYTHON` 和 `CODEX_ZOTERO_LAYOUT_MODEL` 指定兼容路径。

`configure-mineru` 交互式读取 key，不回显；只写入 `~/.codex/codex-zotero/mineru-secret.json`（权限 0600）。也支持服务端 `MINERU_API_KEY` 环境变量。key 不放在页面、tool 参数、`preferences.json` 或 Git 中。生产默认固定使用 `https://mineru.net/api/v4/`；`CODEX_ZOTERO_MINERU_API` 仅供开发/自托管测试覆盖，不能通过 UI 或模型工具修改。

`install-plugin` 会优先检测上述独立环境；更换运行路径后重新安装。服务代码更新后需完全退出并重启 Codex。

## MCP Apps 与 OpenAI 扩展

保留 `@modelcontextprotocol/ext-apps` 的 App bridge。使用 `@openai/mcp-extensions@0.2.1` 的 `OpenAIExtensions`，按 `modelContext`/`message` 能力探测，不按产品名分支。

- 当前页码/临时选区是 `annotations.audience: ["assistant"]` 的后台上下文。
- 显式加入的每个块是单独的文本附件，带 `openai/title`、`openai/group`、`openai/thumbnail`；支持图片上下文的宿主另附公式、表格、图片的原图。
- 每次发布包含完整的当前集合，因为 `ui/update-model-context` 会替换该 App 的上一次上下文。
- 响应宿主移除附件的 `hostcontextchanged` 通知，重新发布剩余集合。重挂载从宿主返回的上下文恢复条目。
- 不支持 OpenAI 扩展的宿主回退到标准 `updateModelContext` 文本内容，保留页码、类型、来源；不依赖图片支持。

开发时核对的来源（2026-10-25）：

- [OpenAI Plugin Extensions](https://developers.openai.com/plugins/build/extensions)
- [OpenAI MCP Apps UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui)
- [MCP Extensions SDK](https://github.com/openai/mcp-extensions/tree/36f8b38df179144b44d157133bbc5f7c6e353ace/typescript) 与 [协议](https://github.com/openai/mcp-extensions/blob/36f8b38df179144b44d157133bbc5f7c6e353ace/docs/spec.md)
- [MinerU API 文档](https://mineru.net/apiManage/docs)
- [MinerU 的 PP-DocLayoutV2 ONNX 实现](https://github.com/opendatalab/MinerU/blob/b7f3dd0c5f6e6d66a298239ffd02b328b873918e/mineru/model/layout/pp_doclayout_v2_onnx.py)
- [PaddlePaddle 模型说明](https://huggingface.co/PaddlePaddle/PP-DocLayoutV2)

## 验证

```sh
npm test
npm run build
CODEX_ZOTERO_PYTHON=~/.codex/codex-zotero-runtime/bin/python \
  node test/analysis-preflight.mjs --pdf /path/to/paper.pdf
```

单元测试覆盖 OCR 页码/坐标、旧新结果格式、凭据边界、显式启动、分页切片、取消、缓存与原文回退。交互预检使用真实本地版面模型、模拟 MinerU、独立状态目录，验证无自动上传、块附件、宿主移除、单页/整篇任务、来源切换、开关和窄窗口布局；不使用真实 key、不写真实文库。
