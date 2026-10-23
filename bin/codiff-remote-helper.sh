#!/bin/sh
# Codiff remote helper.
#
# Installed on another machine by `codiff --install-remote-helper <host>`. Asks
# the Codiff app on your workstation to open a repository on this host. Codiff
# keeps an SSH connection to this machine that claims the request files written
# to ~/.codiff/requests, so it works however you connected here (SSH, mosh…).
set -eu

dir="${CODIFF_REQUESTS_DIR:-$HOME/.codiff/requests}"
timeout="${CODIFF_REQUEST_TIMEOUT:-10}"

usage() {
  cat <<'EOF'
Usage: codiff -r [path]

Open the Git repository containing path (default: the current directory) in
Codiff on your workstation. Codiff must be running there, with this host added
through `codiff --install-remote-helper <host>`.
EOF
}

case "${1:-}" in
  -r | --remote) shift ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

target="${1:-.}"
if ! root="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null)" || [ -z "$root" ]; then
  printf 'codiff: not a Git repository: %s\n' "$target" >&2
  exit 1
fi
case "$root" in
  *'
'*)
    printf '%s\n' 'codiff: repository paths containing newlines are not supported.' >&2
    exit 1
    ;;
esac

not_connected() {
  printf '%s\n' \
    'codiff: Codiff is not connected to this machine.' \
    'Make sure Codiff is running on your workstation and that this host was added' \
    'with `codiff --install-remote-helper <host>` there.' >&2
  exit 1
}

# Codiff's watcher records its PID while it is connected.
watcher="$(cat "$dir/.watcher" 2>/dev/null || :)"
case "$watcher" in
  '' | *[!0-9]*) not_connected ;;
esac
kill -0 "$watcher" 2>/dev/null || not_connected

request="$dir/$(date +%s)-$$.req"
printf 'open %s\n' "$root" > "$request.tmp"
mv "$request.tmp" "$request"

# The watcher removes the request as soon as it claims it.
if sleep 0.2 2>/dev/null; then
  step=0.2
  attempts=$((timeout * 5))
else
  step=1
  attempts=$timeout
fi
while [ -e "$request" ] && [ "$attempts" -gt 0 ]; do
  sleep "$step"
  attempts=$((attempts - 1))
done

# Take the request back so it cannot open a window later. If the watcher
# claimed it in the meantime, the move fails and the request went through.
if mv "$request" "$request.cancelled" 2>/dev/null; then
  rm -f "$request.cancelled"
  printf '%s\n' 'codiff: Codiff did not pick up the request. Is it still running on your workstation?' >&2
  exit 1
fi
printf 'Sent %s to Codiff.\n' "$root"
