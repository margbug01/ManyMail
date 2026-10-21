#!/usr/bin/env bash
# 本地测试：构建主界面（frontend/ → web/static/app）+ 类型检查 + 语法检查 + tools/test-*.cjs
# （Playwright 无头浏览器，接口全是桩，不碰线上）。
# deploy-prod.sh 部署前会先跑它；也可以单独跑：tools/test-ui.sh
#
# 依赖自动找，也可以手动指定：
#   PLAYWRIGHT_MODULE  playwright-core 目录；没设就装到 ${MANYMAIL_TEST_DEPS:-~/.cache/manymail-ui-tests}（不进仓库）
#   BROWSER_PATH       Chromium 可执行文件；没设就去 Playwright 默认下载目录里找
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

topath() { if command -v cygpath >/dev/null 2>&1; then cygpath "$@"; else echo "${@: -1}"; fi; }

DEPS="${MANYMAIL_TEST_DEPS:-$HOME/.cache/manymail-ui-tests}"
# 页面用的 Bootstrap / Quill 版本（和模板里的 CDN 地址一致）：布局测试要用真样式量宽度，写信测试要真编辑器
UI_PACKAGES="bootstrap@5.3.0 bootstrap-icons@1.10.0 quill@2.0.3"
if [ -z "${PLAYWRIGHT_MODULE:-}" ]; then
  if [ ! -d "$DEPS/node_modules/playwright-core" ] || [ ! -d "$DEPS/node_modules/bootstrap-icons" ] || [ ! -d "$DEPS/node_modules/quill" ]; then
    echo "installing playwright-core $UI_PACKAGES into $DEPS ..."
    mkdir -p "$DEPS"
    # shellcheck disable=SC2086
    (cd "$DEPS" && { [ -f package.json ] || npm init -y >/dev/null; } && npm i --silent playwright-core $UI_PACKAGES >/dev/null)
  fi
  PLAYWRIGHT_MODULE="$DEPS/node_modules/playwright-core"
fi
UI_TEST_MODULES="$(topath -w "$DEPS/node_modules")"
export UI_TEST_MODULES

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

echo "== frontend build"
# npm ci 只在依赖变了时重跑；直接用 node 调 vite/tsc，Windows 的 cmd 垫片可能找不到 node
(
  cd frontend
  # 平台也算进去：Windows 装的 node_modules 拿到 WSL/Linux 下用，缺对应平台的编译器二进制
  stamp="$(node -p "process.platform + '-' + process.arch")-$(git hash-object package-lock.json)"
  if [ "$(cat node_modules/.manymail-stamp 2>/dev/null)" != "$stamp" ]; then
    npm ci --no-audit --no-fund
    echo "$stamp" > node_modules/.manymail-stamp
  fi
  node node_modules/typescript/bin/tsc --noEmit
  node node_modules/vite/bin/vite.js build --logLevel warn
)
echo "ok"

echo "== syntax"
for f in web/static/js/*.js web/shared/*.js imap-bridge/public/*.js imap-bridge/*.js tools/*.cjs; do
  node --check "$f"
done
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
