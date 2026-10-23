// @ts-check

const { execFileSync, spawn } = require('node:child_process');
const { posix, resolve } = require('node:path');

/**
 * Remote repositories are addressed as `ssh://[user@]host[:port]/absolute/path`
 * so they can travel through every code path that already passes a repository
 * path around as a plain string. Git commands and the few file reads Codiff
 * performs are routed through `ssh` when a path uses that form.
 *
 * @typedef {{destination: string; path: string; port?: number}} RemoteRepository
 * @typedef {{command: string; args: Array<string>; remote: RemoteRepository | null}} GitInvocation
 * @typedef {{
 *   ctimeMs: number;
 *   ino: number;
 *   isDirectory: () => boolean;
 *   isFile: () => boolean;
 *   isSymbolicLink: () => boolean;
 *   mode: number;
 *   mtimeMs: number;
 *   size: number;
 * }} RemoteFileStat
 */

const REMOTE_REPOSITORY_PREFIX = 'ssh://';

/** @param {string} value */
const isRemoteRepositoryPath = (value) =>
  typeof value === 'string' && value.startsWith(REMOTE_REPOSITORY_PREFIX);

/** @param {string} authority @returns {{destination: string; port?: number} | null} */
const parseAuthority = (authority) => {
  const match = authority.match(/^([^\s/:]+)(?::(\d+))?$/u);
  if (!match) {
    return null;
  }
  const port = match[2] ? Number(match[2]) : undefined;
  if (port != null && (port < 1 || port > 65_535)) {
    return null;
  }
  return { destination: match[1], ...(port ? { port } : {}) };
};

/**
 * Parse a canonical remote repository path produced by
 * `formatRemoteRepositoryPath`.
 *
 * @param {string} value
 * @returns {RemoteRepository | null}
 */
const parseRemoteRepositoryPath = (value) => {
  if (!isRemoteRepositoryPath(value)) {
    return null;
  }
  const rest = value.slice(REMOTE_REPOSITORY_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  const authority = parseAuthority(rest.slice(0, slash));
  return authority ? { ...authority, path: posix.normalize(rest.slice(slash)) } : null;
};

/** @param {RemoteRepository} remote */
const formatRemoteRepositoryPath = ({ destination, path, port }) =>
  `${REMOTE_REPOSITORY_PREFIX}${destination}${port ? `:${port}` : ''}${
    path.startsWith('/') ? path : `/${path}`
  }`;

/**
 * Parse the user-facing `--remote` value. Accepts `[user@]host:path`,
 * `[user@]host` (the remote home directory) and
 * `ssh://[user@]host[:port]/path`. The path may be relative to the remote home
 * directory until it is resolved with `resolveRemoteRepositoryRoot`.
 *
 * @param {string} target
 * @returns {RemoteRepository | null}
 */
const parseRemoteTarget = (target) => {
  const value = target.trim();
  if (!value || value.startsWith('-')) {
    return null;
  }

  if (isRemoteRepositoryPath(value)) {
    const rest = value.slice(REMOTE_REPOSITORY_PREFIX.length);
    const slash = rest.indexOf('/');
    const authority = parseAuthority(slash === -1 ? rest : rest.slice(0, slash));
    if (!authority) {
      return null;
    }
    const path = slash === -1 ? '' : rest.slice(slash);
    // `ssh://host/~/repo` names a path inside the remote home directory.
    return { ...authority, path: path.startsWith('/~/') ? path.slice(3) : path };
  }

  const colon = value.indexOf(':');
  const authority = parseAuthority(colon === -1 ? value : value.slice(0, colon));
  if (!authority || authority.port) {
    return null;
  }
  const path = colon === -1 ? '' : value.slice(colon + 1);
  return {
    destination: authority.destination,
    // Commands run from the remote home directory, so `~/repo` is `repo`.
    path: path === '~' ? '' : path.startsWith('~/') ? path.slice(2) : path,
  };
};

/** @param {string} value */
const quoteShellArgument = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/** @param {ReadonlyArray<string>} argv */
const buildRemoteCommand = (argv) => argv.map(quoteShellArgument).join(' ');

const getRemoteShellCommand = () => process.env.CODIFF_SSH_PATH || 'ssh';

/**
 * @param {RemoteRepository} remote
 * @param {ReadonlyArray<string>} argv
 * @param {{keepAlive?: boolean; tty?: boolean}} [options]
 */
const getRemoteShellArgs = (remote, argv, options = {}) => [
  // Codiff has no terminal to prompt in: authentication must use keys or an agent.
  '-o',
  'BatchMode=yes',
  // Reuse one connection for the many short Git commands a review runs.
  ...(process.platform === 'win32'
    ? []
    : ['-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/codiff-%C', '-o', 'ControlPersist=300']),
  ...(remote.port ? ['-p', String(remote.port)] : []),
  // Long-lived commands notice a dead network within ~90 seconds.
  ...(options.keepAlive ? ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'] : []),
  ...(options.tty ? ['-tt'] : []),
  '--',
  remote.destination,
  buildRemoteCommand(argv),
];

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{tty?: boolean}} [options]
 * @returns {GitInvocation}
 */
const getGitInvocation = (repoPath, args, options = {}) => {
  const remote = parseRemoteRepositoryPath(repoPath);
  return remote
    ? {
        args: getRemoteShellArgs(remote, ['git', '-C', remote.path, ...args], options),
        command: getRemoteShellCommand(),
        remote,
      }
    : { args: ['-C', repoPath, ...args], command: 'git', remote: null };
};

/**
 * `git rev-parse --show-toplevel` is how every caller turns a launch path into
 * a repository root. Keep remote roots addressable by re-attaching the host.
 *
 * @template {string | Buffer} T
 * @param {GitInvocation} invocation
 * @param {ReadonlyArray<string>} args
 * @param {T} output
 * @returns {T}
 */
const mapGitOutput = (invocation, args, output) => {
  if (
    !invocation.remote ||
    typeof output !== 'string' ||
    args.length !== 2 ||
    args[0] !== 'rev-parse' ||
    args[1] !== '--show-toplevel'
  ) {
    return output;
  }
  return /** @type {T} */ (
    `${formatRemoteRepositoryPath({ ...invocation.remote, path: output.trim() })}\n`
  );
};

/**
 * Synchronous Git for the launch path checks that run before a window opens.
 *
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 */
const execGitSync = (repoPath, args, options = {}) => {
  const invocation = getGitInvocation(repoPath, args);
  return mapGitOutput(invocation, args, execFileSync(invocation.command, invocation.args, options));
};

/**
 * Start a long-running command on the remote host.
 *
 * @param {RemoteRepository} remote
 * @param {ReadonlyArray<string>} argv
 * @param {{keepAlive?: boolean}} [options]
 */
const spawnRemoteCommand = (remote, argv, options = {}) =>
  spawn(getRemoteShellCommand(), getRemoteShellArgs(remote, argv, options), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * Run a command on the remote host and collect its stdout.
 *
 * @param {RemoteRepository} remote
 * @param {ReadonlyArray<string>} argv
 * @param {string | Buffer} [input] Sent to the remote command's stdin.
 * @returns {Promise<Buffer>}
 */
const runRemoteCommand = (remote, argv, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(getRemoteShellCommand(), getRemoteShellArgs(remote, argv), {
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    child.stdin?.end(input);
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8').trim() ||
              `${argv[0]} exited with status ${code} on ${remote.destination}`,
          ),
        );
      }
    });
  });

// GNU stat first, then BSD stat. Both report lstat() data by default.
const STAT_SCRIPT =
  'stat -c "%f %s %Y %Z %i" -- "$1" 2>/dev/null || stat -f "%Xp %z %m %c %i" -- "$1"';
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

/** @param {RemoteRepository} remote @param {string} path */
const getRemoteFilePath = (remote, path) => posix.join(remote.path, path);

/** @param {string} output @returns {RemoteFileStat} */
const parseRemoteStat = (output) => {
  const [rawMode, rawSize, rawMtime, rawCtime, rawIno] = output.trim().split(/\s+/u);
  const mode = Number.parseInt(rawMode, 16);
  const size = Number(rawSize);
  if (!Number.isFinite(mode) || !Number.isFinite(size)) {
    throw new Error('Could not read remote file metadata.');
  }
  const type = mode & S_IFMT;
  return {
    ctimeMs: Number(rawCtime) * 1000,
    ino: Number(rawIno),
    isDirectory: () => type === S_IFDIR,
    isFile: () => type === S_IFREG,
    isSymbolicLink: () => type === S_IFLNK,
    mode,
    mtimeMs: Number(rawMtime) * 1000,
    size,
  };
};

/** @param {RemoteRepository} remote @param {string} path */
const remoteLstat = async (remote, path) =>
  parseRemoteStat(
    (
      await runRemoteCommand(remote, [
        'sh',
        '-c',
        STAT_SCRIPT,
        'sh',
        getRemoteFilePath(remote, path),
      ])
    ).toString('utf8'),
  );

const STAT_MANY_SCRIPT =
  'for p; do stat -c "%f %s %Y %Z %i" -- "$p" 2>/dev/null || ' +
  'stat -f "%Xp %z %m %c %i" -- "$p" 2>/dev/null || echo missing; done';
// Keep each remote command line well below common ARG_MAX limits.
const STAT_MANY_BATCH_SIZE = 500;

/**
 * Stat many paths with one remote command per batch. Missing paths are
 * `undefined`. Output lines never contain file names, so any path is safe.
 *
 * @param {RemoteRepository} remote
 * @param {ReadonlyArray<string>} paths
 * @returns {Promise<Array<RemoteFileStat | undefined>>}
 */
const remoteLstatMany = async (remote, paths) => {
  /** @type {Array<RemoteFileStat | undefined>} */
  const stats = [];
  for (let index = 0; index < paths.length; index += STAT_MANY_BATCH_SIZE) {
    const batch = paths.slice(index, index + STAT_MANY_BATCH_SIZE);
    const lines = (
      await runRemoteCommand(remote, [
        'sh',
        '-c',
        STAT_MANY_SCRIPT,
        'sh',
        ...batch.map((path) => getRemoteFilePath(remote, path)),
      ])
    )
      .toString('utf8')
      .split('\n');
    for (let offset = 0; offset < batch.length; offset += 1) {
      const line = lines[offset] ?? 'missing';
      stats.push(line === 'missing' ? undefined : parseRemoteStat(line));
    }
  }
  return stats;
};

/** @param {RemoteRepository} remote @param {string} path */
const remoteReadFile = (remote, path) =>
  runRemoteCommand(remote, ['cat', '--', getRemoteFilePath(remote, path)]);

/** @param {RemoteRepository} remote @param {string} path */
const remoteReadlink = async (remote, path) =>
  (await runRemoteCommand(remote, ['readlink', '--', getRemoteFilePath(remote, path)]))
    .toString('utf8')
    .replace(/\n$/u, '');

/**
 * Resolve a parsed `--remote` target to its canonical repository root.
 *
 * @param {RemoteRepository} remote
 * @returns {string}
 */
const resolveRemoteRepositoryRoot = (remote) => {
  const label = `${remote.destination}:${remote.path || '~'}`;
  let root;
  try {
    // Relative paths resolve from the remote home directory, where commands start.
    root = execFileSync(
      getRemoteShellCommand(),
      getRemoteShellArgs(remote, ['git', '-C', remote.path || '.', 'rev-parse', '--show-toplevel']),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    const stderr = String(/** @type {{stderr?: unknown}} */ (error)?.stderr ?? '').trim();
    throw new Error(`Could not open a Git repository at ${label}${stderr ? `: ${stderr}` : '.'}`);
  }
  if (!root.startsWith('/')) {
    throw new Error(`Could not open a Git repository at ${label}.`);
  }
  return formatRemoteRepositoryPath({ ...remote, path: root });
};

/** @type {Map<string, string>} */
const remoteLaunchPaths = new Map();

/**
 * Resolve a `--remote` value passed straight to the app. The launch path is
 * parsed several times during startup, so each target connects once. When the
 * host cannot be reached the unresolved path still opens, and the window
 * reports the Git error instead of silently reviewing the working directory.
 *
 * @param {string} target
 * @returns {string | null}
 */
const resolveRemoteLaunchPath = (target) => {
  const remote = parseRemoteTarget(target);
  if (!remote) {
    return null;
  }
  let launchPath = remoteLaunchPaths.get(target);
  if (!launchPath) {
    try {
      launchPath = resolveRemoteRepositoryRoot(remote);
    } catch {
      launchPath = formatRemoteRepositoryPath(remote);
    }
    remoteLaunchPaths.set(target, launchPath);
  }
  return launchPath;
};

/**
 * `path.resolve` for repository paths that leaves remote paths untouched.
 *
 * @param {string} repositoryPath
 */
const resolveRepositoryPath = (repositoryPath) =>
  isRemoteRepositoryPath(repositoryPath) ? repositoryPath : resolve(repositoryPath);

module.exports = {
  buildRemoteCommand,
  execGitSync,
  formatRemoteRepositoryPath,
  getGitInvocation,
  isRemoteRepositoryPath,
  mapGitOutput,
  parseRemoteRepositoryPath,
  parseRemoteTarget,
  quoteShellArgument,
  remoteLstat,
  remoteLstatMany,
  remoteReadFile,
  remoteReadlink,
  resolveRemoteLaunchPath,
  resolveRemoteRepositoryRoot,
  resolveRepositoryPath,
  runRemoteCommand,
  spawnRemoteCommand,
};
