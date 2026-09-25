#!/bin/sh
# pgHeal installer — no npmjs.com account needed.
#   curl -fsSL https://raw.githubusercontent.com/goun7/pgheal/master/install.sh | sh
set -eu

REPO="goun7/pgheal"
BASE="https://github.com/$REPO/releases/latest/download"

# resolve latest version from the redirect target
VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$BASE/pgheal-0.4.0.tgz" 2>/dev/null | sed -n 's#.*/download/v\([^/]*\)/.*#\1#p') || true
if [ -z "${VERSION:-}" ]; then
  VERSION="0.6.0" # fallback when the redirect cannot be parsed
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
echo "==> done."
echo ""
echo "Quick start:"
echo "  1. pgheal doctor     # verify DSN + privileges (read-only, safe)"
echo "  2. pgheal scan       # top offenders + migration suggestions"
echo ""
echo "Optional — GitHub PR delivery (auto-opens PRs with the DDL):"
echo "  export GITHUB_TOKEN=github_pat_…"
echo "  export GITHUB_REPO=owner/repo"
echo "  # or, with no long-lived PAT (v0.6+):"
echo "  export PGHEAL_GITHUB_APP_ID=<app id>"
echo "  export PGHEAL_GITHUB_APP_INSTALLATION_ID=<installation id>"
echo "  export PGHEAL_GITHUB_APP_KEY_PATH=/secure/path/app.private-key.pem"
echo ""
echo "Docs: https://github.com/$REPO#readme"
