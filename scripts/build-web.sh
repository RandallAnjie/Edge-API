#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/web"
if command -v bun >/dev/null 2>&1; then
  bun run build
else
  npm run build
fi
rm -rf "$ROOT/public"
mkdir -p "$ROOT/public"
cp -a dist/. "$ROOT/public/"
