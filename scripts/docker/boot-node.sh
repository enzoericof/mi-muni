#!/bin/sh
set -eu

WORKDIR="/app"
LOCK_FILE="$WORKDIR/package-lock.json"
PACKAGE_FILE="$WORKDIR/package.json"
NODE_MODULES_DIR="$WORKDIR/node_modules"
STAMP_FILE="$NODE_MODULES_DIR/.mi-muni-lock-hash"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi

  cksum "$1" | awk '{print $1}'
}

TARGET_FILE="$LOCK_FILE"
if [ ! -f "$TARGET_FILE" ]; then
  TARGET_FILE="$PACKAGE_FILE"
fi

mkdir -p "$NODE_MODULES_DIR"
CURRENT_HASH="$(hash_file "$TARGET_FILE")"
SAVED_HASH=""

if [ -f "$STAMP_FILE" ]; then
  SAVED_HASH="$(cat "$STAMP_FILE" 2>/dev/null || true)"
fi

if [ ! -d "$NODE_MODULES_DIR/.bin" ] || [ "$CURRENT_HASH" != "$SAVED_HASH" ]; then
  echo "[mi-muni] preparando dependencias..."
  npm ci --no-fund --no-audit --silent
  printf "%s" "$CURRENT_HASH" > "$STAMP_FILE"
else
  echo "[mi-muni] dependencias listas."
fi

exec "$@"
