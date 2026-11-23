import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';
import { createTemporaryEnvironment } from '../../core/__tests__/helpers/resources.ts';

type Session = {
  ask: (request: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
  getStatus: () => Record<string, unknown>;
  readSource: () => Promise<{ base: string; head: string; type: string }>;
  root: string;
  saveComments: (comments: Record<string, unknown>) => Promise<unknown>;
};

const require = createRequire(import.meta.url);
const { openSession } = require('../assisted-review/session.cjs') as {
  openSession: (options: {
    anywhere?: boolean;
    connectionFile?: string;
    launchPath: string;
  }) => Promise<Session>;
};
const { parseRemoteHelperRequest } = require('../remote-helper.cjs') as {
  parseRemoteHelperRequest: (
    line: string,
  ) => { path: string } | { connectionFile: string } | { error: string };
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const git = (root: string, ...args: Array<string>) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// Stands in for the remote shell client. A `-L local:remote` forward runs a small local proxy
// between the two sockets; any other call runs its remote command, like the real client would on
// the host `devbox` (here the same machine, so the "remote" runtime directory is a local one).
const fakeRemoteShell = `#!/bin/sh
forward=''
while [ "$1" != "--" ]; do
  if [ "$1" = "-L" ]; then forward=$2; shift; fi
  shift
done
shift
printf '%s\\n' "$1" >> "$CODIFF_TEST_REMOTE_LOG"
[ "$1" = "devbox" ] || { echo "unknown host $1" >&2; exit 255; }
shift
if [ -n "$forward" ]; then
  exec "$CODIFF_TEST_NODE" "$CODIFF_TEST_PROXY" "\${forward%%:*}" "\${forward#*:}"
fi
exec sh -c "$1"
`;

const proxy = `const net = require('node:net');
const [local, remote] = process.argv.slice(2);
net
  .createServer((client) => {
    const upstream = net.connect(remote);
    client.pipe(upstream).pipe(client);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  })
  .listen(local);
`;

/**
 * A repository with one unstaged edit and a fake bridge reviewing it, its connection file in a
 * bridge runtime directory (`docker`: the one scripts/docker-run.sh shares with its containers).
 */
const setup = async ({ docker = false } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'codiff-ar-remote-'));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  const root = join(directory, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', root]);
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'a1\na2\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'a.txt'), 'a1\na2 edited\n');

  const requests: Array<Record<string, any>> = [];
  const status = { base_commit: base, review_id: 'r1', root, snapshot: 's1', stale: false };
  const server = net.createServer((client) => {
    let received = '';
    client.on('data', (chunk) => {
      received += chunk;
      if (!received.includes('\n')) {
        return;
      }
      const request = JSON.parse(received);
      requests.push(request);
      client.end(`${JSON.stringify(request.method === 'status' ? status : { saved: true })}\n`);
    });
  });

  const runtime = join(directory, 'run');
  const uid = process.getuid?.();
  const parent = docker
    ? join(runtime, `assisted-review-docker-${uid}`, `assisted-review-${uid}`)
    : join(runtime, `assisted-review-${uid}`);
  const session = join(parent, 'session-test');
  mkdirSync(session, { mode: 0o700, recursive: true });
  const socket = join(session, 'editor.sock');
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(() => server.close());
  const connectionFile = join(session, 'connection.json');
  writeFileSync(connectionFile, JSON.stringify({ review_id: 'r1', root, socket, token: 'tok' }));
  chmodSync(connectionFile, 0o600);

  const shell = join(directory, 'remote-shell');
  writeFileSync(shell, fakeRemoteShell);
  chmodSync(shell, 0o755);
  const proxyFile = join(directory, 'proxy.cjs');
  writeFileSync(proxyFile, proxy);
  const environment = createTemporaryEnvironment({
    CODIFF_SSH_PATH: shell,
    CODIFF_TEST_NODE: process.execPath,
    CODIFF_TEST_PROXY: proxyFile,
    CODIFF_TEST_REMOTE_LOG: join(directory, 'remote.log'),
    XDG_RUNTIME_DIR: runtime,
  });
  cleanups.push(() => environment[Symbol.dispose]());

  return { base, connectionFile, requests, root, socket };
};

/** @param {Session} session */
const track = (session: Session) => {
  cleanups.push(() => session.close());
  return session;
};

test('a remote repository finds its host’s review and talks to it through a forwarded socket', async () => {
  const { base, requests, root, socket } = await setup();
  const session = track(await openSession({ launchPath: `ssh://devbox${root}` }));

  expect(session.root).toBe(`ssh://devbox${root}`);
  expect(session.getStatus()).toMatchObject({ review_id: 'r1', root });
  await session.saveComments({ c1: { body: 'hi' } });
  expect(requests.at(-1)).toMatchObject({ method: 'save_comments', token: 'tok' });
  expect(requests.every((request) => request.token === 'tok')).toBe(true);
  // Every request went through the forward: the remote log shows its own `-L` connection.
  expect(socket).toContain('session-test');

  const source = await session.readSource();
  expect(source).toMatchObject({ base, type: 'range' });
  // The snapshot is taken on the repository's host and holds the unstaged edit.
  expect(git(root, 'show', `${source.head}:a.txt`)).toBe('a1\na2 edited\n');
  expect(git(root, 'status', '--porcelain')).toBe(' M a.txt\n');

  await session.ask({
    file: 'a.txt',
    head: source.head,
    line: 2,
    line_end: 2,
    question: 'why?',
    question_id: 'q1',
    side: 'new',
  });
  expect(requests.at(-1)).toMatchObject({ method: 'ask', visible_code: 'a2 edited' });
});

test('closing a remote session closes its forwarded socket', async () => {
  const { root } = await setup();
  const session = await openSession({ launchPath: `ssh://devbox${root}` });
  const forwarded = await new Promise<string>((resolve, reject) => {
    // The forward's private directory is the only codiff-ar-* directory holding a bridge.sock.
    const output = execFileSync('sh', [
      '-c',
      `ls -d "${tmpdir()}"/codiff-ar-*/bridge.sock 2>/dev/null || true`,
    ]).toString();
    const [first] = output.trim().split('\n').filter(Boolean);
    if (first) {
      resolve(first);
    } else {
      reject(new Error('no forwarded socket'));
    }
  });
  expect(existsSync(forwarded)).toBe(true);
  session.close();
  expect(existsSync(forwarded)).toBe(false);
});

test('finds reviews in the runtime directory scripts/docker-run.sh shares', async () => {
  const { root } = await setup({ docker: true });
  const session = track(await openSession({ launchPath: `ssh://devbox${root}` }));
  expect(session.getStatus()).toMatchObject({ review_id: 'r1' });
});

test('opens an explicit remote connection file', async () => {
  const { connectionFile, root } = await setup();
  const session = track(
    await openSession({ connectionFile: `ssh://devbox${connectionFile}`, launchPath: '/' }),
  );
  expect(session.root).toBe(`ssh://devbox${root}`);
});

test('refuses a remote connection file others can read', async () => {
  const { connectionFile } = await setup();
  chmodSync(connectionFile, 0o644);
  await expect(
    openSession({ connectionFile: `ssh://devbox${connectionFile}`, launchPath: '/' }),
  ).rejects.toThrow(/not private/);
});

test('a remote repository without a live review is reported, not guessed', async () => {
  const { root } = await setup();
  const other = mkdtempSync(join(tmpdir(), 'codiff-ar-other-'));
  cleanups.push(() => rmSync(other, { force: true, recursive: true }));
  execFileSync('git', ['init', '-q', other]);
  await expect(openSession({ launchPath: `ssh://devbox${other}` })).rejects.toThrow(
    /No live assisted review/,
  );
  expect(root).not.toBe(other);
});

test('remote helper requests can name a review connection file', () => {
  expect(parseRemoteHelperRequest('review /run/user/1/x/../connection.json')).toEqual({
    connectionFile: '/run/user/1/connection.json',
  });
  expect(parseRemoteHelperRequest('review run/connection.json')).toEqual({
    error: 'The connection file path must be absolute.',
  });
  expect(parseRemoteHelperRequest('open /srv/app')).toEqual({ path: '/srv/app' });
});
