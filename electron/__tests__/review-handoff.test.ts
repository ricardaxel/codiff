import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import type { ReviewHandoffResolution } from '../../core/types.ts';

type ReviewHandoffController = {
  dispose: (webContentsId: number) => Promise<unknown>;
  poll: (webContentsId: number) => Promise<void>;
  publish: (webContentsId: number, root: string, request: unknown) => Promise<void>;
};

const require = createRequire(import.meta.url);
const { buildReviewHandoffDocument, createReviewHandoffController } =
  require('../review-handoff.cjs') as {
    buildReviewHandoffDocument: (
      root: string,
      request: unknown,
      now?: Date,
    ) => { comments: ReadonlyArray<Record<string, unknown>> };
    createReviewHandoffController: (options: {
      onError?: (error: unknown) => void;
      onResolved: (
        webContentsId: number,
        resolutions: ReadonlyArray<ReviewHandoffResolution>,
      ) => void;
      pollIntervalMs?: { local: number; remote: number };
    }) => ReviewHandoffController;
  };

const execFileAsync = promisify(execFile);
const skillScript = resolve('claude/skills/codiff/scripts/review-comments.mjs');

// Stands in for the remote shell client, running the command on this machine.
const fakeRemoteShell = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift 2
exec sh -c "exec $1"
`;

const comment = {
  body: 'increase the threshold to 70',
  context: '@@ -1,2 +1,3 @@\n+1256 | COVERAGE_THRESHOLD_ONLINE = 80',
  filePath: 'simply',
  id: 'comment-1',
  lineNumber: 1258,
  location: 'New line 1258',
  side: 'additions',
};

const createRepository = async (path: string) => {
  await execFileAsync('git', ['init', '-q', path], { env: getGitTestEnvironment() });
  return path;
};

const runSkill = async (args: ReadonlyArray<string>, cwd: string) =>
  execFileAsync(process.execPath, [skillScript, ...args], {
    cwd,
    env: getGitTestEnvironment(),
  });

const listResolved = async (repo: string) =>
  readdir(join(repo, '.git/codiff/resolved')).catch(() => []);

test('normalizes the published comments', () => {
  const document = buildReviewHandoffDocument(
    '/repo',
    {
      comments: [comment, { body: '   ', filePath: 'a', id: 'empty' }, { id: 'no-file' }, null],
      source: { type: 'working-tree' },
    },
    new Date('2026-10-28T00:00:00.000Z'),
  );
  expect(document).toEqual({
    comments: [comment],
    kind: 'codiff-review-comments',
    root: '/repo',
    source: { type: 'working-tree' },
    updatedAt: '2026-10-28T00:00:00.000Z',
    version: 1,
  });
});

test('the skill applies published comments and Codiff claims its resolutions', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-handoff-');
  const repo = await createRepository(join(directory.path, 'repo'));
  const resolved: Array<[number, ReadonlyArray<ReviewHandoffResolution>]> = [];
  const controller = createReviewHandoffController({
    onResolved: (webContentsId, resolutions) => resolved.push([webContentsId, resolutions]),
    pollIntervalMs: { local: 60_000, remote: 60_000 },
  });

  await controller.publish(1, repo, { comments: [comment], source: { type: 'working-tree' } });
  const listed = JSON.parse((await runSkill(['list'], repo)).stdout);
  expect(listed.comments).toEqual([comment]);
  expect(listed.root).toBe(repo);

  await runSkill(['resolve', 'comment-1', '--reply', 'Raised the threshold to 70.'], repo);
  expect((await runSkill(['list'], repo)).stdout).toMatch(/^No open Codiff review comments/);

  await controller.poll(1);
  expect(resolved).toEqual([
    [
      1,
      [
        {
          agent: 'claude',
          id: 'comment-1',
          reply: 'Raised the threshold to 70.',
          status: 'applied',
        },
      ],
    ],
  ]);
  expect(await listResolved(repo)).toEqual([]);

  // Codiff removes the file once no comment is waiting.
  await controller.publish(1, repo, { comments: [] });
  await expect(readFile(join(repo, '.git/codiff/review-comments.json'))).rejects.toThrow();
  await controller.dispose(1);
});

test('declined comments and window close', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-handoff-');
  const repo = await createRepository(join(directory.path, 'repo'));
  const resolved: Array<ReviewHandoffResolution> = [];
  const controller = createReviewHandoffController({
    onResolved: (_webContentsId, resolutions) => resolved.push(...resolutions),
    pollIntervalMs: { local: 60_000, remote: 60_000 },
  });

  await controller.publish(1, repo, { comments: [comment] });
  await runSkill(['resolve', 'comment-1', '--declined', '--reply', 'Which threshold?'], repo);
  await controller.poll(1);
  expect(resolved).toEqual([
    { agent: 'claude', id: 'comment-1', reply: 'Which threshold?', status: 'declined' },
  ]);

  await controller.dispose(1);
  await expect(readFile(join(repo, '.git/codiff/review-comments.json'))).rejects.toThrow();
  await expect(runSkill(['resolve', '../escape'], repo)).rejects.toThrow(
    /expected resolve <comment-id>/,
  );
});

test('publishes comments on the host of a remote repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-handoff-');
  const repo = await createRepository(join(directory.path, 'repo'));
  const shell = join(directory.path, 'remote-shell');
  await writeFile(shell, fakeRemoteShell);
  await chmod(shell, 0o755);
  using _environment = createTemporaryEnvironment({ CODIFF_SSH_PATH: shell });
  const resolved: Array<ReviewHandoffResolution> = [];
  const controller = createReviewHandoffController({
    onResolved: (_webContentsId, resolutions) => resolved.push(...resolutions),
    pollIntervalMs: { local: 60_000, remote: 60_000 },
  });
  const root = `ssh://devbox${repo}`;

  await controller.publish(7, root, { comments: [comment] });
  const listed = JSON.parse((await runSkill(['list'], repo)).stdout);
  expect(listed.comments).toEqual([comment]);
  expect(listed.root).toBe(root);

  await runSkill(['resolve', 'comment-1'], repo);
  await mkdir(join(repo, '.git/codiff/resolved'), { recursive: true });
  await writeFile(join(repo, '.git/codiff/resolved/garbage.json'), 'not json');
  await controller.poll(7);
  expect(resolved).toEqual([{ agent: 'claude', id: 'comment-1', reply: '', status: 'applied' }]);
  expect(await listResolved(repo)).toEqual([]);

  await controller.dispose(7);
  await expect(readFile(join(repo, '.git/codiff/review-comments.json'))).rejects.toThrow();
});
