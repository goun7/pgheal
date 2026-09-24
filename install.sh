#!/bin/sh
# pgHeal installer — no npmjs.com account needed.
#   curl -fsSL https://raw.githubusercontent.com/goun7/pgheal/master/install.sh | sh
set -eu

REPO="goun7/pgheal"
BASE="https://github.com/$REPO/releases/latest/download"

# resolve latest version from the redirect target
VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$BASE/pgheal-0.4.0.tgz" 2>/dev/null | sed -n 's#.*/download/v\([^/]*\)/.*#\1#p') || true
if [ -z "${VERSION:-}" ]; then
  VERSION="0.4.0" # fallback when the redirect cannot be parsed
fi

echo "==> pgHeal v$VERSION"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> downloading"
curl -fsSL "$BASE/pgheal-$VERSION.tgz" -o "$TMP/pgheal.tgz"

echo "==> unpacking"
mkdir -p "$TMP/pkg"
tar -xzf "$TMP/pgheal.tgz" -C "$TMP/pkg"

echo "==> installing (npm client, no npm account required)"
(cd "$TMP/pkg/package" && npm install -g .)

echo "==> verifying"
pgheal --version
echo "==> done. Next: DATABASE_URL=postgres://… pgheal doctor"
