// @ts-check

const { git } = require('../git-state/common.cjs');
const {
  formatRemoteRepositoryPath,
  parseRemoteRepositoryPath,
} = require('../remote-repository.cjs');
const { call } = require('./client.cjs');
const { discoverRemoteReviews, openRemoteConnection } = require('./remote.cjs');
const { discoverReviews, readConnection } = require('./sessions.cjs');
const { readMarkKeys, readVisibleCode, snapshotWorktree } = require('./snapshot.cjs');

const POLL_MS = 750;
const objectId = /^[0-9a-f]{40,64}$/;

/**
 * @param {ReadonlyArray<{file: string}>} reviews
 * @param {(file: string) => string} [label]
 */
const pickOne = (reviews, label = (file) => file) => {
  if (reviews.length === 0) {
    throw new Error('No live assisted review found. Ask the agent to begin one.');
  }
  if (reviews.length > 1) {
    throw new Error(
      `Several assisted reviews are live; pass one connection file: ${reviews
        .map((review) => label(review.file))
        .join(', ')}`,
    );
  }
  return reviews[0];
};

/**
 * Finds the review to show and connects to it. A remote repository (`launchPath` or
 * `connectionFile` addressed like a `--remote` repository) reaches its host's bridge through a
 * forwarded socket, closed by `close`.
 *
 * @param {{anywhere?: boolean; connectionFile?: string; launchPath: string; runtimeDir?: string}} options
 * @returns {Promise<{close: () => void; connection: import('./client.cjs').Connection; repositoryRoot: string}>}
 */
const connect = async ({ anywhere, connectionFile, launchPath, runtimeDir }) => {
  const remoteFile = connectionFile ? parseRemoteRepositoryPath(connectionFile) : null;
  if (remoteFile) {
    const { close, connection } = await openRemoteConnection(remoteFile, remoteFile.path);
    return {
      close,
      connection,
      repositoryRoot: formatRemoteRepositoryPath({ ...remoteFile, path: connection.root }),
    };
  }
  if (connectionFile) {
    const connection = readConnection(connectionFile);
    return { close: () => {}, connection, repositoryRoot: connection.root };
  }

  // The review of the current repository if there is one, else (when asked) the only live
  // review anywhere on that machine, so Codiff can be launched from any directory.
  const toplevel = await git(launchPath, ['rev-parse', '--show-toplevel']).then(
    (output) => output.trim(),
    () => null,
  );
  const remote = parseRemoteRepositoryPath(toplevel ?? launchPath);
  if (remote) {
    let reviews = toplevel === null ? [] : await discoverRemoteReviews(remote, remote.path);
    if (reviews.length === 0 && anywhere) {
      reviews = await discoverRemoteReviews(remote, null);
    }
    try {
      const { close, connection } = pickOne(reviews, (file) => `${remote.destination}:${file}`);
      return {
        close,
        connection,
        repositoryRoot: formatRemoteRepositoryPath({ ...remote, path: connection.root }),
      };
    } catch (error) {
      for (const review of reviews) {
        review.close();
      }
      throw error;
    }
  }

  let reviews = toplevel === null ? [] : await discoverReviews(toplevel, { runtimeDir });
  if (reviews.length === 0 && anywhere) {
    reviews = await discoverReviews(null, { runtimeDir });
  }
  const { connection } = pickOne(reviews);
  return { close: () => {}, connection, repositoryRoot: connection.root };
};

/**
 * A connection to one assisted-review bridge session. The bridge owns every durable thing (human
 * comments, reviewed marks, questions); this object only relays them and never writes to disk.
 *
 * `anywhere` lets discovery fall back to the only live review of any repository (the explicit
 * `--assisted-review`); otherwise only a review of `launchPath`'s own repository is used.
 *
 * @param {{anywhere?: boolean; connectionFile?: string; launchPath: string; runtimeDir?: string}} options
 */
const openSession = async (options) => {
  const { close, connection, repositoryRoot } = await connect(options);
  // `root` is where Codiff reads the repository (a remote path for a remote review); the bridge
  // knows the repository by its path on its own host.
  const root = repositoryRoot;
  const bridgeRoot = connection.root;

  /** @param {any} state */
  const accept = (state) => {
    if (state.root !== bridgeRoot || state.review_id !== connection.review_id) {
      throw new Error('The review bridge answered for a different review');
    }
    return state;
  };
  let status;
  try {
    status = accept(await call(connection, 'status'));
    if (status.stale) {
      throw new Error('This review is stale: tracked files changed since the agent began it.');
    }
  } catch (error) {
    close();
    throw error;
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

  /** The commit read in a commits-mode review, else null. @returns {{parent: string; sha: string} | null} */
  const currentCommit = () =>
    status.commits?.find((/** @type {any} */ commit) => commit.sha === status.current_commit) ??
    null;
  // The old side of the reviewed diff: the commit's parent, or the merge base.
  const diffBase = () => currentCommit()?.parent ?? status.base_commit;

  /** @type {((update: {error?: string; status?: any}) => void) | undefined} */
  let notify;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };

  return {
    /**
     * The range source that makes the existing comparison code show the reviewed diff:
     * `git diff <base_commit>` of the working tree, or the current commit against its parent.
     */
    async readSource() {
      const commit = currentCommit();
      return {
        assistedReview: true,
        base: commit?.parent ?? status.base_commit,
        head: commit?.sha ?? (await snapshotWorktree(root)),
        symmetric: false,
        type: /** @type {const} */ ('range'),
      };
    },

    root,

    /** Stops polling and closes a remote review's forwarded socket. */
    close() {
      stop();
      close();
    },

    getStatus: () => status,

    markKeys: (
      /** @type {ReadonlyArray<{oldPath?: string; path: string}>} */ files,
      /** @type {string} */ head,
    ) => readMarkKeys(root, diffBase(), head, files),

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
        commit: status.current_commit ?? undefined,
        file,
        line,
        line_end,
        question,
        question_id,
        review_id: connection.review_id,
        side,
        snapshot: status.snapshot,
        visible_code: await readVisibleCode(root, diffBase(), request.head, request),
      });
    },

    /**
     * Selects the commit to read (0-based) in a commits-mode review. The bridge owns the current
     * commit, so every front end follows; the new status is pushed at once instead of next poll.
     *
     * @param {number} index
     */
    async setCommit(index) {
      await call(connection, 'set_commit', { index, review_id: connection.review_id });
      status = accept(await call(connection, 'status'));
      notify?.({ status });
    },

    /**
     * Ends this review round: the bridge hands the user's comments to the agent, which may begin
     * the next round on the same connection.
     */
    async endReview() {
      await call(connection, 'end_review', { review_id: connection.review_id });
      status = accept(await call(connection, 'status'));
      notify?.({ status });
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
      notify = (update) => {
        last = JSON.stringify(update.status);
        listener(update);
      };
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
