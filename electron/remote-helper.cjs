// @ts-check

// The remote helper lets `codiff -r` on another machine open a repository in
// this Codiff. Codiff keeps one SSH command per allowed host that claims the
// request files `codiff -r` leaves in ~/.codiff/requests there. Because this
// side opens the connection, it works however the user reached the machine
// (SSH, mosh, an old tmux session), and a request can only open a repository
// on the host it came from.

const { readFile } = require('node:fs/promises');
const { join, posix } = require('node:path');
const { isRemoteHelperHost, readConfig, writeConfig } = require('./config.cjs');
const { runRemoteCommand, spawnRemoteCommand } = require('./remote-repository.cjs');

const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
// The watcher pings every 15 seconds; silence for longer means the connection is gone.
const SILENCE_TIMEOUT_MS = 45_000;
const MAX_LINE_LENGTH = 8192;

// Runs on the remote machine. It records its PID so `codiff -r` can tell whether
// Codiff is connected, claims each request with an atomic `mv` so two watchers
// never open the same request twice, and pings so a dead connection is noticed:
// writing to a closed pipe also ends this loop on the remote side.
const WATCH_SCRIPT = `set -u
dir="$HOME/.codiff/requests"
mkdir -p "$dir"
chmod 700 "$dir"
printf '%s\\n' "$$" > "$dir/.watcher.$$"
mv "$dir/.watcher.$$" "$dir/.watcher"
cleanup() {
  if [ "$(cat "$dir/.watcher" 2>/dev/null)" = "$$" ]; then rm -f "$dir/.watcher"; fi
}
trap 'cleanup; exit 0' HUP INT PIPE TERM
trap cleanup EXIT
if sleep 0.5 2>/dev/null; then nap=0.5; ping_every=30; else nap=1; ping_every=15; fi
printf 'ready\\n'
ticks=0
while :; do
  for request in "$dir"/*.req; do
    [ -e "$request" ] || continue
    # Never claim on a dead connection or after a newer watcher took over:
    # the request would be lost instead of timing out on the remote side.
    [ "$(cat "$dir/.watcher" 2>/dev/null)" = "$$" ] || exit 0
    printf 'ping\\n' || exit 0
    claimed="$request.$$"
    mv "$request" "$claimed" 2>/dev/null || continue
    line=''
    IFS= read -r line < "$claimed" || :
    rm -f "$claimed"
    printf '%s\\n' "$line" || exit 0
  done
  ticks=$((ticks + 1))
  if [ "$ticks" -ge "$ping_every" ]; then
    ticks=0
    [ "$(cat "$dir/.watcher" 2>/dev/null)" = "$$" ] || exit 0
    printf 'ping\\n' || exit 0
  fi
  sleep "$nap"
done`;

/**
 * Stop a watcher process. Closing our end of its pipes matters as much as the
 * signal: a remote loop that outlives its client then fails its next ping and
 * exits, and the `close` event no longer waits for it.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
const terminate = (child) => {
  child.kill();
  child.stdout?.destroy();
  child.stderr?.destroy();
};

/**
 * Parse one `open <absolute path>` request line.
 *
 * @param {string} line
 * @returns {{path: string} | {error: string}}
 */
const parseRemoteHelperRequest = (line) => {
  if (!line.startsWith('open ')) {
    return { error: 'Unsupported request.' };
  }
  const path = line.slice('open '.length);
  if (!path.startsWith('/') || path.includes('\0')) {
    return { error: 'The repository path must be absolute.' };
  }
  return { path: posix.normalize(path) };
};

/**
 * @typedef {{connected: boolean; lastError?: string}} RemoteHelperStatus
 * @typedef {{
 *   child?: import('node:child_process').ChildProcess;
 *   failures: number;
 *   immediateRetry?: boolean;
 *   lastError?: string;
 *   ready: boolean;
 *   retryTimer?: NodeJS.Timeout;
 *   silenceTimer?: NodeJS.Timeout;
 *   stopped: boolean;
 * }} Connection
 */

/**
 * @param {{
 *   initialRetryDelayMs?: number;
 *   maxRetryDelayMs?: number;
 *   onOpen: (host: string, path: string) => void | Promise<void>;
 *   onStatusChange?: (host: string, status: RemoteHelperStatus) => void;
 *   silenceTimeoutMs?: number;
 * }} options
 */
const createRemoteHelperWatcher = ({
  initialRetryDelayMs = INITIAL_RETRY_DELAY_MS,
  maxRetryDelayMs = MAX_RETRY_DELAY_MS,
  onOpen,
  onStatusChange,
  silenceTimeoutMs = SILENCE_TIMEOUT_MS,
}) => {
  /** @type {Map<string, Connection>} */
  const connections = new Map();

  /** @param {string} host @param {Connection} connection */
  const reportStatus = (host, connection) =>
    onStatusChange?.(host, {
      connected: connection.ready,
      ...(connection.lastError ? { lastError: connection.lastError } : {}),
    });

  /** @param {string} host @param {string} line */
  const handleLine = (host, line) => {
    if (line === 'ready' || line === 'ping' || !line) {
      return;
    }
    const request = parseRemoteHelperRequest(line);
    if ('error' in request) {
      return;
    }
    // `then` also turns a synchronous throw from onOpen into a rejection.
    Promise.resolve()
      .then(() => onOpen(host, request.path))
      .catch(() => {});
  };

  /** @param {string} host @param {Connection} connection */
  const connect = (host, connection) => {
    connection.retryTimer = undefined;
    const child = spawnRemoteCommand({ destination: host, path: '' }, ['sh', '-c', WATCH_SCRIPT], {
      keepAlive: true,
    });
    connection.child = child;
    let buffered = '';
    let stderr = '';

    const resetSilenceTimer = () => {
      clearTimeout(connection.silenceTimer);
      connection.silenceTimer = setTimeout(() => {
        connection.lastError = 'The connection stopped responding.';
        terminate(child);
      }, silenceTimeoutMs);
    };
    resetSilenceTimer();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      resetSilenceTimer();
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line === 'ready' && !connection.ready) {
          connection.ready = true;
          connection.failures = 0;
          connection.lastError = undefined;
          reportStatus(host, connection);
        }
        handleLine(host, line);
        newline = buffered.indexOf('\n');
      }
      if (buffered.length > MAX_LINE_LENGTH) {
        buffered = '';
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on('error', (error) => {
      connection.lastError = error.message;
    });
    child.on('close', (code) => {
      clearTimeout(connection.silenceTimer);
      if (connection.child === child) {
        connection.child = undefined;
      }
      const wasReady = connection.ready;
      connection.ready = false;
      if (connection.stopped) {
        return;
      }
      const detail = stderr.trim().split('\n').pop();
      connection.lastError = detail || connection.lastError || `exited with status ${code}`;
      reportStatus(host, connection);
      // A connection that worked retries quickly; repeated failures back off.
      connection.failures = wasReady ? 0 : connection.failures + 1;
      const delay = connection.immediateRetry
        ? 0
        : Math.min(
            initialRetryDelayMs * 2 ** Math.max(0, connection.failures - 1),
            maxRetryDelayMs,
          );
      connection.immediateRetry = false;
      connection.retryTimer = setTimeout(() => connect(host, connection), delay);
    });
  };

  /** @param {string} host */
  const stop = (host) => {
    const connection = connections.get(host);
    connections.delete(host);
    if (!connection) {
      return;
    }
    connection.stopped = true;
    clearTimeout(connection.retryTimer);
    clearTimeout(connection.silenceTimer);
    if (connection.child) {
      terminate(connection.child);
    }
  };

  return {
    close: () => {
      for (const host of [...connections.keys()]) {
        stop(host);
      }
    },
    /** @returns {Record<string, RemoteHelperStatus>} */
    getStatus: () =>
      Object.fromEntries(
        [...connections].map(([host, connection]) => [
          host,
          {
            connected: connection.ready,
            ...(connection.lastError ? { lastError: connection.lastError } : {}),
          },
        ]),
      ),
    /**
     * Retry every disconnected host now, e.g. after the computer wakes up.
     * Connected hosts are restarted too: their TCP connection may be dead.
     */
    reconnect: () => {
      for (const [host, connection] of connections) {
        clearTimeout(connection.retryTimer);
        connection.failures = 0;
        if (connection.child) {
          connection.immediateRetry = true;
          terminate(connection.child);
        } else {
          connect(host, connection);
        }
      }
    },
    /**
     * Watch exactly these hosts.
     *
     * @param {ReadonlyArray<string>} hosts
     */
    update: (hosts) => {
      const wanted = new Set(hosts.filter(isRemoteHelperHost));
      for (const host of [...connections.keys()]) {
        if (!wanted.has(host)) {
          stop(host);
        }
      }
      for (const host of wanted) {
        if (!connections.has(host)) {
          /** @type {Connection} */
          const connection = { failures: 0, ready: false, stopped: false };
          connections.set(host, connection);
          connect(host, connection);
        }
      }
    },
  };
};

// Refuse to replace a `codiff` on the remote machine that is not this helper.
const INSTALL_SCRIPT = `set -eu
mkdir -p "$HOME/.local/bin"
target="$HOME/.local/bin/codiff"
if [ -e "$target" ] && ! grep -q 'Codiff remote helper' "$target"; then
  echo "$target already exists and is not the Codiff remote helper." >&2
  exit 3
fi
cat > "$target.tmp"
chmod 755 "$target.tmp"
mv "$target.tmp" "$target"`;

/**
 * Copy the helper to `host` over SSH and allow it in the config.
 *
 * @param {string} host
 */
const installRemoteHelper = async (host) => {
  if (!isRemoteHelperHost(host)) {
    throw new Error(`Invalid host "${host}". Use an SSH host alias such as devbox.`);
  }
  const script = await readFile(join(__dirname, '../bin/codiff-remote-helper.sh'));
  try {
    await runRemoteCommand({ destination: host, path: '' }, ['sh', '-c', INSTALL_SCRIPT], script);
  } catch (error) {
    throw new Error(
      `Could not install the remote helper on ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const config = readConfig();
  if (!config.settings.remoteHelperHosts.includes(host)) {
    writeConfig({
      ...config,
      settings: {
        ...config.settings,
        remoteHelperHosts: [...config.settings.remoteHelperHosts, host],
      },
    });
  }
};

module.exports = {
  createRemoteHelperWatcher,
  installRemoteHelper,
  parseRemoteHelperRequest,
};
