#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Please install Node.js 20+: https://nodejs.org/'
  echo 'See README.md for setup and runtime requirements.'
  exit 1
fi
exec node start.mjs
