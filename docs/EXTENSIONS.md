# OpenAI MCP Extensions 适配

2026-10-25 核对 npm `latest` 与 `openai/mcp-extensions` 的 `main`：均为 `0.2.1`，仓库提交 `36f8b38df179144b44d157133bbc5f7c6e353ace`。本次补齐该版能力；没有虚构版本升级。保留 SDK 声明兼容的 MCP Apps 1.7.5 / MCP SDK 1.32.1，服务端设置与 mentions 使用官方 helper 并通过真实 MCP 传输测试。单独升级到 MCP Apps 2.x 不属于此兼容组合。

| 能力 | 阅读器中的行为 |
| --- | --- |
| Global entrypoint | 侧栏「Zotero 文库」，进入搜索和在读列表；快捷操作「继续阅读」恢复最近的论文/笔记，无标签时显示文库 |
| Thread entrypoint | 对话内打开「Zotero 阅读器」，保留现有 `reader_open` |
| File entrypoint | PDF 文件可选择本阅读器；只使用宿主传入的已授权路径，不把 opaque resource URI 当路径 |
| Deep links | 论文菜单复制当前位置链接；打开链接可恢复论文、PDF 页码和区域，支持初次打开及后续激活 |
| Structured settings | 原生插件设置提供本地版面、模型 OCR、渲染模式；专用设置弹窗填写密钥、批注、快捷键等，不会替换活动阅读器 |
| Model context | 文字、类型、页码、图片缩略图与分组；宿主删除同步；使用 updateId 区分自己发布的旧确认与用户移除操作 |
| Message | 当前对话只有原生输入框：去提问只更新上下文，不调用消息接口、不追加默认问题。菜单「在新对话中讨论」才显式创建带论文引用和已选块的草稿，始终 send:false；无扩展能力时隐藏此入口 |
| Composer mentions | @ 输入框可检索 Zotero 论文；空查询显示在读论文。资源读取只返回元数据及按需阅读提示 |
| Extended forms | `reader_choose` 单选；`research_choose` 原生多选文献，支持封面缩略图、独立翻页预览、目标建议和自定义目标。取消不选择，不支持时回退候选列表 |
| Open local file | 论文菜单「打开原 PDF」，通过 `files.open` 使用服务端返回的原文件路径 |
| Resource subscriptions | 文件入口订阅原资源，宿主通知文件更新后重新打开 PDF，指纹变化使旧 OCR 缓存不再复用 |
| WebMCP | 注册当前页/全文/批注及所选研究文献的只读读取工具，保留视图、跳页、选择/移除操作。返回正文 content，不只返回元数据；无此 API 时仍依赖服务端工具 |
| Display modes | 完整阅读器仅声明 fullscreen，并以 fullscreen 为首选；设置页独立支持 inline/fullscreen。提问先同步上下文，保持阅读器展开 |
| File download | 论文菜单「导出上下文」通过标准 MCP Apps downloadFile 保存 Markdown，包含已选块、来源和可回到原文的深链接；按宿主能力显示，取消不移除上下文 |
| Styling | 内联官方扩展样式，应用宿主主题、样式变量、安全区和光标偏好；原 PDF 页面保持原始外观 |
| Onboarding | manifest 指向打包的 setup skill，说明本地 Zotero、版面环境及可选 MinerU 配置，不自动启动云端识别 |

阅读器不再提供独立的问题输入框、发送按钮或当前对话草稿按钮，避免与用户正在编辑的原生草稿竞争。「加入上下文」保持阅读状态；「去提问」幂等地加入当前选区，等上下文发布完成后提示使用原生对话框。提问保持 fullscreen，不再请求折叠到 inline。问题内容和发送时机始终由原生对话框控制；准备上下文不会被记录为已经提问。

完整阅读器使用 `fullscreen`，资源元数据与 App 初始化能力保持一致；UI resource 更新为 `reader-v5.html`，避免复用旧显示声明。`inline` 指对话内嵌，不能将它称作原生侧边分栏；只在独立设置页保留。当前官方协议没有设置对话框停靠位置或强制聚焦输入框的接口，也不提供可用于这里的 `pip`。所有 entrypoint 仍由宿主以 fullscreen 打开。

原生设置与面板设置共用同一份偏好；活动面板轮询偏好版本，避免打开原生设置后旧界面仍使用过期值。密钥不进入原生 primitive settings 的 schema/values，仅通过 App 专用密码输入界面保存。

`ui/message` 的附件和 `ui/update-model-context` 的附件生命周期不同：消息草稿中的附件不会被当作新的“已加入上下文”页面标记，也不声称能收到其移除通知。每个 App 发布自己的上下文集合；不存在跨对话“全文已读”全局记录。

PDF 文件入口是只读阅读器，不调用资源写回 API，也不把 Zotero 批注写入原 PDF。它使用官方专门为大文件定义的“App 工具调用携带 `openai/resource.path`”路径，避免把整个 PDF 往返 base64 传输。宿主缺少授权路径时明确报错；订阅由资源 API 承担。取消订阅和 WebMCP 工具注销随面板卸载执行。

当前仍只有一个活动阅读面板；打开新的阅读面板时原面板会提示已移至新面板。设置弹窗和独立资源预览不参与活动阅读面板切换。

验证：`npm test`；`test/extensions-server.mjs --pdf FILE` 检查实际 stdio MCP 入口、settings resource、路径授权和引用资源；`test/extensions-preflight.mjs --pdf FILE` 使用官方 AppBridge 检查草稿、上下文、文件按钮、深链接、主题、安全区、窄面板、设置同步与 WebMCP。测试不会向真实对话发送消息，也不向云端上传论文。

参考：[官方 Extensions 文档](https://developers.openai.com/plugins/build/extensions)、[UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui)、[协议](https://github.com/openai/mcp-extensions/blob/36f8b38df179144b44d157133bbc5f7c6e353ace/docs/spec.md)、[集成模式](https://github.com/openai/mcp-extensions/blob/36f8b38df179144b44d157133bbc5f7c6e353ace/docs/patterns.md)。


## SDK 能力复核与未使用项（2026-10-25）

逐项检查官方 TypeScript `app` / `server` exports、`docs/spec.md`、`docs/patterns.md` 和 Bits & Bolts 示例。npm latest 与 GitHub main 仍是 0.2.1；本次没有升级依赖版本。

| 能力 | 当前覆盖 / 后续判断 |
| --- | --- |
| 全局入口快捷操作、入口图标 | 本次补齐继续阅读，及浅色/深色书本图标。快捷操作是 SDK/示例已有能力；图标通过 serverInfo 提供（当前 MCP SDK 1 的高层工具注册不传递单工具 icons）。宿主是否展示由其实现决定。延迟收到恢复结果时也会切换到目标标签 |
| 标准 MCP Apps 文件下载 | 本次补齐显式上下文 Markdown 导出。只导出已选择的摘录，不读取全文、不启动 OCR、不夹带图片 base64 或后台状态 |
| 表单描述、单选、取消、建议值 | reader_choose 用于单选消歧；research_choose 使用多选资源、目标建议/自由输入以及是否结合批注的开关。选择结果只接受候选资源 URI，拒绝未提供的文件路径 |
| 表单缩略图、资源选择、预览 | 已接入研究多选表单；一轮最多 12 个候选，封面并发为 2，复用低分辨率缓存。预览使用独立 UI 资源，不注册活动阅读器，也不触发 OCR |
| MRTR 多轮表单 | 尚未使用。当前服务端是 MCP SDK 1 的协议组合；需独立迁移与兼容测试，不能直接复制 SDK 2 示例 |
| 宿主管理资源的 read/write | 已通过宿主注入路径读取 PDF，订阅更新。write 未启用：当前文件入口是只读阅读器，批注写入 Zotero，不覆盖原 PDF |
| 原生 openLink | 已用于 DOI/外部链接；没有为研究内容增加额外重定向 |
| teardown / 生命周期 | 设置关闭、阅读器卸载保存位置、资源退订和 WebMCP 注销已接入 |
| 增量 toolinput / progress / cancellation | PDF 入口依赖完整工具结果；OCR 是显式后台任务，已有进度/取消机制。没有把长期 OCR 阻塞在工具调用中 |
| 宿主版本与能力 | 已按 message、modelContext、files、resources、downloadFile 能力降级。尚未增加硬性版本阻断；只判断版本会误伤有标准 MCP Apps 能力的兼容宿主 |
| 本地启动缓存 | 阅读位置、标签、OCR 缓存已由本地服务持久化。暂未在 localStorage 复制论文数据，避免缓存与真实文库状态分叉 |
| Chat/Work、聊天框停靠与拖动 | 当前 SDK 无公开控制接口，不能通过自定义字段实现 |

这里把“API 已导出”“插件已实现”“宿主实际展示”分开记录。自动化测试验证协议、菜单与状态流；不把模拟 AppBridge 的结果等同于原生宿主实测。


多篇研究的文献集合存放在当前 App 的 model context，复用 updateId 确认与宿主删除通知，不用全局“研究项目”覆盖其他对话。论文全文和评论正文不随翻页自动注入。当前论文的批注条数/版本随批注层更新；正文由 `research_annotations` 按需读取。批量任务与全文缓存按文档处理，但不同会话是否已读取仍由各自上下文决定。详见 [多篇研究说明](RESEARCH.md)。


公开读取工具现显式声明 model/app 可见性及只读、非破坏、封闭资源属性。Chat 能看到阅读器上下文不等于拥有 MCP 读取工具；已补充页面内只读入口，仍需目标宿主提供相应能力。见 [Chat 兼容性与验证](CHAT_COMPATIBILITY.md)。
