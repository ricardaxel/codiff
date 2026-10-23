import { execFile } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

type Options = { showUntracked?: boolean };

const require = createRequire(import.meta.url);
const { readRepositoryState } = require('../git-state.cjs') as {
  readRepositoryState: (
    launchPath: string,
    source?: { type: 'working-tree' },
    options?: Options,
  ) => Promise<{ files: ReadonlyArray<{ path: string; status: string }> }>;
};
const { readRepositoryWatcherSnapshot } = require('../repository-watcher.cjs') as {
  readRepositoryWatcherSnapshot: (
    root: string,
    exactPaths?: Iterable<string>,
    knownDirtyPaths?: Iterable<string>,
    options?: Options,
  ) => Promise<{ pathSignatures: Record<string, string> }>;
};

const execFileAsync = promisify(execFile);

test('the untracked setting alone decides whether untracked files show', async () => {
  await using directory = await createTemporaryDirectory('codiff-untracked-');
  const repo = await realpath(directory.path);
  using _environment = createTemporaryEnvironment(getGitTestEnvironment());
  const git = (...args: Array<string>) => execFileAsync('git', ['-C', repo, ...args]);
  await git('init', '-q');
  await writeFile(join(repo, 'tracked.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'Initial');
  await writeFile(join(repo, 'tracked.txt'), 'two\n');
  await writeFile(join(repo, 'scratch.txt'), 'notes\n');

  const paths = async (options?: Options) =>
    (await readRepositoryState(repo, { type: 'working-tree' }, options)).files.map(
      (file) => `${file.status}:${file.path}`,
    );

  expect(await paths()).toEqual(['untracked:scratch.txt', 'modified:tracked.txt']);
  expect(await paths({ showUntracked: false })).toEqual(['modified:tracked.txt']);
  expect(
    Object.keys(
      (await readRepositoryWatcherSnapshot(repo, [], [], { showUntracked: false })).pathSignatures,
    ),
  ).toEqual(['tracked.txt']);

  // Git's own setting only affects `git status`, so the toggle can still show them.
  await git('config', 'status.showUntrackedFiles', 'no');
  expect(await paths()).toEqual(['untracked:scratch.txt', 'modified:tracked.txt']);
  expect(await paths({ showUntracked: false })).toEqual(['modified:tracked.txt']);
});
