// @ts-check

const { git } = require('../git-state/common.cjs');
const { call } = require('./client.cjs');
const { discoverReviews, readConnection } = require('./sessions.cjs');
const { readMarkKeys, readVisibleCode, snapshotWorktree } = require('./snapshot.cjs');

const POLL_MS = 750;
const objectId = /^[0-9a-f]{40,64}$/;

/**
 * A connection to one assisted-review bridge session. The bridge owns every durable thing (human
 * comments, reviewed marks, questions); this object only relays them and never writes to disk.
 *
 * @param {{connectionFile?: string; launchPath: string; runtimeDir?: string}} options
 */
const openSession = async ({ connectionFile, launchPath, runtimeDir }) => {
  let connection;
  let root;
  if (connectionFile) {
    connection = readConnection(connectionFile);
    root = connection.root;
  } else {
    root = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const reviews = await discoverReviews(root, { runtimeDir });
    if (reviews.length === 0) {
      throw new Error(`No live assisted review found for ${root}. Ask the agent to begin one.`);
    }
    if (reviews.length > 1) {
      throw new Error(
        `Several assisted reviews are live for ${root}; pass one connection file: ${reviews
          .map((review) => review.file)
          .join(', ')}`,
      );
    }
    connection = reviews[0].connection;
  }

  /** @param {any} state */
  const accept = (state) => {
    if (state.root !== root || state.review_id !== connection.review_id) {
      throw new Error('The review bridge answered for a different review');
    }
    return state;
  };
  let status = accept(await call(connection, 'status'));
  if (status.stale) {
    throw new Error('This review is stale: tracked files changed since the agent began it.');
  }

  // Writes replace the whole set and are dropped by the bridge unless their revision grows.
  const revisions = { comments: 0, reviewed: 0 };
  /** @param {'comments' | 'reviewed'} kind */
  const nextRevision = (kind) => {
    revisions[kind] = Math.max(revisions[kind] + 1, Date.now());
    return revisions[kind];
  };
  // Bumped when a save starts and again when it ends. A poll that overlapped either may hold
  // pre-save data and is discarded, or it would overwrite what the user just wrote.
  let writes = 0;
  /** @param {'save_comments' | 'save_reviewed'} method @param {'comments' | 'reviewed'} kind @param {Record<string, unknown>} value */
  const save = async (method, kind, value) => {
    writes += 1;
    try {
      const result = await call(connection, method, {
        [kind]: value,
        review_id: connection.review_id,
        revision: nextRevision(kind),
      });
      if (result.saved !== false) {
        status = { ...status, [kind]: value };
      }
      return result;
    } finally {
      writes += 1;
    }
  };

  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };

  return {
    /** The range source that makes the existing comparison code show `git diff <base_commit>`. */
    async readSource() {
      return {
        assistedReview: true,
        base: status.base_commit,
        head: await snapshotWorktree(root),
        symmetric: false,
        type: /** @type {const} */ ('range'),
      };
    },

    root,

    getStatus: () => status,

    markKeys: (
      /** @type {ReadonlyArray<{oldPath?: string; path: string}>} */ files,
      /** @type {string} */ head,
    ) => readMarkKeys(root, status.base_commit, head, files),

    /**
     * @param {{annotation_id?: string; file: string; head: string; line: number; line_end: number; question: string; question_id: string; side: 'old' | 'new'}} request
     */
    async ask(request) {
      if (!objectId.test(request.head)) {
        throw new Error('Invalid snapshot');
      }
      // The request comes from the renderer: pass on only the fields the bridge defines.
      const { annotation_id, file, line, line_end, question, question_id, side } = request;
      return call(connection, 'ask', {
        annotation_id,
        file,
        line,
        line_end,
        question,
        question_id,
        review_id: connection.review_id,
        side,
        snapshot: status.snapshot,
        visible_code: await readVisibleCode(root, status.base_commit, request.head, request),
      });
    },

    saveComments: (/** @type {Record<string, unknown>} */ comments) =>
      save('save_comments', 'comments', comments),

    saveReviewed: (/** @type {Record<string, number>} */ reviewed) =>
      save('save_reviewed', 'reviewed', reviewed),

    /**
     * Polls `status`, calling `listener` with every change. Any error ends the session, like the
     * Neovim front end: a review that cannot be reached must not keep accepting writes.
     *
     * @param {(update: {error?: string; status?: any}) => void} listener
     */
    watch(listener) {
      let last = JSON.stringify(status);
      let busy = false;
      timer = setInterval(async () => {
        if (busy) {
          return;
        }
        busy = true;
        const started = writes;
        try {
          const next = accept(await call(connection, 'status'));
          const serialized = JSON.stringify(next);
          if (started === writes && serialized !== last) {
            last = serialized;
            status = next;
            listener({ status });
          }
        } catch (error) {
          stop();
          listener({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          busy = false;
        }
      }, POLL_MS);
      return stop;
    },
  };
};

module.exports = { openSession };
