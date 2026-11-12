import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { readMarkKeys, readVisibleCode, sliceLines, snapshotWorktree } =
  require('../assisted-review/snapshot.cjs') as {
    readMarkKeys: (
      root: string,
      base: string,
      snapshot: string,
      files: Array<{ oldPath?: string; path: string }>,
    ) => Promise<Record<string, string>>;
    readVisibleCode: (
      root: string,
      base: string,
      snapshot: string,
      range: { file: string; line: number; line_end: number; side: 'new' | 'old' },
    ) => Promise<string>;
    sliceLines: (content: string, line: number, lineEnd: number) => string;
    snapshotWorktree: (root: string) => Promise<string>;
  };

const roots: Array<string> = [];
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { force: true, recursive: true });
  }
});

const git = (root: string, ...args: Array<string>) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

/** base has a.txt, b.txt, c.txt; the worktree then edits a, stages a new d, deletes c, adds untracked e. */
const createRepository = () => {
  const root = mkdtempSync(join(tmpdir(), 'codiff-ar-repo-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  for (const name of ['a', 'b', 'c']) {
    writeFileSync(join(root, `${name}.txt`), `${name}1\n${name}2\n`);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();

  writeFileSync(join(root, 'b.txt'), 'b1\nb2 committed\n');
  git(root, 'commit', '-qam', 'committed change');

  writeFileSync(join(root, 'a.txt'), 'a1\na2 edited\n');
  writeFileSync(join(root, 'd.txt'), 'd1\n');
  git(root, 'add', 'd.txt');
  unlinkSync(join(root, 'c.txt'));
  writeFileSync(join(root, 'e.txt'), 'untracked\n');
  return { base, root };
};

test('snapshot diffs exactly like `git diff <base>` and leaves the repository alone', async () => {
  const { base, root } = createRepository();
  const statusBefore = git(root, 'status', '--porcelain');
  const headBefore = git(root, 'rev-parse', 'HEAD');

  const snapshot = await snapshotWorktree(root);

  const expected = git(root, 'diff', '--name-status', base, '--');
  expect(git(root, 'diff', '--name-status', base, snapshot)).toBe(expected);
  expect(
    expected
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[1])
      .toSorted(),
  ).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  expect(git(root, 'diff', base, snapshot)).toBe(git(root, 'diff', base, '--'));
  expect(git(root, 'status', '--porcelain')).toBe(statusBefore);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
});

test('mark keys follow review.nvim: old blob, new blob, path, with missing sides', async () => {
  const { base, root } = createRepository();
  const snapshot = await snapshotWorktree(root);

  const keys = await readMarkKeys(root, base, snapshot, [
    { path: 'a.txt' },
    { path: 'c.txt' },
    { path: 'd.txt' },
  ]);

  const blob = (spec: string) => git(root, 'rev-parse', spec).trim();
  expect(keys['a.txt']).toBe(
    `${blob(`${base}:a.txt`)} ${git(root, 'hash-object', 'a.txt').trim()} a.txt`,
  );
  expect(keys['c.txt']).toBe(`${blob(`${base}:c.txt`)} missing c.txt`);
  expect(keys['d.txt']).toBe(`missing ${blob(':d.txt')} d.txt`);
});

test('visible code is the base file for old and the snapshot for new', async () => {
  const { base, root } = createRepository();
  const snapshot = await snapshotWorktree(root);

  expect(
    await readVisibleCode(root, base, snapshot, {
      file: 'a.txt',
      line: 1,
      line_end: 2,
      side: 'old',
    }),
  ).toBe('a1\na2');
  expect(
    await readVisibleCode(root, base, snapshot, {
      file: 'a.txt',
      line: 2,
      line_end: 2,
      side: 'new',
    }),
  ).toBe('a2 edited');
});

test('sliceLines matches Python splitlines', () => {
  expect(sliceLines('x\ny\n', 1, 2)).toBe('x\ny');
  expect(sliceLines('x\r\ny\rz', 1, 3)).toBe('x\ny\nz');
  expect(sliceLines(`x\fy${String.fromCharCode(0x2028)}z\n\n`, 1, 4)).toBe('x\ny\nz\n');
  expect(sliceLines('x\ny', 2, 2)).toBe('y');
});
