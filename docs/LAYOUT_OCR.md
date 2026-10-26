# 版面块与按需 OCR

## 交互

- 顶栏「版面」默认开启。鼠标悬停显示不填色的虚线框和块类型：段落蓝、公式紫、图片青绿、表格赭黄；选中块改用不填色的实线框。保存高亮后才整块填充批注颜色。单击选择整个段落、公式、表格或图片。双击选词、拖选、⌥ 框选和已有批注操作继续有效。关闭「版面」后只保留原有选择方式。
- 选区工具条「加入上下文」把该块添加到当前 ChatGPT 对话的上下文，不自动发送问题。⇧ 单击版面块可直接加入。最多同时保留 8 块，可跨页、跨论文；底部条目可逐个移除或清空。再次加入相同块会去重。已加入的块保留虚线边框和定位编号，编号与底部条目、ChatGPT 附件标题一致；删除其他块不会重排其编号。点击底部条目可跨页、跨论文定位，点页面编号聚焦对应条目。宿主移除附件后同步删除页面标记。底部条目使用「定位图标 + 编号 + P页码」的紧凑样式，完整来源及类型放在悬停提示中。每个上下文从不重复的调色板随机分配颜色，底部编号与页面定位标记保持一致；颜色随上下文保存，不随翻页、缩放或删除其他块改变。页面定位标记旁也提供移除按钮，同步移除底部条目和宿主上下文。
- 内容保留论文、PDF 页序、块类型、文字来源、边界和原图缩略图。原图用于核对公式或扫描结果。视觉边界和引用页序都使用原 PDF，不受裁边、缩放影响。
- 顶栏「OCR」只有「识别整篇」；已有完整结果时显示「重新识别整篇」。后台任务可取消。完整结果就绪后自动用于全文、搜索和版面块，不再提供原文/OCR 来源切换。顶栏状态变为「全文」。
- 整篇仍按每批最多 200 页处理，每片不得超过 200 MB；所有批次就绪后一次性提交新版本。取消或失败保留上一份完整结果。旧单页缓存不会冒充全文，也不会使新旧来源混用。
- 版面块直接采用完整 MinerU 结果的边界、类别、文字；只有缺少可用边界的页面才回退本地检测。原有逐字拖选保留 PDFKit/MuPDF 的真实字形坐标，不伪造 OCR 字符位置。
- 全文统一由模型按当前问题决定是否读取，不提供读取时机选项，也不在首次提问时强制读取。「允许模型按需识别」位于全局设置，对所有论文生效；配置 MinerU API key 后默认开启，显式关闭后会一直保留关闭状态。模型按任务需要决定是否上传；已有完整结果直接复用。论文 OCR 面板不再显示权限开关。

## 全文进入对话的方式

公开 MCP 工具 `paper_full_text` 返回带 PDF 页序的 MinerU 全文；`ocr_status` 只返回可用性、版本、页数、字符数、识别权限和任务进度；`ocr_start` 只识别整篇，完整缓存/运行中的任务直接复用，不重复上传。面板明确点击「重新识别」才能强制更新完整缓存。

阅读器通过 `ui/update-model-context` 发布的始终是短引用（文档 id、版本、字符数和按需读取说明），不会在翻页、框选、重新挂载时反复发送全文。模型在问题需要全文时，通过工具把正文带入当前对话历史，之后直接复用。

`knownVersion` 是调用者对**当前对话已完整读取该版本**的声明：相同时返回 `unchanged` 和短状态，不再附正文。服务器不记录全局“已发送”，因此另一个对话仍能正常读取。长文默认每次最多 40000 字符，上限 60000；沿 `nextOffset` 继续并携带 `version`，防止跨版本拼接；直到 `nextOffset=null` 才算全文。正文只放进文本结果，不在结构化结果中重复一份。上下文压缩后若丢失所需原文，允许重新读取或按页读取。

**一次读取的边界：** 当前 MCP Extensions 没有主输入框的可靠发送回执，也没有可用于此目的的稳定对话 id；context changed/clear 不能证明用户已发送。因而不以 localStorage、全局变量或“附件被清空”伪造 exactly-once。按需读取与跨轮复用由短引用、技能和工具说明共同指导模型；服务器保证携带相同 `knownVersion` 时不重复返回正文，不能保证模型在任意宿主中都不省略此参数。这是模型驱动的读取策略，不是静默向主输入框注入附件。

## 分离的处理路径

**默认不请求云端：** PDFKit 渲染 → PP-DocLayoutV2 本地 ONNX 检测 → PyMuPDF 在框内提取文字。模型只识别位置、类别和顺序，不执行 OCR；模型缺失时回退原生文本/图片块并显示提示。

**明确触发的整篇 OCR：** 本机切片 → MinerU v4 `file-urls/batch` → PUT 到签名地址 → `extract-results/batch` 轮询 → 内存解包结构化内容 → 全文验证 → 原子提交。`model_version=vlm`、`is_ocr=true`，开启公式和表格。支持 content-list v1/v2 与旧版 middle.json；保留原 PDF 页序和点坐标。取消可阻止提交，但不保证撤回已上传的远端任务。

完整缓存保存于文档指纹目录的 `ocr-v1.json`，兼容已有完整结果并忽略旧版手动来源字段；模型识别权限保存在全局 `preferences.json` 的 `allowModelOcr` 字段，旧的单篇 `analysis-settings.json` 被忽略。不覆写 PDF、Zotero 附件或本机文字缓存。旧版“首次提问读取”设置被忽略。不存储跨对话的“已读”标记。正文与版本在本地内存复用，磁盘文件变更时失效。

## 安装与配置

```sh
npm install
npm run setup-analysis
# 在阅读器「设置 → MinerU 识别」填写 API key
npm run install-plugin
```

`setup-analysis` 安装独立 Python 环境，下载约 204 MiB 的 PP-DocLayoutV2 ONNX 文件并核验 SHA-256。模型不进 Git、不打包进插件。环境默认是 `~/.codex/codex-zotero-runtime`，模型默认是 `~/.cache/codex-zotero/models/pp-doclayout-v2.onnx`。可用 `CODEX_ZOTERO_PYTHON` 和 `CODEX_ZOTERO_LAYOUT_MODEL` 指定兼容路径。

阅读器全局设置提供密码输入框，保存后清空，只显示配置状态。`mineru_configure` 仅对 App 开放，不对模型开放；只写入 `~/.codex/codex-zotero/mineru-secret.json`（权限 0600）。也保留 `npm run configure-mineru` 和服务端 `MINERU_API_KEY` 环境变量。设置中保存的密钥优先于环境变量，便于直接更换。密钥仅在填写和保存请求期间经过页面与 App 专用工具，不返回给页面、不加入模型上下文，不写入 `preferences.json` 或 Git。保存不会自动上传论文；“已配置”表示已保存，不表示已验证远端额度或有效性。生产默认固定使用 `https://mineru.net/api/v4/`；`CODEX_ZOTERO_MINERU_API` 仅供开发/自托管测试覆盖，不能通过 UI 或模型工具修改。

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

单元测试覆盖 OCR 页码/坐标、旧新结果格式、凭据边界、整篇原子提交、分页切片、取消、旧缓存迁移、模型识别权限、全文分页与版本去重。交互预检使用真实本地版面模型、模拟 MinerU、独立状态目录，验证无自动上传、块附件、宿主移除、整篇任务、自动来源、短引用/全文工具、模型权限和窄窗口布局；不使用真实 key、不写真实文库。
