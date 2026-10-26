#!/bin/sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
/bin/sh "$plugin_root/dist/start.sh" layout
printf '\n版面模型安装完成。请重启桌面应用。按回车关闭窗口。'
read -r answer
