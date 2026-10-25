# Chat 私有 MCP 桥接

Chat 能显示本地阅读器，但未必获得本地插件的模型工具。此桥接使用 OpenAI Secure MCP Tunnel，将单独注册的远程 MCP 工具接回正在运行的阅读器；保留现有 fullscreen 阅读界面与原生对话框，不自动注入全文。

## 数据与连接路径

```text
Chat 中的私有远程插件
  → OpenAI Secure MCP Tunnel（账号/组织访问控制）
  → 本机 tunnel-client（主动向 OpenAI 发起 HTTPS 连接）
  → dist/chat-bridge.mjs（stdio MCP）
  → 当前用户私有 Unix socket
  → 已运行的阅读器服务 → Zotero API / MuPDF / MinerU 缓存与任务
```

PDF 与缓存继续存放在本机。模型请求读取时，正文/评论会通过隧道返回给 Chat；这不是“数据从不离开本机”。需要 OCR 时仍遵守现有全局许可，仅上传给已配置的 MinerU。桥接不启动第二套 PDF/OCR/批注写入服务，因此本地界面与远程读取共用任务、缓存和最新批注。

桥接默认关闭。它只监听当前用户权限的 Unix socket，不创建 TCP/HTTP 公网监听，不需要为本机设置入站端口。每个阅读器服务使用独立 readerSession；模型必须携带上下文中的 readerSession，涉及文档的操作还必须提供 docId。服务重启后旧 readerSession 明确失效，不能默默跳到另一篇论文。

## 安装与启用

```sh
npm run install-plugin
npm run chat-bridge -- enable
```

由用户完全退出并重新打开桌面应用，再打开阅读器。阅读器后台上下文会携带 readerSession。关闭桥接使用 `npm run chat-bridge -- disable`，重启应用生效；只需检查开关则运行 `npm run chat-bridge -- status`。

启用只建立本机通信能力，不会自动创建隧道或更改 ChatGPT 插件。默认本地插件不受影响。

## 配置官方隧道

按照 [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 和 [tunnel-client onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md) 配置：

1. 登录目标账号的 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels)，创建或复用一个私有隧道，关联需要使用的 ChatGPT 账号/工作区。创建需要 Tunnels Read + Manage；运行和使用需要 Tunnels Read + Use。
2. 安装 [官方最新版 tunnel-client](https://github.com/openai/tunnel-client/releases/latest)。先运行 `tunnel-client help quickstart`，以实际安装版本的帮助为准。
3. 为隧道准备专用运行密钥，按官方方式通过 `CONTROL_PLANE_API_KEY` 环境变量提供。不要把密钥写进仓库、MCP 参数、聊天、截图或示例配置。
4. 使用 stdio profile，MCP 命令为构建生成的 `dist/chat-bridge.mjs`，**不是**常规 `dist/server.mjs`，也不是测试用 `--standalone` HTTP 服务。

macOS 默认安装路径示例（替换实际用户路径与 tunnel id；命令中没有真实密钥）：

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile zotero-chat \
  --tunnel-id '<your-tunnel-id>' \
  --mcp-command '"/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "/Users/your-name/.codex/plugins/cache/codex-zotero-local/codex-zotero/0.1.0/dist/chat-bridge.mjs"'

tunnel-client doctor --profile zotero-chat --explain
tunnel-client run --profile zotero-chat
```

前台验证完成后，若要长期后台运行，使用当前 `tunnel-client runtimes connect --help` 提供的受管运行方式，再以 `runtimes status` 确认运行和就绪状态；不使用 nohup/disown。启动失败不得描述为已连接。

使用自定义 `CODEX_ZOTERO_STATE` 的安装，桥接进程需要使用同一个目录。保持 tunnel-client 与桌面应用的阅读器服务运行；退出应用、停用插件或服务重启后旧连接失效。仅关闭面板不保证后台 MCP 服务退出；reader_connections 中的 live 表示面板近期是否仍在报告状态。无论面板是否可见，正文读取均要求明确的 docId，不会自动切换论文。

## 在 Chat 中连接

在 ChatGPT 的 Plugins → Add custom MCP server 中选择 Connection: Tunnel，选择相同隧道。此私有方案由 OpenAI 的隧道账号/组织权限限制访问；本机 stdio 服务没有另加 OAuth，可在连接界面选择相应的 No authentication。不要将这个无 OAuth 的 stdio 服务转换成匿名公网 HTTP 服务，也不要将承载个人文库的隧道关联或共享给无关工作区。

安装所得私有插件后，在目标 Chat 中启用它。阅读器仍由现有本地插件提供；新增连接负责模型的读取与 OCR 调用。两者不是重复的阅读器界面。

验收提示：

> 使用私有 Zotero 连接，先读取 reader_connections 并匹配阅读器上下文里的 readerSession。实际调用 paper_full_text 读取当前 docId 的正文；如有 nextOffset 则续读。之后概括结论并标明原 PDF 页码。读取失败时直接报告，不根据标题推测。

只有在目标 Chat 实际调用成功并取得正文后，才算接入完成。本地测试通过、隧道在线、能看到标题或能列出工具，都不是最后验收。

## 对外工具与边界

独立暴露 15 个有 schema 的操作：reader_state、search_library、paper_outline、read_pages、find_in_paper、list_annotations、read_notes、ocr_status、paper_full_text、ocr_start、research_status、research_annotations、research_ocr_start、research_ocr_status、research_ocr_cancel；另有只返回连接元数据的 reader_connections。不是“通用执行任意操作”的工具。

- 阅读调用保持版本和分页语义，已读取版本在当前对话中复用，不建立跨对话全局已读标记。
- 多篇比较先取得明确选择的 itemKeys，再按需获取状态、OCR 和全文。研究批量 OCR 仍由原有队列控制并发。
- 不开放批注写入、删除、文件路径、密钥设置、任意文件读取、进程执行或内部面板 API。远程回复的保存暂不在此 profile 中支持。
- 个人/工作区隧道可用于私有连接；它不满足公开插件发布所需的稳定公网 HTTPS 端点要求。面向上游的通用公开服务需要另行部署、OAuth 和用户隔离，不能共用开发者个人文库。

## 验证

`npm test` 覆盖工具白名单、严格参数、连接隔离、Unix socket 权限、关闭后清理，以及 MCP 正文返回。

```sh
npm run build
node test/chat-bridge-preflight.mjs --pdf /absolute/path/to/test.pdf
```

预检使用独立 Zotero API、缓存和状态目录，启动真正的阅读器与独立桥接进程，验证当前文档、全文分页与版本、完整评论、缓存 OCR 复用、错误连接/缺失 docId 拒绝、无 Zotero 写入。不创建真实隧道、不上传真实论文，也不自动发送真实 Chat 消息。
