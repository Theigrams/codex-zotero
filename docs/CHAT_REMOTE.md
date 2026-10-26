# Chat 私有 MCP 桥接

此桥接通过 OpenAI Secure MCP Tunnel，把完整阅读器界面和按需读取工具一起提供给 ChatGPT 网页。调用 `reader_open` 会打开文库/阅读器，可搜索论文、选择段落或区域、加入上下文、高亮和评论；不需要先在本机面板中打开论文。全文仍由模型按需读取，不自动注入。

## 数据与连接路径

```text
Chat 中的私有远程插件
  → OpenAI Secure MCP Tunnel（账号/组织访问控制）
  → 本机 tunnel-client（主动向 OpenAI 发起 HTTPS 连接）
  → dist/chat-bridge.mjs（stdio MCP）
  → reader_open 返回 MCP App HTML；界面操作和模型读取分别路由
  → 当前用户私有 Unix socket
  → 隧道管理的专用阅读器后台 → Zotero API / MuPDF / MinerU 缓存与任务
```

PDF 与缓存继续存放在本机。模型请求读取时，正文/评论会通过隧道返回给 Chat；这不是“数据从不离开本机”。需要 OCR 时仍遵守现有全局许可，仅上传给已配置的 MinerU。隧道为网页管理一个专用阅读器后台，复用原有 PDF/OCR/批注代码与本机缓存。网页中的操作都进入该后台的同一任务队列，批注继续通过 Zotero API 保存；桌面阅读器通过 Zotero 版本检查与轮询看到变化。网页不直接访问 localhost 或本机文件，PDF 图片和文字通过有权限的工具返回。

桥接默认关闭。它只监听当前用户权限的 Unix socket，不创建 TCP/HTTP 公网监听，不需要为本机设置入站端口。网页连接使用独立 readerSession；模型必须携带上下文中的 readerSession，涉及文档的操作还必须提供 docId。专用后台意外退出后按需重启，恢复文档与界面状态，逻辑 readerSession 保持不变。整个桥接/隧道进程重启则产生新标识，旧卡片需要重新打开；不默默切换到另一个桌面对话。

## 分享给其他用户

本地插件可以通过仓库/安装包分享，每位用户在自己的机器、自己的 Zotero 和自己的 OpenAI 账号上配置。安装包不包含开发者的隧道 ID、运行密钥、MinerU key、文库路径或已生成的运行配置。

两种分发方式需要区分：

| 方式 | 用户需要做什么 | 当前范围 |
| --- | --- | --- |
| 本地阅读器 + 私有 Chat 连接 | 在自己的 Platform 创建/取得隧道权限，通过设置页连接 | 已实现本机管理与网页阅读器；每个账号仍需完成连接验收 |
| 所有人安装后直接登录的公共 Chat 插件 | 统一公网 MCP 服务、OAuth 登录、本机配对和严格用户隔离 | 未提供托管服务，不能用开发者个人隧道代替 |

私有隧道的创建需要 Tunnels Read + Manage，运行/使用需要 Tunnels Read + Use，并关联目标 ChatGPT 账号/工作区。没有这些权限的用户仍可使用本地阅读器，但不能据此保证其 Chat 能连接。账号授权与 Chat 中添加插件由 OpenAI 页面完成，设置页只提供入口，不自动代替用户授予权限。

## 普通用户设置流程

插件安装后，在阅读器设置或原生插件设置的「设置与连接」中打开 **Chat 私有连接 → 配置远程读取**。

1. 点击「打开隧道设置」和「创建运行密钥」，在自己的 Platform 账号取得隧道 ID 与运行密钥。
2. 填写隧道 ID、OpenAI 运行密钥，点击「保存配置」。密钥不是 MinerU key；以密码框填写，保存/关闭后清空，不回显已保存内容。
3. 点击「安装连接组件」。插件按本机架构下载官方 `tunnel-client` 最新正式版本，校验官方 SHA-256 后安装。这里只支持现有阅读器覆盖的 macOS Apple 芯片/Intel。
4. 点击「连接」。插件生成本机启动参数并使用官方受管运行方式启动，不需要自己写命令、路径或常驻脚本。
5. 点击「复制隧道 ID」和「打开 Chat 连接设置」，按下一节将同一个隧道加入 Chat，再实际读取一次正文验收。

「随阅读器自动连接」默认关闭，保存开启后会在后续阅读器服务启动时尝试恢复；一次连接失败不会进行无限重试。手动「断开」会同时关闭自动连接。关闭设置页不停止已经连接的后台进程。

「断开并清除本机凭据」先停止本插件管理的进程，确认停止后删除本机连接信息和运行密钥；不删除 OpenAI 上的隧道，也不影响其他软件的隧道。卸载脚本也先停止本插件的连接；普通卸载保留用户设置，`--all` 才清除全部阅读器状态。

## 状态与隐私

界面分别显示「待配置」「未安装连接组件」「正在连接」「隧道已就绪」「连接异常」。只有官方进程报告运行、健康且 ready，才显示「隧道已就绪」；这仍不代表 Chat 已获得工具或读过正文，后者必须在目标 Chat 实测。

隧道运行配置位于用户自己的状态目录 `chat-connection/`。运行密钥文件权限为 0600；工具返回值只包含是否已配置，不包含密钥。启动参数和运行配置引用密钥文件，不插入明文。状态输出仅取所需布尔值，错误转换为不含敏感原文的提示。凭据/安装/启动工具仅供 App 调用，不向模型或远程 MCP 开放。

运行别名和配置目录与本用户的阅读器状态绑定，停止操作只针对该别名。MCP 命令使用当前安装位置和 Node 路径生成；不硬编码开发者用户名或要求用户手改目录。已有其他隧道不受影响。

连接时立即启用本机桥接、断开时关闭；阅读器后台上下文通过轮询同步新的 readerSession，无需为了修改隧道 ID 再重启应用。只有升级插件的服务端代码仍需要正常重启宿主。

## 高级与排错

常见错误提示分别引导用户检查 ID、运行密钥过期、Tunnels Read + Use/工作区关联以及网络。刷新状态不会启动连接或 OCR；安装组件也不会自动连接。

保留 `npm run chat-bridge -- enable|disable|status` 供开发测试，但普通用户无需使用。自定义组件路径可在本地启动环境指定 `CODEX_ZOTERO_TUNNEL_BINARY`，它不是模型可修改的设置。

参考 [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 和 [官方客户端说明](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)。私有隧道连接未就绪时，不应改成匿名公网 HTTP 服务，也不能用重新 OCR 解决工具不可达。

## 在 Chat 中连接

在 ChatGPT 的 Plugins → Add custom MCP server 中选择 Connection: Tunnel，选择相同隧道。此私有方案由 OpenAI 的隧道账号/组织权限限制访问；本机 stdio 服务没有另加 OAuth，可在连接界面选择相应的 No authentication。不要将这个无 OAuth 的 stdio 服务转换成匿名公网 HTTP 服务，也不要将承载个人文库的隧道关联或共享给无关工作区。

安装所得私有插件后，在目标 Chat 中用 @ 选择它并发送「打开 Zotero 阅读器」。模型应调用 `reader_open`，而不是仅调用 `reader_state` 后文字回复。没有打开论文时显示可搜索的文库，不要求用户先切到 Zotero 打开 PDF。

网页界面复用本地阅读器，支持原文选区、版面块、上下文、高亮/评论、研究文献集合和整篇 OCR。网页菜单提供「展开阅读器 / 返回对话」，通过标准 display-mode 请求切换 inline/fullscreen；具体排布与原生对话框位置由 ChatGPT 决定，插件不能强制桌面式侧边停靠。当前服务仍只维护一个活动阅读面板，新界面会替代旧界面的活动状态。

升级网页功能后断开并重新连接隧道，让它加载新版桥接和专用后台；桌面本地面板仍需完全重启桌面应用加载更新。Chat 可能缓存旧工具列表，需在插件连接设置刷新工具，必要时重新连接。新的工具列表应包含 `reader_open`，它关联 `ui://codex-zotero/remote-reader-v2.html`。

验收提示：

> 打开 Zotero 阅读器。请实际调用 reader_open 显示可操作的阅读界面；没有论文时显示文库搜索。我选择论文后，再按需要使用正文读取工具。

只有在目标 Chat 实际调用成功并取得正文后，才算接入完成。本地测试通过、隧道在线、能看到标题或能列出工具，都不是最后验收。

## 对外工具与边界

独立暴露 15 个有 schema 的操作：reader_state、search_library、paper_outline、read_pages、find_in_paper、list_annotations、read_notes、ocr_status、paper_full_text、ocr_start、research_status、research_annotations、research_ocr_start、research_ocr_status、research_ocr_cancel；另有只返回连接元数据的 reader_connections。另外提供关联 MCP App 资源的 `reader_open`。界面的 34 个内部操作设为 `ui.visibility: [app]`，不作为模型的批注写入工具。不是“通用执行任意操作”的工具。

- 阅读调用保持版本和分页语义，已读取版本在当前对话中复用，不建立跨对话全局已读标记。
- 多篇比较先取得明确选择的 itemKeys，再按需获取状态、OCR 和全文。研究批量 OCR 仍由原有队列控制并发。
- 模型工具不开放批注写入、删除、文件路径、密钥设置、任意文件读取或进程执行。界面通过独立白名单调用批注创建/更新/删除，复用原有写入队列与 Zotero 授权；参数在本机再次严格校验。App-only 可见性用于宿主工具分发，不取代私有隧道的账号授权。
- 网页隐藏本地凭据配置和「打开原 PDF」入口；密钥设置、隧道安装/启动等操作只能从本机设置调用。网页 OCR 使用本机已配置的 MinerU 凭据，不返回其内容。
- 个人/工作区隧道可用于私有连接；它不满足公开插件发布所需的稳定公网 HTTPS 端点要求。面向上游的通用公开服务需要另行部署、OAuth 和用户隔离，不能共用开发者个人文库。

## 验证

`npm test` 覆盖工具白名单、严格参数、连接隔离、Unix socket 权限、关闭后清理、MCP 正文返回，以及设置隐私、进程状态、安装校验与凭据清理。

```sh
npm run build
node test/chat-bridge-preflight.mjs --pdf /absolute/path/to/test.pdf
node test/remote-reader-preflight.mjs --pdf /absolute/path/to/test.pdf
node test/tunnel-settings-preflight.mjs --pdf /absolute/path/to/test.pdf
```

预检使用独立 Zotero API、缓存和状态目录，启动真正的阅读器与独立桥接进程，验证当前文档、全文分页与版本、完整评论、缓存 OCR 复用、错误连接/缺失 docId 拒绝、无 Zotero 写入。不创建真实隧道、不上传真实论文，也不自动发送真实 Chat 消息。

设置预检使用替身 tunnel-client 验证用户点击流程、动态启停、密码清空、窄屏与上下文隔离；不把模拟的 ready 状态视为真实 OpenAI 连接成功。

网页阅读器预检通过标准 AppBridge（不提供桌面专属扩展）、真实 stdio MCP 与私有 socket，验证空文库搜索、PDF 渲染、选区上下文、高亮/评论保存、模型随后读取评论、模式切换和会话路由。测试不等同于用户实际 ChatGPT 账号中的 UI 验收。

## 网页渲染和会话恢复

网页版使用 `render_page` 一次取得当前整页，替代本地阅读器的多个 `render_strip` 往返。优先加载可见页，限制为两个在途请求；不为不可见页面提前下载整页，字形/链接读取会合并并缓存；最近的整页图片另有 8 MiB 有界缓存，回翻不重复传输。页面图最大 3200 × 5600 像素；极大或高噪声图片按传输上限降低尺寸，选区仍使用原 PDF 坐标。普通页面以 PNG 为基准，有 Pillow 时使用逐像素一致的无损 WebP，仅在文件更小时采用；没有 Pillow 仍可阅读。

网页将导航轮询调整为 5 秒，外部批注更新轮询为 10 秒。用户自己写入的批注立即显示并保存，不等待轮询。读取失败采用有限退避；写入、OCR 启动不自动重放。页面加载失败提供本页「重试」，保留已显示内容。

官方 tunnel-client 对 stdio 启用 `MCP_STDIO_SEND_INITIALIZED_NOTIFICATION=true`。它只在调用方成功完成 initialize 后补发协议要求的通知，不伪造 initialize，也不能替代断线后宿主的重新连接。若仍出现「MCP server is not initialized」，刷新 Chat 中的连接，让宿主重新握手；重新 OCR 无助于该错误。

本机隔离测试对每次远程请求增加 250 ms 延迟，并串行执行隧道请求：同一 12 页 PDF 的首次清晰时间约 1.36 s → 0.91 s，首屏期间请求 19 → 9，传输量约 0.82 MB → 0.36 MB。此为固定测试环境的对比，不是实际账号或所有网络的延迟保证。`test/remote-performance-preflight.mjs` 可复测；`TEST_REMOTE_FAIL_ONCE=1 node test/remote-reader-preflight.mjs --pdf …` 验证初始化错误后的读取恢复。

## 专用网页后台

受管隧道以 `--managed-reader` 启动桥接；桥接启动一个 `--bridge-service` 阅读器子进程，通过私有 Unix socket 调用，不开放额外 HTTP 端口。网页无需依赖某个桌面对话已打开的 MCP 服务，也无需先打开本地阅读面板。桥接关闭时子进程一并退出；子进程意外退出时，下次请求单次重启，恢复已有文档与界面实例。父子进程之间只通过管道和 socket 通信。

`reader_connections` 对网页返回该专用后台的逻辑连接，不混入各个桌面对话的临时服务。实际 API、Python 与缓存路径使用本机配置，MinerU 密钥仍从私有文件读取。后台重启时不会自动重放失败的批注写入。

`test/managed-reader-preflight.mjs` 覆盖完全没有桌面服务时启动、并发单次启动、后台退出后的恢复、逻辑标识稳定与非法标识拒绝；`TEST_MANAGED_READER=1` 的网页预检实际通过此生命周期读图、选择与写批注。

网页后台将待写入队列存于 `web-reader/` 子目录，避免与桌面对话覆盖同一个队列文件；沿用全局 Zotero 授权，实际修改仍带 Zotero 版本检查。

### 翻页缓存与按钮反馈

网页阅读器保留附近已解码页图（预算 192 MiB），压缩页图在当前阅读器实例内使用 48 MiB LRU 缓存；超出预算按需释放。滚动预取前后一屏，两个在途请求槽优先处理用户写入及当前可见页，远处预取低于文字等读取。隧道底层可能串行传输，不承诺端到端并行。关闭或重新加载阅读器后，前端内存缓存会重建；服务端磁盘缓存仍复用。

加入上下文先显示定位标记，再后台补充缩略图；缩略图失败不撤销已选文字。网页端「去提问」发布上下文后请求返回 inline 对话模式，不改写或发送现有草稿。评论第一次点击立即打开输入框，创建批注期间保留输入，取得正式标识后保存；创建失败明确提示。
