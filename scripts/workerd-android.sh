#!/data/data/com.termux/files/usr/bin/bash
#
# Enable Cloudflare `workerd` on Termux/Android (local development only).
#
# The `workerd` npm package ships glibc builds and rejects
# `process.platform === "android"`. This host has `glibc-runner`, so for every
# installed `workerd` copy we:
#   1. download the matching linux-arm64 workerd binary via `npm pack`
#   2. patch it to use Termux's glibc loader (patchelf) via `grun`
#   3. wrap it in a script that re-enters `grun` (so Node can spawn it)
#   4. teach the `workerd` package the `android arm64 LE` platform key
#
# Run this after every `npm install` (npm prunes the manually added package).
# This is a local development workaround only; the deployment target is
# unmodified Cloudflare Workers.

set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GRUN="$PREFIX/bin/grun"

for tool in "$GRUN" "$PREFIX/glibc/bin/patchelf" "$PREFIX/bin/npm" "$PREFIX/bin/node"; do
  if [ ! -x "$tool" ]; then
    echo "error: '$tool' not found. Install with: pkg install glibc-runner nodejs-lts" >&2
    exit 1
  fi
done

if [ ! -d "$PROJECT_DIR/node_modules/workerd" ]; then
  echo "error: run 'npm install' first" >&2
  exit 1
fi

patch_workerd() {
  local dir="$1"
  local version
  version="$("$PREFIX/bin/node" -p "require('$dir/package.json').version")"
  local pkg_name="@cloudflare/workerd-linux-arm64"
  local pkg_dir="$dir/node_modules/$pkg_name"

  echo "Installing $pkg_name@$version for $dir ..."
  local tmp
  tmp="$(mktemp -d)"
  (
    cd "$tmp"
    "$PREFIX/bin/npm" pack "$pkg_name@$version" >/dev/null
    tar xzf ./*.tgz
  )

  # Always start from a clean package directory so re-runs are safe.
  rm -rf "$pkg_dir"
  mkdir -p "$pkg_dir"
  cp -r "$tmp/package/." "$pkg_dir/"
  rm -rf "$tmp"

  local bin_dir="$pkg_dir/bin"
  mv "$bin_dir/workerd" "$bin_dir/workerd.real"

  local ld_file
  ld_file="$(ls "$PREFIX/glibc/lib/ld-"* | head -1)"
  "$GRUN" "$PREFIX/glibc/bin/patchelf" \
    --set-rpath "$PREFIX/glibc/lib" \
    --set-interpreter "$ld_file" \
    "$bin_dir/workerd.real"

  cat > "$bin_dir/workerd" <<EOF
#!$PREFIX/bin/bash
# Real egress needs a CA bundle workerd can read (the default Termux paths are
# not visible to the glibc loader's cert store).
export SSL_CERT_FILE="\${SSL_CERT_FILE:-$PREFIX/etc/tls/cert.pem}"
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
exec $GRUN "\$DIR/workerd.real" "\$@"
EOF
  chmod +x "$bin_dir/workerd"

  "$PREFIX/bin/node" -e '
const fs = require("fs");
const file = process.argv[1];
let src = fs.readFileSync(file, "utf8");
if (!src.includes("\"android arm64 LE\"")) {
  const before = src;
  src = src.replace(
    /(\s*)"linux arm64 LE": "@cloudflare\/workerd-linux-arm64",/,
    "$1\"linux arm64 LE\": \"@cloudflare/workerd-linux-arm64\",$1\"android arm64 LE\": \"@cloudflare/workerd-linux-arm64\",",
  );
  if (src === before) {
    console.error("error: could not patch workerd platform table");
    process.exit(1);
  }
  fs.writeFileSync(file, src);
}
' "$dir/lib/main.js"

  echo -n "workerd ready at $dir: "
  "$bin_dir/workerd" --version
}

# Every workerd copy in the tree (wrangler and the vitest pool may pin
# different versions).
while IFS= read -r dir; do
  patch_workerd "$dir"
done < <(find "$PROJECT_DIR/node_modules" -type d -name workerd -not -path "*/workerd/node_modules/*")
