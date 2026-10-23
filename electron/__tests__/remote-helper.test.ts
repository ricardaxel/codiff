import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

type RemoteHelperStatus = { connected: boolean; lastError?: string };
type RemoteHelperWatcher = {
  close: () => void;
  getStatus: () => Record<string, RemoteHelperStatus>;
  reconnect: () => void;
  update: (hosts: ReadonlyArray<string>) => void;
};

const require = createRequire(import.meta.url);
const { createRemoteHelperWatcher, installRemoteHelper, parseRemoteHelperRequest } =
  require('../remote-helper.cjs') as {
    createRemoteHelperWatcher: (options: {
      initialRetryDelayMs?: number;
      maxRetryDelayMs?: number;
      onOpen: (host: string, path: string) => void | Promise<void>;
      onStatusChange?: (host: string, status: RemoteHelperStatus) => void;
      silenceTimeoutMs?: number;
    }) => RemoteHelperWatcher;
    installRemoteHelper: (host: string) => Promise<void>;
    parseRemoteHelperRequest: (line: string) => { path: string } | { error: string };
  };
const { readConfig } = require('../config.cjs') as {
  readConfig: () => { settings: { remoteHelperHosts: ReadonlyArray<string> } };
};

const execFileAsync = promisify(execFile);
const helperScript = resolve('bin/codiff-remote-helper.sh');

// Stands in for the remote shell client: it skips the client options, logs
// the destination and runs the command from the fake remote home directory.
// Like a login shell running a single command, it execs it, so stopping the
// client stops the remote command. `quiet` connects but never answers, like a
// connection that died silently.
const fakeRemoteShell = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
printf '%s\\n' "$1" >> "$CODIFF_TEST_REMOTE_LOG"
case "$1" in
  devbox) ;;
  quiet) exec sleep 30 ;;
  *) echo "unknown host $1" >&2; exit 255 ;;
esac
shift
cd "$CODIFF_TEST_REMOTE_HOME" || exit 1
export HOME="$CODIFF_TEST_REMOTE_HOME"
exec sh -c "exec $1"
`;

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition.');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
};

const createFakeRemote = async (root: string) => {
  const localHome = join(root, 'local');
  const remoteHome = join(root, 'remote');
  const shell = join(root, 'remote-shell');
  const log = join(root, 'remote.log');
  await mkdir(localHome);
  await mkdir(remoteHome);
  await writeFile(shell, fakeRemoteShell);
  await chmod(shell, 0o755);
  await writeFile(log, '');
  return {
    environment: createTemporaryEnvironment({
      CODIFF_SSH_PATH: shell,
      CODIFF_TEST_REMOTE_HOME: remoteHome,
      CODIFF_TEST_REMOTE_LOG: log,
      HOME: localHome,
    }),
    localHome,
    readLog: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    remoteHome,
  };
};

const runHelper = async (
  args: ReadonlyArray<string>,
  remoteHome: string,
  cwd: string,
  environment: Record<string, string> = {},
) => {
  try {
    const { stderr, stdout } = await execFileAsync('sh', [helperScript, ...args], {
      cwd,
      env: { ...getGitTestEnvironment(), HOME: remoteHome, ...environment },
    });
    return { code: 0, stderr, stdout };
  } catch (error) {
    const { code, stderr, stdout } = error as { code: number; stderr: string; stdout: string };
    return { code, stderr, stdout };
  }
};

test('parses remote helper requests', () => {
  expect(parseRemoteHelperRequest('open /srv/app/../app')).toEqual({ path: '/srv/app' });
  expect(parseRemoteHelperRequest('open srv/app')).toEqual({
    error: 'The repository path must be absolute.',
  });
  expect(parseRemoteHelperRequest('run rm -rf /')).toEqual({ error: 'Unsupported request.' });
});

test('codiff -r opens the repository through the watcher connection', async () => {
  await using directory = await createTemporaryDirectory('codiff-remote-helper-');
  const root = await realpath(directory.path);
  const remote = await createFakeRemote(root);
  using _environment = remote.environment;
  const repo = join(remote.remoteHome, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await execFileAsync('git', ['init', '-q', repo], { env: getGitTestEnvironment() });

  const opened: Array<[string, string]> = [];
  const watcher = createRemoteHelperWatcher({
    onOpen: (host, path) => {
      opened.push([host, path]);
    },
  });
  try {
    watcher.update(['devbox', '../escape']);
    await waitFor(() => watcher.getStatus().devbox?.connected === true);
    expect(Object.keys(watcher.getStatus())).toEqual(['devbox']);
    const requests = join(remote.remoteHome, '.codiff', 'requests');
    expect((await stat(requests)).mode & 0o777).toBe(0o700);

    expect(await runHelper(['-r'], remote.remoteHome, join(repo, 'src'))).toEqual({
      code: 0,
      stderr: '',
      stdout: `Sent ${repo} to Codiff.\n`,
    });
    await waitFor(() => opened.length === 1);
    expect(opened).toEqual([['devbox', repo]]);
    expect(await readdir(requests)).toEqual(['.watcher']);

    const notRepository = await runHelper(['-r', root], remote.remoteHome, root);
    expect(notRepository.code).toBe(1);
    expect(notRepository.stderr).toContain(`not a Git repository: ${root}`);

    const usage = await runHelper([], remote.remoteHome, repo);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Usage: codiff -r [path]');

    // Closing the connection removes the watcher record on the remote side.
    watcher.close();
    await waitFor(async () => !(await readdir(requests)).includes('.watcher'));
    const disconnected = await runHelper(['-r'], remote.remoteHome, repo);
    expect(disconnected.code).toBe(1);
    expect(disconnected.stderr).toContain('Codiff is not connected to this machine.');
    expect(await readdir(requests)).toEqual([]);
  } finally {
    watcher.close();
  }
});

test('a newer watcher takes over requests from an older one', async () => {
  await using directory = await createTemporaryDirectory('codiff-remote-helper-takeover-');
  const remote = await createFakeRemote(await realpath(directory.path));
  using _environment = remote.environment;
  const repo = join(remote.remoteHome, 'repo');
  await mkdir(repo);
  await execFileAsync('git', ['init', '-q', repo], { env: getGitTestEnvironment() });

  const opened: Array<string> = [];
  const older = createRemoteHelperWatcher({ onOpen: () => void opened.push('older') });
  const newer = createRemoteHelperWatcher({ onOpen: () => void opened.push('newer') });
  try {
    older.update(['devbox']);
    await waitFor(() => older.getStatus().devbox?.connected === true);
    newer.update(['devbox']);
    await waitFor(() => newer.getStatus().devbox?.connected === true);

    expect((await runHelper(['-r'], remote.remoteHome, repo)).code).toBe(0);
    await waitFor(() => opened.length > 0);
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));
    expect(opened).toEqual(['newer']);
  } finally {
    older.close();
    newer.close();
  }
});

test('codiff -r takes back a request nobody claims', async () => {
  await using directory = await createTemporaryDirectory('codiff-remote-helper-timeout-');
  const root = await realpath(directory.path);
  const repo = join(root, 'repo');
  const requests = join(root, '.codiff', 'requests');
  await mkdir(repo);
  await mkdir(requests, { recursive: true });
  await execFileAsync('git', ['init', '-q', repo], { env: getGitTestEnvironment() });
  // A live PID that never claims anything, like a watcher stuck on a dead network.
  await writeFile(join(requests, '.watcher'), `${process.pid}\n`);

  const result = await runHelper(['-r'], root, repo, { CODIFF_REQUEST_TIMEOUT: '1' });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Codiff did not pick up the request.');
  expect(await readdir(requests)).toEqual(['.watcher']);
});

test('reconnects with backoff and notices silent connections', async () => {
  await using directory = await createTemporaryDirectory('codiff-remote-helper-retry-');
  const remote = await createFakeRemote(await realpath(directory.path));
  using _environment = remote.environment;
  const statuses: Array<[string, RemoteHelperStatus]> = [];
  const watcher = createRemoteHelperWatcher({
    initialRetryDelayMs: 20,
    maxRetryDelayMs: 40,
    onOpen: () => {},
    onStatusChange: (host, status) => statuses.push([host, status]),
    silenceTimeoutMs: 100,
  });
  try {
    watcher.update(['other', 'quiet']);
    await waitFor(
      async () => (await remote.readLog()).filter((host) => host === 'other').length >= 3,
    );
    await waitFor(() =>
      statuses.some(
        ([host, status]) =>
          host === 'quiet' && status.lastError === 'The connection stopped responding.',
      ),
    );
    expect(watcher.getStatus().other).toEqual({
      connected: false,
      lastError: 'unknown host other',
    });

    // Removing a host stops its retries.
    watcher.update([]);
    const attempts = (await remote.readLog()).length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    expect((await remote.readLog()).length).toBe(attempts);
  } finally {
    watcher.close();
  }
});

test('installs the helper over SSH and allows the host', async () => {
  await using directory = await createTemporaryDirectory('codiff-remote-helper-install-');
  const remote = await createFakeRemote(await realpath(directory.path));
  using _environment = remote.environment;

  await installRemoteHelper('devbox');
  const installed = join(remote.remoteHome, '.local', 'bin', 'codiff');
  expect(await readFile(installed, 'utf8')).toBe(await readFile(helperScript, 'utf8'));
  expect((await stat(installed)).mode & 0o111).toBe(0o111);
  expect(readConfig().settings.remoteHelperHosts).toEqual(['devbox']);

  // Reinstalling updates the helper without listing the host twice.
  await installRemoteHelper('devbox');
  expect(readConfig().settings.remoteHelperHosts).toEqual(['devbox']);

  await writeFile(installed, '#!/bin/sh\necho another codiff\n');
  await expect(installRemoteHelper('devbox')).rejects.toThrow(
    /already exists and is not the Codiff remote helper/,
  );
  await expect(installRemoteHelper('other')).rejects.toThrow(/unknown host other/);
  await expect(installRemoteHelper('-oProxyCommand=x')).rejects.toThrow(/Invalid host/);
});
