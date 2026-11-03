#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 20 或更新版本：https://nodejs.org/'
  echo '安装与运行说明见 README.md。'
  read -r '?按回车关闭…'
  exit 1
fi
node start.mjs
if [ "$?" -ne 0 ]; then
  read -r '?启动未成功。按回车关闭…'
fi
