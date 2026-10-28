// @ts-check

// Review comment handoff lets an agent pull the review comments written in
// Codiff and report back which ones it handled. Codiff writes the open comments
// to `<git dir>/codiff/review-comments.json` on the machine that holds the
// repository, so an agent running there (locally, or on the host of a remote
// repository) reads them with the installed `codiff` skill. The skill writes
// one `resolved/<id>.json` file per handled comment, which Codiff claims and
// shows as the agent's reply.

const { mkdir, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises');
const { join, posix } = require('node:path');
const { git } = require('./git-state/common.cjs');
const { parseRemoteRepositoryPath, runRemoteCommand } = require('./remote-repository.cjs');

const REVIEW_HANDOFF_DIRECTORY = 'codiff';
const REVIEW_HANDOFF_FILE = 'review-comments.json';
const REVIEW_HANDOFF_RESOLVED_DIRECTORY = 'resolved';
const LOCAL_POLL_INTERVAL_MS = 1500;
const REMOTE_POLL_INTERVAL_MS = 3000;
const MAX_COMMENTS = 200;
const MAX_TEXT_LENGTH = 20_000;
/** @type {ReadonlyArray<'claude' | 'codex' | 'opencode' | 'pi'>} */
const AGENTS = ['claude', 'codex', 'opencode', 'pi'];

/**
 * @typedef {{
 *   anchor?: 'file';
 *   body: string;
 *   context: string;
 *   filePath: string;
 *   id: string;
 *   lineNumber?: number;
 *   location: string;
 *   side?: 'additions' | 'deletions';
 *   startLineNumber?: number;
 *   startSide?: 'additions' | 'deletions';
 * }} ReviewHandoffComment
 * @typedef {{
 *   comments: ReadonlyArray<ReviewHandoffComment>;
 *   source?: unknown;
 * }} ReviewHandoffRequest
 * @typedef {{
 *   agent?: 'claude' | 'codex' | 'opencode' | 'pi';
 *   id: string;
 *   reply: string;
 *   status: 'applied' | 'declined';
 * }} ReviewHandoffResolution
 */

// Remote scripts receive the handoff directory as `$1`.
const REMOTE_WRITE_SCRIPT = `set -eu
mkdir -p "$1"
tmp="$1/.${REVIEW_HANDOFF_FILE}.$$"
cat > "$tmp"
mv "$tmp" "$1/${REVIEW_HANDOFF_FILE}"`;
const REMOTE_REMOVE_SCRIPT = `rm -f "$1/${REVIEW_HANDOFF_FILE}"`;
// Claim each resolution with `mv` so it is read once, and separate them with NUL.
const REMOTE_CLAIM_SCRIPT = `set -u
for file in "$1"/${REVIEW_HANDOFF_RESOLVED_DIRECTORY}/*.json; do
  [ -f "$file" ] || continue
  claimed="$file.claimed.$$"
  mv "$file" "$claimed" 2>/dev/null || continue
  cat "$claimed"
  printf '\\000'
  rm -f "$claimed"
done`;

/** @param {unknown} value */
const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @param {number} [maxLength] */
const readText = (value, maxLength = MAX_TEXT_LENGTH) =>
  typeof value === 'string' ? value.slice(0, maxLength) : '';

/** @param {unknown} value */
const readLineNumber = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/** @param {unknown} value */
const readSide = (value) => (value === 'additions' || value === 'deletions' ? value : undefined);

/** @param {unknown} input @returns {ReviewHandoffComment | null} */
const normalizeReviewHandoffComment = (input) => {
  if (!isRecord(input)) {
    return null;
  }
  const id = readText(input.id, 128);
  const filePath = readText(input.filePath, 4096);
  const body = readText(input.body).trim();
  if (!id || !filePath || !body) {
    return null;
  }
  const lineNumber = readLineNumber(input.lineNumber);
  const side = readSide(input.side);
  const startLineNumber = readLineNumber(input.startLineNumber);
  const startSide = readSide(input.startSide);
  return {
    ...(input.anchor === 'file' ? { anchor: 'file' } : {}),
    body,
    context: readText(input.context),
    filePath,
    id,
    ...(lineNumber != null ? { lineNumber } : {}),
    location: readText(input.location, 256) || 'File',
    ...(side ? { side } : {}),
    ...(startLineNumber != null ? { startLineNumber } : {}),
    ...(startSide ? { startSide } : {}),
  };
};

/** @param {string} root @param {unknown} request */
const buildReviewHandoffDocument = (root, request, now = new Date()) => {
  const comments = (isRecord(request) && Array.isArray(request.comments) ? request.comments : [])
    .slice(0, MAX_COMMENTS)
    .map(normalizeReviewHandoffComment)
    .filter((comment) => comment != null);
  return {
    comments,
    kind: 'codiff-review-comments',
    root,
    ...(isRecord(request) && isRecord(request.source) ? { source: request.source } : {}),
    updatedAt: now.toISOString(),
    version: 1,
  };
};

/** @param {unknown} input @returns {ReviewHandoffResolution | null} */
const normalizeReviewHandoffResolution = (input) => {
  if (!isRecord(input)) {
    return null;
  }
  const id = readText(input.id, 128);
  if (!id) {
    return null;
  }
  const agent = AGENTS.find((candidate) => candidate === input.agent);
  return {
    ...(agent ? { agent } : {}),
    id,
    reply: readText(input.reply).trim(),
    status: input.status === 'declined' ? 'declined' : 'applied',
  };
};

/** @param {string} text */
const parseReviewHandoffResolution = (text) => {
  try {
    return normalizeReviewHandoffResolution(JSON.parse(text));
  } catch {
    return null;
  }
};

/** @param {string} root */
const getReviewHandoffDirectory = async (root) => {
  const gitDirectory = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  if (!gitDirectory) {
    throw new Error(`Could not find the Git directory of ${root}.`);
  }
  return parseRemoteRepositoryPath(root)
    ? posix.join(gitDirectory, REVIEW_HANDOFF_DIRECTORY)
    : join(gitDirectory, REVIEW_HANDOFF_DIRECTORY);
};

/** @param {string} root @param {string} directory @param {string} script @param {string} [input] */
const runRemoteScript = (root, directory, script, input) => {
  const remote = parseRemoteRepositoryPath(root);
  if (!remote) {
    throw new Error(`${root} is not a remote repository.`);
  }
  return runRemoteCommand(remote, ['sh', '-c', script, 'sh', directory], input);
};

/** @param {string} root @param {string} directory @param {ReturnType<typeof buildReviewHandoffDocument>} document */
const writeReviewHandoff = async (root, directory, document) => {
  if (document.comments.length === 0) {
    await removeReviewHandoff(root, directory);
    return;
  }
  const content = `${JSON.stringify(document, null, 2)}\n`;
  if (parseRemoteRepositoryPath(root)) {
    await runRemoteScript(root, directory, REMOTE_WRITE_SCRIPT, content);
    return;
  }
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${REVIEW_HANDOFF_FILE}.${process.pid}`);
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, join(directory, REVIEW_HANDOFF_FILE));
};

/** @param {string} root @param {string} directory */
const removeReviewHandoff = async (root, directory) => {
  if (parseRemoteRepositoryPath(root)) {
    await runRemoteScript(root, directory, REMOTE_REMOVE_SCRIPT);
    return;
  }
  await rm(join(directory, REVIEW_HANDOFF_FILE), { force: true });
};

/** @param {string} root @param {string} directory @returns {Promise<Array<ReviewHandoffResolution>>} */
const claimReviewHandoffResolutions = async (root, directory) => {
  /** @type {Array<string>} */
  let texts = [];
  if (parseRemoteRepositoryPath(root)) {
    const output = await runRemoteScript(root, directory, REMOTE_CLAIM_SCRIPT);
    texts = output.toString('utf8').split('\0');
  } else {
    const resolvedDirectory = join(directory, REVIEW_HANDOFF_RESOLVED_DIRECTORY);
    /** @type {Array<string>} */
    let names = [];
    try {
      names = await readdir(resolvedDirectory);
    } catch {
      return [];
    }
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const claimedPath = join(resolvedDirectory, `${name}.claimed.${process.pid}`);
      try {
        await rename(join(resolvedDirectory, name), claimedPath);
        texts.push(await readFile(claimedPath, 'utf8'));
        await rm(claimedPath, { force: true });
      } catch {
        // Another Codiff window claimed it first.
      }
    }
  }
  return texts
    .filter((text) => text.trim())
    .map(parseReviewHandoffResolution)
    .filter((resolution) => resolution != null);
};

/**
 * Keeps each window's comments published and delivers the agent's
 * resolutions back to that window while it has comments waiting.
 *
 * @param {{
 *   onError?: (error: unknown) => void;
 *   onResolved: (webContentsId: number, resolutions: ReadonlyArray<ReviewHandoffResolution>) => void;
 *   pollIntervalMs?: {local: number; remote: number};
 * }} options
 */
const createReviewHandoffController = ({
  onError = () => {},
  onResolved,
  pollIntervalMs = { local: LOCAL_POLL_INTERVAL_MS, remote: REMOTE_POLL_INTERVAL_MS },
}) => {
  /**
   * @type {Map<number, {
   *   directory: Promise<string>;
   *   polling: boolean;
   *   root: string;
   *   timer: ReturnType<typeof setInterval> | null;
   *   writes: Promise<unknown>;
   * }>}
   */
  const windows = new Map();

  /** @param {number} webContentsId */
  const stopPolling = (webContentsId) => {
    const entry = windows.get(webContentsId);
    if (entry?.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
  };

  /** @param {number} webContentsId */
  const poll = async (webContentsId) => {
    const entry = windows.get(webContentsId);
    if (!entry || entry.polling) {
      return;
    }
    entry.polling = true;
    try {
      const resolutions = await claimReviewHandoffResolutions(entry.root, await entry.directory);
      if (resolutions.length > 0 && windows.get(webContentsId) === entry) {
        onResolved(webContentsId, resolutions);
      }
    } catch (error) {
      onError(error);
    } finally {
      entry.polling = false;
    }
  };

  /** @param {number} webContentsId @param {string} root */
  const getEntry = (webContentsId, root) => {
    const current = windows.get(webContentsId);
    if (current?.root === root) {
      return current;
    }
    if (current) {
      dispose(webContentsId);
    }
    const directory = getReviewHandoffDirectory(root);
    directory.catch(() => {});
    const entry = { directory, polling: false, root, timer: null, writes: Promise.resolve() };
    windows.set(webContentsId, entry);
    return entry;
  };

  /** @param {number} webContentsId @param {string} root @param {unknown} request */
  const publish = (webContentsId, root, request) => {
    const entry = getEntry(webContentsId, root);
    const document = buildReviewHandoffDocument(root, request);
    if (document.comments.length > 0 && !entry.timer) {
      entry.timer = setInterval(
        () => void poll(webContentsId),
        parseRemoteRepositoryPath(root) ? pollIntervalMs.remote : pollIntervalMs.local,
      );
      entry.timer.unref?.();
    } else if (document.comments.length === 0) {
      stopPolling(webContentsId);
    }
    const write = entry.writes.then(async () =>
      writeReviewHandoff(root, await entry.directory, document),
    );
    entry.writes = write.catch(onError);
    return write;
  };

  /** @param {number} webContentsId */
  const dispose = (webContentsId) => {
    const entry = windows.get(webContentsId);
    if (!entry) {
      return Promise.resolve();
    }
    stopPolling(webContentsId);
    windows.delete(webContentsId);
    const hasOtherWindow = [...windows.values()].some((other) => other.root === entry.root);
    return hasOtherWindow
      ? entry.writes
      : entry.writes
          .then(async () => removeReviewHandoff(entry.root, await entry.directory))
          .catch(onError);
  };

  return { dispose, poll, publish };
};

module.exports = {
  REVIEW_HANDOFF_FILE,
  buildReviewHandoffDocument,
  claimReviewHandoffResolutions,
  createReviewHandoffController,
  getReviewHandoffDirectory,
  normalizeReviewHandoffResolution,
  writeReviewHandoff,
};
