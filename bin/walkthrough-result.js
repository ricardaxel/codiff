import { readFileSync } from 'node:fs';

// Covers app startup and the diff read, which can include fetching a pull request.
const walkthroughResultTimeoutMs = 60_000;

/**
 * Waits for the app to report whether a `--walkthrough-file` can be applied. The
 * app checks the file before opening a window and writes a `ready` line, or an
 * `unavailable` line followed by the reason.
 */
export const waitForWalkthroughResult = async (
  resultPath,
  child,
  { pollIntervalMs = 50, timeoutMs = walkthroughResultTimeoutMs } = {},
) => {
  const startedAt = Date.now();
  let childError = null;
  let childExit = null;
  child.once('error', (error) => {
    childError = error;
  });
  child.once('exit', (code, signal) => {
    childExit = { code, signal };
  });

  for (;;) {
    if (childError) {
      throw childError;
    }

    try {
      const [status, ...reason] = readFileSync(resultPath, 'utf8').trimEnd().split('\n');
      if (status === 'ready') {
        return { status };
      }
      if (status === 'unavailable') {
        return { reason: reason.join('\n'), status };
      }
    } catch {}

    if (childExit && childExit.code !== 0) {
      throw new Error(
        `Codiff exited before checking the walkthrough${
          childExit.signal ? ` (${childExit.signal})` : ` (code ${childExit.code})`
        }.`,
      );
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Codiff did not check the walkthrough within ${timeoutMs / 1000} seconds.`);
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
};
