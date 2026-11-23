#!/usr/bin/env bash
# Run pnpm (the version package.json pins, through corepack) in a Node 24 container, as you,
# with this checkout mounted at its own path. For machines without a recent Node:
#   scripts/docker-pnpm.sh install
#   scripts/docker-pnpm.sh build
#   scripts/docker-pnpm.sh test
# The result runs on the host: bin/codiff-host starts the built app with Electron's own Node.
# pnpm's store and corepack's cache are kept in the `codiff-pnpm` Docker volume.
#   CODIFF_NODE_IMAGE   the base image (default node:24-bookworm)
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
base="${CODIFF_NODE_IMAGE:-node:24-bookworm}"
image="codiff-build:$(printf %s "$base" | tr -c '[:alnum:]_.-' -)"

# native-keymap compiles against X11 headers the Node image lacks. Built once, then cached.
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -q -t "$image" - >/dev/null <<EOF
FROM $base
RUN apt-get update && apt-get install -y --no-install-recommends libx11-dev libxkbfile-dev \\
  && rm -rf /var/lib/apt/lists/*
EOF
fi
tty=()
[[ -t 0 && -t 1 ]] && tty=(-it)

# The volume starts root-owned; hand it to you once.
docker run --rm -v codiff-pnpm:/cache "$image" chown "$(id -u):$(id -g)" /cache

# After an install, fetch Electron's binary if pnpm skipped its download (it can, under
# allowBuilds), so bin/codiff-host has something to start.
# shellcheck disable=SC2016 # expanded in the container
exec docker run --rm "${tty[@]}" --init --user "$(id -u):$(id -g)" \
  -v "$root:$root" -w "$root" -v codiff-pnpm:/cache \
  -e HOME=/cache/home -e COREPACK_HOME=/cache/corepack -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e npm_config_store_dir=/cache/pnpm-store -e CI="${CI:-}" \
  "$image" sh -c '
    mkdir -p "$HOME"
    corepack pnpm "$@" || exit
    if [ "${1:-}" = install ] && [ ! -x node_modules/electron/dist/electron ]; then
      node node_modules/electron/install.js
    fi
  ' pnpm "$@"
