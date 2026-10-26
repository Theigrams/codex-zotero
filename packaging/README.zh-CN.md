# Zotero 阅读器安装包

这是 macOS 桌面插件安装包，包含 Apple 芯片与 Intel 两种架构的原生 PDF 组件。无需安装 npm 或自行编译。

1. 先安装 ChatGPT/Codex 桌面应用与 Zotero 10，并在 Zotero 高级设置中开启本地 API。
2. 解压整个文件夹，双击 `Install.command`。若系统阻止未知来源脚本，在确认来源后通过系统提供的打开入口运行。
3. 用 ⌘Q 完全退出并重开桌面应用，在插件列表打开「Zotero 阅读器」。

可先使用 PDF 原生文字阅读、选区和批注。需要本地版面识别或 MinerU OCR 时，双击 `Setup-layout.command` 安装共用的 Python 依赖及版面模型，需要 Python 3 和网络，模型约 204 MiB；未配置这些依赖时仍可使用基础 PDF 阅读。

设置 → MinerU 识别：填写你自己的 API key。设置 → Chat 私有连接：填写你自己的 OpenAI 隧道 ID 与运行密钥，安装连接组件后点击连接。不要填写或分享别人的凭据。

## 网页版怎么安装

此 ZIP 不能直接上传到 ChatGPT 网页来安装本地阅读器。它需要本机 Zotero 和桌面执行环境。网页端可添加带完整阅读界面的私有远程连接：

1. 先在本机完成以上安装，在阅读器的 Chat 私有连接设置中连接成功，保持本机隧道和 Zotero 运行；隧道会自动启动专用阅读器后台。
2. 打开 https://chatgpt.com/plugins ，点击「＋」→「Add custom MCP server」。
3. 填写名称，Connection 选择 Tunnel，选择或粘贴你自己的隧道 ID。
4. 当前私有 stdio 桥接没有额外 OAuth，认证选择 No authentication；隧道访问仍由 OpenAI 账号/组织权限控制。
5. 创建为插件并安装，在网页对话中使用 @ 选择该连接，发送「打开 Zotero 阅读器」。应调用 `reader_open` 显示可搜索文库及 PDF 阅读界面，可选择、高亮、评论和加入上下文。

账号必须具备自定义 MCP 与隧道使用权限。网页界面与按需读取工具都由同一连接提供，具体展开/侧边布局由 ChatGPT 控制。本机需保持 Zotero 和隧道运行；无需保留某个桌面对话或阅读面板；只用浏览器、不安装本机组件的纯 Web 版本尚未提供。升级后重启桌面应用、重连隧道并刷新 Chat 插件工具列表，确认有 `reader_open`。

## 包含内容与隐私

包含已构建的阅读器、MCP 服务、字体与许可证、安装脚本和使用说明。不包含任何个人 API key、隧道配置、文库、PDF、OCR 缓存或 Python 虚拟环境。

详细说明见 docs/CHAT_REMOTE.md。源代码与更新：https://github.com/Theigrams/codex-zotero/pull/1

网页版现使用整页渲染并减少轮询。已安装可选分析环境时，自动使用无损 WebP 降低传输量；没有 Pillow 时回退 PNG。若出现初始化错误，请刷新 Chat 插件连接；页面局部加载失败可点本页重试，不必重新 OCR。

连接重启后旧阅读器卡片的连接标识可能失效，关闭旧卡片后重新调用 `reader_open`。单独的后台重启会自动恢复，避免因桌面对话退出而丢失网页连接。
