// @ts-check

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { gitBufferWithInput } = require('../git-state/common.cjs');

const execFileAsync = promisify(execFile);

/** @param {string} root @param {ReadonlyArray<string>} args @param {NodeJS.ProcessEnv} [env] */
const git = async (root, args, env = {}) =>
  (
    await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024 * 64,
    })
  ).stdout;

/**
 * Commits the tracked working tree (index plus unstaged edits, untracked files excluded) as a
 * dangling commit, so the ref-to-ref comparison machinery can diff `base..snapshot`. This is
 * exactly the bridge's scope: `git diff <base_commit> --`. The repository's own index and refs are
 * never touched; only unreachable objects are added.
 *
 * @param {string} root git toplevel
 * @returns {Promise<string>} commit id
 */
const snapshotWorktree = async (root) => {
  const index = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codiff-ar-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
    fs.copyFileSync(index, env.GIT_INDEX_FILE);
    // Git trusts a cached stat only for files older than the index file itself ("racy git"). A
    // fresh copy would look newer than an edit made in the same second as the last index write,
    // so date the copy one second before the original: such files are then always rehashed.
    const { atime, mtimeMs } = fs.statSync(index);
    fs.utimesSync(env.GIT_INDEX_FILE, atime, new Date(mtimeMs - 1000));
    await git(root, ['add', '-u'], env);
    const tree = (await git(root, ['write-tree'], env)).trim();
    const identity = {
      GIT_AUTHOR_EMAIL: 'codiff@localhost',
      GIT_AUTHOR_NAME: 'codiff',
      GIT_COMMITTER_EMAIL: 'codiff@localhost',
      GIT_COMMITTER_NAME: 'codiff',
    };
    return (
      await git(
        root,
        ['commit-tree', tree, '-p', 'HEAD', '-m', 'assisted-review snapshot'],
        identity,
      )
    ).trim();
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
};

/** @param {string} root @param {ReadonlyArray<string>} specs @returns {Promise<Array<string>>} blob or "missing" per spec */
const blobsFor = async (root, specs) => {
  if (specs.length === 0) {
    return [];
  }
  const output = (
    await gitBufferWithInput(
      root,
      ['cat-file', '--batch-check=%(objectname)'],
      `${specs.join('\n')}\n`,
    )
  ).toString('utf8');
  const lines = output.split('\n');
  return specs.map((_, index) =>
    /^[0-9a-f]{40,64}$/.test(lines[index] ?? '') ? lines[index] : 'missing',
  );
};

/**
 * review.nvim's reviewed-mark key, `"<old blob> <new blob> <path>"`, so marks made in either front
 * end match in both. The old side is the base file, the new side the working-tree blob (which the
 * snapshot holds), and a file missing on a side is `missing`.
 *
 * @param {string} root
 * @param {string} base base_commit
 * @param {string} snapshot
 * @param {ReadonlyArray<{oldPath?: string; path: string}>} files
 * @returns {Promise<Record<string, string>>} mark key by path
 */
const readMarkKeys = async (root, base, snapshot, files) => {
  const [oldBlobs, newBlobs] = await Promise.all([
    blobsFor(
      root,
      files.map((file) => `${base}:${file.oldPath || file.path}`),
    ),
    blobsFor(
      root,
      files.map((file) => `${snapshot}:${file.path}`),
    ),
  ]);
  return Object.fromEntries(
    files.map((file, index) => [file.path, `${oldBlobs[index]} ${newBlobs[index]} ${file.path}`]),
  );
};

// Python's `str.splitlines()` separators; U+2028/U+2029 are built from char codes so no raw line
// separator sits in the source.
const LINE_BREAK = new RegExp(
  `\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85${String.fromCharCode(0x2028, 0x2029)}]`,
);

/**
 * Python's `str.splitlines()` followed by `"\n".join(lines[line - 1:lineEnd])`, which is how the
 * bridge computes the code it compares `visible_code` with.
 *
 * @param {string} content @param {number} line @param {number} lineEnd
 */
const sliceLines = (content, line, lineEnd) => {
  const lines = content.split(LINE_BREAK);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.slice(line - 1, lineEnd).join('\n');
};

/**
 * The lines the reviewer is looking at: the base file for the old side, the snapshot for the new.
 *
 * @param {string} root @param {string} base @param {string} snapshot
 * @param {{file: string; line: number; line_end: number; side: 'old' | 'new'}} range
 */
const readVisibleCode = async (root, base, snapshot, range) =>
  sliceLines(
    await git(root, ['show', `${range.side === 'old' ? base : snapshot}:${range.file}`]),
    range.line,
    range.line_end,
  );

module.exports = { readMarkKeys, readVisibleCode, sliceLines, snapshotWorktree };
