// @ts-check

// Assisted reviews whose bridge runs on another machine, the one a `--remote` repository lives on.
// Connection files are read over SSH with the same checks as local ones, and the bridge's Unix
// socket is forwarded to a private local socket by a dedicated `ssh -N -L` process, so the rest of
// the client talks to it exactly as to a local bridge. The capability token in a connection file
// only ever travels inside that SSH connection.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { call } = require('./client.cjs');
const { getRemoteShellCommand, runRemoteCommand } = require('../remote-repository.cjs');

const MAX_CONNECTION_BYTES = 65_536;
const FORWARD_TIMEOUT_MS = 15_000;

// Prints `<file>\0<contents>\0` for every connection file given (default: every session in the
// bridge's runtime directory, and in the one scripts/docker-run.sh shares with its containers)
// that is a regular file owned by the remote user and hidden from group and others.
const READ_CONNECTIONS_SCRIPT = `uid=$(id -u)
base=\${XDG_RUNTIME_DIR:-/tmp}
if [ "$#" -eq 0 ]; then
  set -- "$base/assisted-review-$uid"/session-*/connection.json \\
    "$base/assisted-review-docker-$uid/assisted-review-$uid"/session-*/connection.json
fi
for file; do
  [ -f "$file" ] && [ ! -L "$file" ] || continue
  info=$(stat -c '%a %u %s' -- "$file" 2>/dev/null || stat -f '%Lp %u %z' -- "$file" 2>/dev/null) || continue
  mode=\${info%% *}
  rest=\${info#* }
  owner=\${rest%% *}
  size=\${rest#* }
  case "$mode" in *00) ;; *) continue ;; esac
  [ "$owner" = "$uid" ] && [ "$size" -le ${MAX_CONNECTION_BYTES} ] || continue
  printf '%s\\0' "$file"
  cat -- "$file"
  printf '\\0'
done`;

/**
 * @typedef {import('../remote-repository.cjs').RemoteRepository} RemoteRepository
 * @typedef {import('./client.cjs').Connection} Connection
 * @typedef {{close: () => void; connection: Connection; file: string}} RemoteReview
 */

/** @param {unknown} value @returns {value is Connection} */
const isConnection = (value) => {
  const text = (/** @type {unknown} */ field) => typeof field === 'string' && field !== '';
  const object = /** @type {Record<string, unknown> | null} */ (
    value && typeof value === 'object' ? value : null
  );
  return Boolean(
    object &&
    text(object.socket) &&
    String(object.socket).startsWith('/') &&
    text(object.token) &&
    typeof object.root === 'string' &&
    text(object.review_id),
  );
};

/**
 * Read connection files on `remote`'s host: the given absolute paths, or every live session's.
 *
 * @param {RemoteRepository} remote
 * @param {ReadonlyArray<string>} [files]
 * @returns {Promise<Array<{connection: Connection; file: string}>>}
 */
const readRemoteConnections = async (remote, files = []) => {
  const output = (
    await runRemoteCommand(remote, ['sh', '-c', READ_CONNECTIONS_SCRIPT, 'sh', ...files])
  ).toString('utf8');
  const fields = output.split('\0');
  /** @type {Array<{connection: Connection; file: string}>} */
  const connections = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    try {
      const connection = JSON.parse(fields[index + 1]);
      if (isConnection(connection)) {
        connections.push({ connection, file: fields[index] });
      }
    } catch {
      // A half-written or foreign session is simply not a candidate.
    }
  }
  return connections;
};

/**
 * Forward the bridge socket `remoteSocket` on `remote`'s host to a new private local socket. The
 * forward is its own SSH connection (no connection sharing), so closing it never affects others.
 *
 * @param {RemoteRepository} remote
 * @param {string} remoteSocket
 * @returns {Promise<{close: () => void; socket: string}>}
 */
const forwardSocket = (remote, remoteSocket) =>
  new Promise((resolve, reject) => {
    // mkdtemp creates the directory 0700: only this user can reach the forwarded socket.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codiff-ar-'));
    const socket = path.join(directory, 'bridge.sock');
    const child = spawn(
      getRemoteShellCommand(),
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ControlPath=none',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        ...(remote.port ? ['-p', String(remote.port)] : []),
        '-N',
        '-L',
        `${socket}:${remoteSocket}`,
        '--',
        remote.destination,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    let settled = false;
    const close = () => {
      child.kill();
      child.stderr?.destroy();
      fs.rmSync(directory, { force: true, recursive: true });
    };
    /** @param {Error | null} error */
    const settle = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      if (error) {
        close();
        reject(error);
      } else {
        resolve({ close, socket });
      }
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on('error', (error) => settle(error));
    child.on('close', (code) => {
      const detail = stderr.trim().split('\n').pop();
      settle(
        new Error(
          `Could not reach the review bridge on ${remote.destination}${
            detail ? `: ${detail}` : ` (status ${code})`
          }`,
        ),
      );
      fs.rmSync(directory, { force: true, recursive: true });
    });
    const poll = setInterval(() => {
      if (fs.existsSync(socket)) {
        settle(null);
      }
    }, 50);
    const timeout = setTimeout(
      () => settle(new Error(`Timed out forwarding the review bridge from ${remote.destination}`)),
      FORWARD_TIMEOUT_MS,
    );
  });

/**
 * Connect to one remote connection: forward its socket, then check the bridge answers for it.
 *
 * @param {RemoteRepository} remote
 * @param {{connection: Connection; file: string}} candidate
 * @returns {Promise<RemoteReview & {state: any}>}
 */
const connectRemoteReview = async (remote, { connection, file }) => {
  const forward = await forwardSocket(remote, connection.socket);
  try {
    const local = { ...connection, socket: forward.socket };
    const state = await call(local, 'status');
    return { close: forward.close, connection: local, file, state };
  } catch (error) {
    forward.close();
    throw error;
  }
};

/**
 * Live, non-stale reviews on `remote`'s host of the repository `root` (any repository when null),
 * each with its socket already forwarded. Close the ones you don't keep.
 *
 * @param {RemoteRepository} remote
 * @param {string | null} root repository root on the remote host
 * @returns {Promise<Array<RemoteReview>>}
 */
const discoverRemoteReviews = async (remote, root) => {
  const candidates = (await readRemoteConnections(remote)).filter(
    ({ connection }) => root === null || connection.root === root,
  );
  const probed = await Promise.all(
    candidates.map((candidate) => connectRemoteReview(remote, candidate).catch(() => null)),
  );
  const seen = new Set();
  /** @type {Array<RemoteReview>} */
  const live = [];
  for (const review of probed) {
    if (!review) {
      continue;
    }
    const { state } = review;
    if (
      (root === null || state.root === root) &&
      state.review_id === review.connection.review_id &&
      state.stale === false &&
      !seen.has(state.review_id)
    ) {
      seen.add(state.review_id);
      live.push({ close: review.close, connection: review.connection, file: review.file });
    } else {
      review.close();
    }
  }
  return live.sort((a, b) => a.connection.review_id.localeCompare(b.connection.review_id));
};

/**
 * Open one remote connection file, forwarding its socket.
 *
 * @param {RemoteRepository} remote
 * @param {string} file absolute path on the remote host
 * @returns {Promise<RemoteReview>}
 */
const openRemoteConnection = async (remote, file) => {
  const [candidate] = await readRemoteConnections(remote, [file]);
  if (!candidate) {
    throw new Error(
      `Connection file ${remote.destination}:${file} is missing, invalid, or not private and owned by you`,
    );
  }
  const { close, connection } = await connectRemoteReview(remote, candidate);
  return { close, connection, file };
};

module.exports = {
  discoverRemoteReviews,
  forwardSocket,
  openRemoteConnection,
  readRemoteConnections,
};
