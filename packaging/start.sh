#!/bin/sh
# Locate the desktop app's runtime; no developer-specific paths are packaged.
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_bin=''
for app_root in /Applications/ChatGPT.app /Applications/Codex.app "$HOME/Applications/ChatGPT.app" "$HOME/Applications/Codex.app"; do
  candidate="$app_root/Contents/Resources/cua_node/bin/node"
  if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
done
if [ -z "$node_bin" ]; then node_bin=$(command -v node || true); fi
if [ -z "$node_bin" ]; then echo '请先安装 ChatGPT/Codex 桌面应用，或 Node.js 22 以上版本。' >&2; exit 1; fi
if [ -z "${CODEX_ZOTERO_PYTHON:-}" ] && [ -x "$HOME/.codex/codex-zotero-runtime/bin/python" ]; then
  export CODEX_ZOTERO_PYTHON="$HOME/.codex/codex-zotero-runtime/bin/python"
fi
case "${1:-server}" in
  server) exec "$node_bin" "$plugin_root/dist/server.mjs" ;;
  install) shift; exec "$node_bin" "$plugin_root/install-package.mjs" "$@" ;;
  layout) cd "$plugin_root"; exec "$node_bin" "$plugin_root/setup-analysis.mjs" ;;
  *) echo 'Unsupported launcher action' >&2; exit 1 ;;
esac
