import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { openSession } = require('../assisted-review/session.cjs') as {
  openSession: (options: {
    anywhere?: boolean;
    connectionFile?: string;
    launchPath: string;
    runtimeDir?: string;
  }) => Promise<{
    ask: (request: Record<string, unknown>) => Promise<unknown>;
    endReview: () => Promise<void>;
    readSource: () => Promise<{ base: string; head: string; type: string }>;
    saveComments: (comments: Record<string, unknown>) => Promise<unknown>;
    saveReviewed: (reviewed: Record<string, number>) => Promise<unknown>;
    setCommit: (index: number) => Promise<void>;
    watch: (listener: (update: { error?: string; status?: unknown }) => void) => () => void;
  }>;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const git = (root: string, ...args: Array<string>) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

/** A repository with a base commit and one unstaged edit, plus a fake bridge reviewing it. */
const setup = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiff-ar-session-'));
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
  let status: Record<string, unknown> = {
    base_commit: base,
    review_id: 'r1',
    root,
    snapshot: 'bridge-snapshot',
    stale: false,
  };
  let failing = false;
  const server = net.createServer((client) => {
    let received = '';
    client.on('data', (chunk) => {
      received += chunk;
      if (!received.includes('\n')) {
        return;
      }
      const request = JSON.parse(received);
      requests.push(request);
      client.end(
        `${JSON.stringify(failing ? { error: 'gone' } : request.method === 'status' ? status : { saved: true })}\n`,
      );
    });
  });
  const socket = join(directory, 'editor.sock');
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(() => server.close());
  const connectionFile = join(directory, 'connection.json');
  writeFileSync(connectionFile, JSON.stringify({ review_id: 'r1', root, socket, token: 'tok' }));
  chmodSync(connectionFile, 0o600);

  return {
    base,
    connectionFile,
    fail: () => {
      failing = true;
    },
    requests,
    root,
    setStatus: (next: Record<string, unknown>) => {
      status = { ...status, ...next };
    },
  };
};

test('reads the review as a range from base_commit to a worktree snapshot', async () => {
  const { base, connectionFile, root } = await setup();
  const session = await openSession({ connectionFile, launchPath: root });

  const source = await session.readSource();

  expect(source).toMatchObject({ base, symmetric: false, type: 'range' });
  expect(git(root, 'show', `${source.head}:a.txt`)).toBe('a1\na2 edited\n');
});

test('a commit-by-commit review reads and asks about the current commit against its parent', async () => {
  const { base, connectionFile, requests, root, setStatus } = await setup();
  git(root, 'commit', '-qam', 'edit');
  const sha = git(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'a.txt'), 'worktree only\n');
  const commits = [{ parent: base, prepared: true, sha, subject: 'edit' }];
  setStatus({ commits, current_commit: sha, mode: 'commits' });
  const session = await openSession({ connectionFile, launchPath: root });
  const updates: Array<unknown> = [];
  const stop = session.watch((update) => updates.push(update));
  cleanups.push(stop);

  expect(await session.readSource()).toMatchObject({ base, head: sha, type: 'range' });
  await session.ask({
    file: 'a.txt',
    head: sha,
    line: 2,
    line_end: 2,
    question: 'why?',
    question_id: 'q1',
    side: 'new',
  });
  expect(requests.at(-1)).toMatchObject({ commit: sha, visible_code: 'a2 edited' });
  await session.ask({
    file: 'a.txt',
    head: sha,
    line: 2,
    line_end: 2,
    question: 'was?',
    question_id: 'q2',
    side: 'old',
  });
  expect(requests.at(-1)).toMatchObject({ visible_code: 'a2' });

  await session.setCommit(0);
  expect(requests.at(-2)).toMatchObject({ index: 0, method: 'set_commit', review_id: 'r1' });
  expect(updates).toHaveLength(1);
});

test('ending the round tells the bridge and pushes the ended status at once', async () => {
  const { connectionFile, requests, root, setStatus } = await setup();
  const session = await openSession({ connectionFile, launchPath: root });
  const updates: Array<{ status?: any }> = [];
  cleanups.push(session.watch((update) => updates.push(update)));
  setStatus({ ended: true, round: 1 });

  await session.endReview();

  expect(requests.at(-2)).toMatchObject({ method: 'end_review', review_id: 'r1', token: 'tok' });
  expect(updates.at(-1)?.status).toMatchObject({ ended: true });
});

test('ask sends the code visible in the snapshot with the bridge snapshot id', async () => {
  const { connectionFile, requests, root } = await setup();
  const session = await openSession({ connectionFile, launchPath: root });
  const { head } = await session.readSource();

  await session.ask({
    file: 'a.txt',
    head,
    line: 2,
    line_end: 2,
    question: 'why?',
    question_id: 'q1',
    side: 'new',
  });

  expect(requests.at(-1)).toMatchObject({
    method: 'ask',
    review_id: 'r1',
    snapshot: 'bridge-snapshot',
    token: 'tok',
    visible_code: 'a2 edited',
  });
  await expect(
    session.ask({
      file: 'a.txt',
      head: '--oops',
      line: 1,
      line_end: 1,
      question: 'x',
      question_id: 'q2',
      side: 'new',
    }),
  ).rejects.toThrow('Invalid snapshot');
});

test('save revisions only grow, per kind', async () => {
  const { connectionFile, requests, root } = await setup();
  const session = await openSession({ connectionFile, launchPath: root });

  await session.saveComments({});
  await session.saveComments({});
  await session.saveReviewed({ 'x y a.txt': 5 });

  const [first, second, reviewed] = requests.filter((request) => request.method !== 'status');
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(reviewed).toMatchObject({ method: 'save_reviewed', reviewed: { 'x y a.txt': 5 } });
});

test('refuses a stale review', async () => {
  const { connectionFile, root, setStatus } = await setup();
  setStatus({ stale: true });

  await expect(openSession({ connectionFile, launchPath: root })).rejects.toThrow('stale');
});

test('watch reports status changes and ends on the first error', async () => {
  const { connectionFile, fail, root, setStatus } = await setup();
  const session = await openSession({ connectionFile, launchPath: root });
  const updates: Array<{ error?: string; status?: any }> = [];
  const stop = session.watch((update) => updates.push(update));
  cleanups.push(stop);

  setStatus({ questions: { q1: 'answered' } });
  await expect.poll(() => updates.length, { timeout: 3000 }).toBe(1);
  expect(updates[0].status.questions).toEqual({ q1: 'answered' });

  fail();
  await expect.poll(() => updates.length, { timeout: 3000 }).toBe(2);
  expect(updates[1].error).toContain('gone');
});

test('discovers a review of another repository only when asked to look anywhere', async () => {
  const { connectionFile, root } = await setup();
  const runtimeDir = mkdtempSync(join(tmpdir(), 'codiff-ar-runtime-'));
  cleanups.push(() => rmSync(runtimeDir, { force: true, recursive: true }));
  const parent = join(runtimeDir, `assisted-review-${process.getuid?.()}`);
  const directory = join(parent, 'session-1');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(parent, 0o700);
  copyFileSync(connectionFile, join(directory, 'connection.json'));
  chmodSync(join(directory, 'connection.json'), 0o600);
  const elsewhere = mkdtempSync(join(tmpdir(), 'codiff-ar-elsewhere-'));
  cleanups.push(() => rmSync(elsewhere, { force: true, recursive: true }));

  await expect(openSession({ launchPath: elsewhere, runtimeDir })).rejects.toThrow(
    'No live assisted review',
  );
  const found = await openSession({ anywhere: true, launchPath: elsewhere, runtimeDir });
  expect((found as unknown as { root: string }).root).toBe(root);
  const own = await openSession({ launchPath: root, runtimeDir });
  expect((own as unknown as { root: string }).root).toBe(root);
});
