// @ts-check

const { readFileSync, writeFileSync } = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const {
  assertWalkthroughHunkIdsResolve,
  normalizeNarrativeWalkthrough,
} = require('../narrative-walkthrough.cjs');

/**
 * @typedef {import('../../core/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {import('../../core/types.ts').NarrativeWalkthrough} NarrativeWalkthrough
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 */

/**
 * @param {{
 *   hasWindows: () => boolean;
 *   openWindow: (repositoryPath: string, launchOptions: CodiffLaunchOptions, state?: Promise<RepositoryState>) => {webContents: {id: number}};
 *   quit: () => void;
 *   readRepositoryState: (repositoryPath: string, launchOptions: CodiffLaunchOptions) => Promise<RepositoryState>;
 * }} options
 */
const createWalkthroughLaunchController = ({
  hasWindows,
  openWindow,
  quit,
  readRepositoryState,
}) => {
  let pendingChecks = 0;
  /** @type {Map<number, {state: RepositoryState; walkthrough: NarrativeWalkthrough}>} */
  const initialWalkthroughs = new Map();

  /** @param {number} webContentsId @param {ReviewSource} [source] */
  const getInitialSnapshot = (webContentsId, source) => {
    const snapshot = initialWalkthroughs.get(webContentsId);
    if (source && snapshot && !isDeepStrictEqual(source, snapshot.state.source)) {
      initialWalkthroughs.delete(webContentsId);
      return undefined;
    }
    return snapshot;
  };

  const quitIfIdle = () => {
    if (pendingChecks === 0 && !hasWindows()) {
      quit();
    }
  };

  /** @param {string} path @param {string | null} reason */
  const reportResult = (path, reason) => {
    try {
      writeFileSync(path, reason ? `unavailable\n${reason}\n` : 'ready\n', 'utf8');
    } catch {
      // An interrupted launcher may already have removed its result directory.
    }
  };

  return {
    /** @param {number} webContentsId */
    clear: (webContentsId) => initialWalkthroughs.delete(webContentsId),
    /** @param {number} webContentsId @param {ReviewSource} [source] */
    getInitialRepositoryState: (webContentsId, source) =>
      getInitialSnapshot(webContentsId, source)?.state,
    hasPending: () => pendingChecks > 0,
    /** @param {string} repositoryPath @param {CodiffLaunchOptions} launchOptions */
    open: async (repositoryPath, launchOptions) => {
      const { walkthroughFile, walkthroughResultFile } = launchOptions;
      if (!walkthroughFile || !walkthroughResultFile) {
        openWindow(repositoryPath, launchOptions);
        return;
      }

      pendingChecks += 1;
      try {
        let input;
        try {
          input = JSON.parse(readFileSync(walkthroughFile, 'utf8'));
        } catch (error) {
          reportResult(
            walkthroughResultFile,
            `Could not read walkthrough file: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }

        const state = await readRepositoryState(repositoryPath, launchOptions);
        assertWalkthroughHunkIdsResolve(input, state.files);
        const walkthrough = normalizeNarrativeWalkthrough(input, state.files, {
          branch: state.branch,
          generatedAt: state.generatedAt,
          root: state.root,
          source: state.source,
        });
        const window = openWindow(repositoryPath, launchOptions, Promise.resolve(state));
        // Both initial renderer requests must use the snapshot accepted at launch.
        initialWalkthroughs.set(window.webContents.id, { state, walkthrough });
        reportResult(walkthroughResultFile, null);
      } catch (error) {
        reportResult(
          walkthroughResultFile,
          `Walkthrough file could not be applied to this diff: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        pendingChecks -= 1;
        quitIfIdle();
      }
    },
    quitIfIdle,
    /** @param {number} webContentsId @param {ReviewSource} [source] */
    takeInitialWalkthrough: (webContentsId, source) => {
      const snapshot = getInitialSnapshot(webContentsId, source);
      initialWalkthroughs.delete(webContentsId);
      return snapshot?.walkthrough;
    },
  };
};

module.exports = { createWalkthroughLaunchController };
