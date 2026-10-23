import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

type RemoteRepository = { destination: string; path: string; port?: number };

const require = createRequire(import.meta.url);
const {
  buildRemoteCommand,
  formatRemoteRepositoryPath,
  getGitInvocation,
  parseRemoteRepositoryPath,
  parseRemoteTarget,
  resolveRemoteRepositoryRoot,
  resolveRepositoryPath,
} = require('../remote-repository.cjs') as {
  buildRemoteCommand: (argv: ReadonlyArray<string>) => string;
  formatRemoteRepositoryPath: (remote: RemoteRepository) => string;
  getGitInvocation: (
    repoPath: string,
    args: ReadonlyArray<string>,
  ) => { args: Array<string>; command: string; remote: RemoteRepository | null };
  parseRemoteRepositoryPath: (value: string) => RemoteRepository | null;
  parseRemoteTarget: (target: string) => RemoteRepository | null;
  resolveRemoteRepositoryRoot: (remote: RemoteRepository) => string;
  resolveRepositoryPath: (path: string) => string;
};
const { readRepositoryState } = require('../git-state.cjs') as {
  readRepositoryState: (
    launchPath: string,
  ) => Promise<{ files: ReadonlyArray<{ path: string; status: string }>; root: string }>;
};
const { readRepositoryWatcherSnapshot } = require('../repository-watcher.cjs') as {
  readRepositoryWatcherSnapshot: (
    root: string,
    exactPaths?: Iterable<string>,
  ) => Promise<{
    head: string;
    pathSignatures: Record<string, string>;
    pathVersions: Record<string, string>;
  }>;
};

const execFileAsync = promisify(execFile);

// Stands in for the remote shell client: it skips the client options, checks
// the destination and runs the remote command from a fake home directory.
const fakeRemoteShell = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
printf '%s\\n' "$1" >> "$CODIFF_TEST_REMOTE_LOG"
[ "$1" = "devbox" ] || { echo "unknown host $1" >&2; exit 255; }
shift
cd "$CODIFF_TEST_REMOTE_HOME" && exec sh -c "$1"
`;

test('parses --remote targets', () => {
  expect(parseRemoteTarget('devbox:src/app')).toEqual({ destination: 'devbox', path: 'src/app' });
  expect(parseRemoteTarget('me@devbox:/srv/app')).toEqual({
    destination: 'me@devbox',
    path: '/srv/app',
  });
  expect(parseRemoteTarget('devbox:~/app')).toEqual({ destination: 'devbox', path: 'app' });
  expect(parseRemoteTarget('devbox')).toEqual({ destination: 'devbox', path: '' });
  expect(parseRemoteTarget('ssh://me@devbox:2222/srv/app')).toEqual({
    destination: 'me@devbox',
    path: '/srv/app',
    port: 2222,
  });
  expect(parseRemoteTarget('ssh://devbox/~/app')).toEqual({ destination: 'devbox', path: 'app' });
  expect(parseRemoteTarget('-oProxyCommand=evil:path')).toBeNull();
  expect(parseRemoteTarget('')).toBeNull();
  expect(parseRemoteTarget('ssh://devbox:99999/app')).toBeNull();
});

test('round-trips remote repository paths', () => {
  const path = formatRemoteRepositoryPath({ destination: 'me@devbox', path: '/srv/app', port: 22 });
  expect(path).toBe('ssh://me@devbox:22/srv/app');
  expect(parseRemoteRepositoryPath(path)).toEqual({
    destination: 'me@devbox',
    path: '/srv/app',
    port: 22,
  });
  expect(parseRemoteRepositoryPath('/srv/app')).toBeNull();
  expect(resolveRepositoryPath(path)).toBe(path);
});

test('quotes remote commands for a POSIX shell', async () => {
  const argv = ['printf', '%s|', "it's", '$HOME', 'a b', '`id`'];
  const { stdout } = await execFileAsync('sh', ['-c', buildRemoteCommand(argv)]);
  expect(stdout).toBe("it's|$HOME|a b|`id`|");
});

test('keeps local Git invocations unchanged', () => {
  expect(getGitInvocation('/srv/app', ['status'])).toEqual({
    args: ['-C', '/srv/app', 'status'],
    command: 'git',
    remote: null,
  });
});

test('reads a remote repository through the remote shell', async () => {
  await using directory = await createTemporaryDirectory('codiff-remote-repository-');
  const home = await realpath(directory.path);
  const repo = join(home, 'app');
  const shell = join(home, 'remote-shell');
  const log = join(home, 'remote.log');
  await writeFile(shell, fakeRemoteShell);
  await chmod(shell, 0o755);
  await mkdir(repo);

  using _environment = createTemporaryEnvironment({
    ...getGitTestEnvironment(),
    CODIFF_SSH_PATH: shell,
    CODIFF_TEST_REMOTE_HOME: home,
    CODIFF_TEST_REMOTE_LOG: log,
  });
  const runGit = (args: ReadonlyArray<string>) => execFileAsync('git', ['-C', repo, ...args]);
  await runGit(['init', '-q', '-b', 'main']);
  await writeFile(join(repo, 'tracked.txt'), 'one\n');
  await writeFile(join(repo, "it's here.txt"), 'quoted\n');
  await runGit(['add', '.']);
  await runGit(['commit', '-q', '-m', 'Initial']);
  await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
  await writeFile(join(repo, "it's here.txt"), 'changed\n');
  await writeFile(join(repo, 'new.txt'), 'new file\n');
  await symlink('tracked.txt', join(repo, 'link'));

  const remoteRoot = resolveRemoteRepositoryRoot({ destination: 'devbox', path: 'app' });
  expect(remoteRoot).toBe(`ssh://devbox${repo}`);
  expect(() => resolveRemoteRepositoryRoot({ destination: 'other', path: 'app' })).toThrow(
    /Could not open a Git repository at other:app: unknown host other/,
  );

  const [remote, local] = await Promise.all([
    readRepositoryState(remoteRoot),
    readRepositoryState(repo),
  ]);
  expect(remote.root).toBe(remoteRoot);
  expect(local.files.length).toBe(4);
  expect(remote.files).toEqual(local.files);

  const [remoteSnapshot, localSnapshot] = await Promise.all([
    readRepositoryWatcherSnapshot(remoteRoot, ['new.txt', 'link']),
    readRepositoryWatcherSnapshot(repo, ['new.txt', 'link']),
  ]);
  expect(remoteSnapshot.head).toBe(localSnapshot.head);
  expect(Object.keys(remoteSnapshot.pathSignatures)).toEqual(
    Object.keys(localSnapshot.pathSignatures),
  );
  expect(remoteSnapshot.pathVersions).toEqual(localSnapshot.pathVersions);
  // Remote stat reports whole seconds, so compare everything except the times.
  const withoutTimes = (signature: string | undefined) => {
    const [path, type, mode, size, , , ino] = (signature ?? '').split('\0');
    return [path, type, mode, size, ino];
  };
  for (const path of Object.keys(localSnapshot.pathSignatures)) {
    expect(withoutTimes(remoteSnapshot.pathSignatures[path])).toEqual(
      withoutTimes(localSnapshot.pathSignatures[path]),
    );
  }
  expect(withoutTimes(remoteSnapshot.pathSignatures.link)[1]).toBe('symlink');

  expect(new Set((await readFile(log, 'utf8')).trim().split('\n'))).toEqual(
    new Set(['devbox', 'other']),
  );
});
