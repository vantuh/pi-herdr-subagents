#!/bin/bash
# Link the extension's peer dependencies into a local (gitignored) node_modules
# so the test runner can import index.ts, which pulls in the Pi packages.
#
# The extension is loaded by Pi at runtime, so it has no install step of its
# own; the packages only exist inside the globally installed pi-coding-agent.
set -euo pipefail

ext_dir="$(cd "$(dirname "$0")/.." && pwd)"

pi_bin="$(command -v pi || true)"
if [ -z "$pi_bin" ]; then
  echo "link-deps: 'pi' not found in PATH; cannot locate @earendil-works packages." >&2
  exit 1
fi

pi_root="$(node -e 'const fs=require("node:fs"),path=require("node:path");let d=path.dirname(fs.realpathSync(process.argv[1]));while(d!=="/"){if(fs.existsSync(path.join(d,"package.json"))&&JSON.parse(fs.readFileSync(path.join(d,"package.json"),"utf8")).name==="@earendil-works/pi-coding-agent"){console.log(d);process.exit(0)}d=path.dirname(d)}process.exit(1)' "$pi_bin")"

link() {
  ln -sfn "$1" "$2"
  [ -e "$2" ] || { echo "link-deps: missing $1" >&2; exit 1; }
}

mkdir -p "$ext_dir/node_modules/@earendil-works"
link "$pi_root" "$ext_dir/node_modules/@earendil-works/pi-coding-agent"
link "$pi_root/node_modules/@earendil-works/pi-tui" "$ext_dir/node_modules/@earendil-works/pi-tui"
link "$pi_root/node_modules/typebox" "$ext_dir/node_modules/typebox"
