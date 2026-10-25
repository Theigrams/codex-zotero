# OpenAI MCP Extensions 适配

2026-10-25 核对 npm `latest` 与 `openai/mcp-extensions` 的 `main`：均为 `0.2.1`，仓库提交 `36f8b38df179144b44d157133bbc5f7c6e353ace`。本次补齐该版能力；没有虚构版本升级。保留 SDK 声明兼容的 MCP Apps 1.7.5 / MCP SDK 1.32.1，服务端设置与 mentions 使用官方 helper 并通过真实 MCP 传输测试。单独升级到 MCP Apps 2.x 不属于此兼容组合。

| 能力 | 阅读器中的行为 |
| --- | --- |
| Global entrypoint | 侧栏「Zotero 文库」，进入搜索和在读列表 |
| Thread entrypoint | 对话内打开「Zotero 阅读器」，保留现有 `reader_open` |
| File entrypoint | PDF 文件可选择本阅读器；只使用宿主传入的已授权路径，不把 opaque resource URI 当路径 |
| Deep links | 论文菜单复制当前位置链接；打开链接可恢复论文、PDF 页码和区域，支持初次打开及后续激活 |
| Structured settings | 原生插件设置提供本地版面、模型 OCR、渲染模式；专用设置弹窗填写密钥、批注、快捷键等，不会替换活动阅读器 |
| Model context | 文字、类型、页码、图片缩略图与分组；宿主删除同步；使用 updateId 区分自己发布的旧确认与用户移除操作 |
| Message | 选区提问可选当前/新对话，再点发送/草稿；新对话附带上下文块。草稿不触发发送；不支持扩展时隐藏草稿和目标选择，不回退成发送 |
| Composer mentions | @ 输入框可检索 Zotero 论文；空查询显示在读论文。资源读取只返回元数据及按需阅读提示 |
| Extended forms | `reader_choose` 可请求原生单选论文表单；取消不打开论文，无表单能力时返回候选列表 |
| Open local file | 论文菜单「打开原 PDF」，通过 `files.open` 使用服务端返回的原文件路径 |
| Resource subscriptions | 文件入口订阅原资源，宿主通知文件更新后重新打开 PDF，指纹变化使旧 OCR 缓存不再复用 |
| WebMCP | `document.modelContext` 中注册当前视图、跳页、选择/加入版面块、移除上下文操作；没有该 API 的宿主保留服务端工具 |
| Display modes | 在资源元数据及 App capabilities 声明 inline/fullscreen；遵循官方建议，使用宿主显示模式按钮 |
| Styling | 内联官方扩展样式，应用宿主主题、样式变量、安全区和光标偏好；原 PDF 页面保持原始外观 |
| Onboarding | manifest 指向打包的 setup skill，说明本地 Zotero、版面环境及可选 MinerU 配置，不自动启动云端识别 |

原生设置与面板设置共用同一份偏好；活动面板轮询偏好版本，避免打开原生设置后旧界面仍使用过期值。密钥不进入原生 primitive settings 的 schema/values，仅通过 App 专用密码输入界面保存。

`ui/message` 的附件和 `ui/update-model-context` 的附件生命周期不同：消息草稿中的附件不会被当作新的“已加入上下文”页面标记，也不声称能收到其移除通知。每个 App 发布自己的上下文集合；不存在跨对话“全文已读”全局记录。

PDF 文件入口是只读阅读器，不调用资源写回 API，也不把 Zotero 批注写入原 PDF。它使用官方专门为大文件定义的“App 工具调用携带 `openai/resource.path`”路径，避免把整个 PDF 往返 base64 传输。宿主缺少授权路径时明确报错；订阅由资源 API 承担。取消订阅和 WebMCP 工具注销随面板卸载执行。

当前仍只有一个活动阅读面板；打开新的阅读面板时原面板会提示已移至新面板。设置弹窗不参与活动阅读面板切换。

验证：`npm test`；`test/extensions-server.mjs --pdf FILE` 检查实际 stdio MCP 入口、settings resource、路径授权和引用资源；`test/extensions-preflight.mjs --pdf FILE` 使用官方 AppBridge 检查草稿、上下文、文件按钮、深链接、主题、安全区、窄面板、设置同步与 WebMCP。测试不会向真实对话发送消息，也不向云端上传论文。

参考：[官方 Extensions 文档](https://developers.openai.com/plugins/build/extensions)、[UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui)、[协议](https://github.com/openai/mcp-extensions/blob/36f8b38df179144b44d157133bbc5f7c6e353ace/docs/spec.md)、[集成模式](https://github.com/openai/mcp-extensions/blob/36f8b38df179144b44d157133bbc5f7c6e353ace/docs/patterns.md)。
