#!/bin/sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
/bin/sh "$plugin_root/dist/start.sh" install
printf '\n按回车关闭窗口。'
read -r answer
