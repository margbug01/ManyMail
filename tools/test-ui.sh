#!/usr/bin/env bash
# 本地测试：语法检查 + tools/test-*.cjs（Playwright 无头浏览器，接口全是桩，不碰线上）。
# deploy-prod.sh 部署前会先跑它；也可以单独跑：tools/test-ui.sh
#
# 依赖自动找，也可以手动指定：
#   PLAYWRIGHT_MODULE  playwright-core 目录；没设就装到 ${MANYMAIL_TEST_DEPS:-~/.cache/manymail-ui-tests}（不进仓库）
#   BROWSER_PATH       Chromium 可执行文件；没设就去 Playwright 默认下载目录里找
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

topath() { if command -v cygpath >/dev/null 2>&1; then cygpath "$@"; else echo "${@: -1}"; fi; }

DEPS="${MANYMAIL_TEST_DEPS:-$HOME/.cache/manymail-ui-tests}"
if [ -z "${PLAYWRIGHT_MODULE:-}" ]; then
  if [ ! -d "$DEPS/node_modules/playwright-core" ]; then
    echo "installing playwright-core into $DEPS ..."
    mkdir -p "$DEPS"
    (cd "$DEPS" && { [ -f package.json ] || npm init -y >/dev/null; } && npm i --silent playwright-core >/dev/null)
  fi
  PLAYWRIGHT_MODULE="$DEPS/node_modules/playwright-core"
fi

if [ -z "${BROWSER_PATH:-}" ]; then
  WIN_CACHE=""
  [ -n "${LOCALAPPDATA:-}" ] && WIN_CACHE="$(topath -u "$LOCALAPPDATA")/ms-playwright"
  for dir in "${PLAYWRIGHT_BROWSERS_PATH:-}" "$WIN_CACHE" "$HOME/.cache/ms-playwright" "$HOME/Library/Caches/ms-playwright"; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    BROWSER_PATH=$(ls -d "$dir"/chromium-*/chrome-win64/chrome.exe "$dir"/chromium-*/chrome-linux*/chrome "$dir"/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium 2>/dev/null | sort -V | tail -1 || true)
    [ -n "$BROWSER_PATH" ] && break
  done
fi
if [ -z "${BROWSER_PATH:-}" ]; then
  echo "ABORT: no Chromium found. Run: npx playwright install chromium   (or set BROWSER_PATH)" >&2
  exit 1
fi
# Windows 上 node 要 Windows 路径
PLAYWRIGHT_MODULE=$(topath -w "$PLAYWRIGHT_MODULE")
BROWSER_PATH=$(topath -w "$BROWSER_PATH")
export PLAYWRIGHT_MODULE BROWSER_PATH

echo "== syntax"
for f in mail-viewer/static/js/app.js mail-viewer/imap-mail-app/public/app.js mail-viewer/imap-mail-app/*.js tools/*.cjs; do
  node --check "$f"
done
PY=$(command -v python3 || command -v python || true)
if [ -n "$PY" ]; then
  # 只做语法解析，不生成 __pycache__（会弄脏工作区，部署脚本会拒绝）
  "$PY" -c "import ast, sys; [ast.parse(open(f, encoding='utf-8').read(), f) for f in sys.argv[1:]]" mail-viewer/app.py
fi
echo "ok"

FAILED=""
for t in tools/test-*.cjs; do
  echo "== $t"
  if ! timeout 300 node "$t"; then
    FAILED="$FAILED $t"
  fi
done
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED" >&2
  exit 1
fi
echo "all tests passed"
