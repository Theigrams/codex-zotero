# 安装

写给自己动手的人，也写给替你安装的 agent：每一步都有命令和确认方法。命令都在终端里运行，工作目录是仓库根目录（第 2 步之后）。

## 0. 检查环境

```bash
sw_vers -productVersion                 # macOS
xcrun swiftc --version                  # Xcode 命令行工具；没有就运行 xcode-select --install
node --version                          # 需要 v20 或更高
ls /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node   # Codex 自带的 Node，插件运行时用它
curl -s http://127.0.0.1:23119/connector/ping                        # Zotero 本地服务
```

- `curl` 的输出里应有 `Zotero is running`。没有返回：先打开 Zotero；再到 Zotero 设置 → 高级，勾选"允许此计算机上的其他应用程序与 Zotero 通信"。
- 测试过的组合：macOS 27（Apple Silicon）、Zotero 10.0.6、Codex 26.10。

## 1. （可选）PyMuPDF 与 fontTools

PDF 里的连字（fi、fl）和一些符号（Σ、Λ）常常取不出正确的文字。装了 PyMuPDF 和 fontTools（读取 PDF 内嵌字体的字形名），插件会用它们修复，选中的文字和发给 Codex 的原文更准确。不装也能用。两者都列在 `native/requirements.txt`。

```bash
python3 -m pip install pymupdf fonttools
python3 -c "import pymupdf, fontTools; print(pymupdf.__version__, fontTools.version)"
```

想用另一个 Python（conda 环境等），安装插件前设置 `export CODEX_ZOTERO_PYTHON=/path/to/python`。

## 2. 取得源码

```bash
git clone https://github.com/theigrams/codex-zotero.git
cd codex-zotero
npm install
npm test                                 # 单元测试，应全部通过
```

## 3. 安装插件

```bash
npm run install-plugin
```

脚本依次：

1. 构建插件到 `out/`：编译 PDFKit 辅助程序、打包服务端与面板。
2. 找 PyMuPDF 与 fontTools：用 `CODEX_ZOTERO_PYTHON`，没设就用当前终端的 `python3`。两者都能导入时打印 `PyMuPDF and fontTools found: <路径>`，并把这个绝对路径写进插件的启动配置；找不到时打印安装提示，插件照常安装，只是不做文字修复。
3. 把 KaTeX 的 20 个字体和 Lora 复制到 `~/Library/Fonts`（已有的跳过）。面板运行在 Codex 的沙箱里，不能加载字体文件，只能使用系统里装好的字体。
4. 第一次安装时，执行 `codex plugin marketplace add <仓库>/out` 和 `codex plugin add codex-zotero@codex-zotero-local`；以后再运行只更新已安装的文件。

确认：

```bash
ls ~/.codex/plugins/cache/codex-zotero-local/codex-zotero/*/dist/server.mjs
cat ~/.codex/plugins/cache/codex-zotero-local/codex-zotero/*/.mcp.json   # 找到 Python 时 env 里有 CODEX_ZOTERO_PYTHON
ls ~/Library/Fonts | grep -c "KaTeX_\|Lora"                              # 22
```

## 4. 在 Codex 里打开

1. **完全退出 Codex（⌘Q）再打开**。只关窗口不够，插件服务和新字体都要重启后才生效。
2. 在 Codex 里新建对话，说："打开 Zotero 阅读器"。面板出现首页（搜索框和在读列表）即成功。
3. 第一次在阅读器里高亮时，Zotero 会弹窗请求写入授权，选"始终允许"。

## 更新

```bash
git pull
npm install
npm run install-plugin
```

改动涉及服务端时需要 ⌘Q 重启 Codex；只改了面板时，关掉阅读器面板再打开即可。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 面板显示"无法连接 Zotero：请启动 Zotero 并开启本地 API。" | Zotero 没开，或没开启本地 API（见第 0 步） |
| 公式显示成普通字体、排版错乱 | 字体没装上或 Codex 没重启：检查 `~/Library/Fonts` 里的 `KaTeX_*.ttf`，然后 ⌘Q 重启 Codex |
| 选中的文字里连字、符号是乱码 | PyMuPDF 或 fontTools 没找到：装好后重新运行 `npm run install-plugin` |
| `swiftc` 报错 | 安装或更新 Xcode 命令行工具：`xcode-select --install` |
| 生成论文地图失败 | 地图由 Codex CLI 调用模型生成，需要 Codex 已登录；模型和推理强度可在设置 → 论文地图里改 |
| Codex 不在 `/Applications/ChatGPT.app` | 安装前设置 `CODEX_ZOTERO_CODEX`（Codex CLI）和 `CODEX_ZOTERO_NODE`（Codex 自带的 Node）的路径，见 [docs/CONFIG.md](docs/CONFIG.md) |

## 卸载

```bash
npm run uninstall-plugin                 # 移除插件和插件市场
npm run uninstall-plugin -- --all        # 同时删除阅读状态 ~/.codex/codex-zotero、缓存 ~/Library/Caches/codex-zotero、
                                         # 增强识别结果 ~/Library/Application Support/codex-zotero 和钥匙串里的 MinerU Key
```

字体留在 `~/Library/Fonts`，脚本会列出文件；确认其他程序不用后可手动删除。Zotero 里的批注和笔记不受影响。
