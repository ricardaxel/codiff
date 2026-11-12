// @ts-check

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { call } = require('./client.cjs');

const MAX_CONNECTION_BYTES = 65_536;

/** @param {string} target @param {'file' | 'directory'} kind */
const isPrivate = (target, kind) => {
  try {
    const info = fs.lstatSync(target);
    const matches = kind === 'file' ? info.isFile() : info.isDirectory();
    // Mode must hide the entry from group and others: the token inside is a capability.
    return matches && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
};

/**
 * Reads and validates a `connection.json` the way the Neovim front end does.
 *
 * @param {string} file
 * @returns {import('./client.cjs').Connection}
 */
const readConnection = (file) => {
  if (!isPrivate(file, 'file')) {
    throw new Error('Connection file must be private and owned by you');
  }
  if (fs.lstatSync(file).size > MAX_CONNECTION_BYTES) {
    throw new Error('Connection file is too large');
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const text = (/** @type {unknown} */ field) => typeof field === 'string' && field !== '';
  if (
    !(
      text(value?.socket) &&
      text(value?.token) &&
      typeof value.root === 'string' &&
      text(value.review_id)
    )
  ) {
    throw new Error('Invalid connection file');
  }
  return value;
};

/** @param {string} directory */
const runtimeDirectory = (directory) =>
  path.join(
    directory || process.env.XDG_RUNTIME_DIR || os.tmpdir(),
    `assisted-review-${process.getuid?.()}`,
  );

/**
 * Live, non-stale reviews of `root`, as `{file, connection}` pairs.
 *
 * @param {string} root git toplevel
 * @param {{runtimeDir?: string}} [options]
 */
const discoverReviews = async (root, options = {}) => {
  const parent = runtimeDirectory(options.runtimeDir ?? '');
  if (!isPrivate(parent, 'directory')) {
    return [];
  }

  /** @type {Array<{connection: import('./client.cjs').Connection; file: string}>} */
  const candidates = [];
  for (const name of fs.readdirSync(parent)) {
    const directory = path.join(parent, name);
    if (!name.startsWith('session-') || !isPrivate(directory, 'directory')) {
      continue;
    }
    try {
      const file = path.join(directory, 'connection.json');
      const connection = readConnection(file);
      if (connection.root === root) {
        candidates.push({ connection, file });
      }
    } catch {
      // A half-written or foreign session is simply not a candidate.
    }
  }

  // Probe concurrently so dead endpoints do not cause serial five-second waits.
  const probed = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const state = await call(candidate.connection, 'status');
        return state.root === root &&
          state.review_id === candidate.connection.review_id &&
          state.stale === false
          ? { ...candidate, state }
          : null;
      } catch {
        return null;
      }
    }),
  );
  const seen = new Set();
  return probed
    .filter(/** @returns {entry is NonNullable<typeof entry>} */ (entry) => entry !== null)
    .filter(({ state }) => !seen.has(state.review_id) && seen.add(state.review_id))
    .sort((a, b) => a.state.review_id.localeCompare(b.state.review_id));
};

module.exports = { discoverReviews, readConnection };
