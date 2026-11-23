import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { CodiffLaunchOptions, RepositoryState } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { createWalkthroughLaunchController } =
  require('../main/walkthrough-launch.cjs') as typeof import('../main/walkthrough-launch.cjs');

const createLaunch = async () => {
  const directory = await createTemporaryDirectory('codiff-walkthrough-launch-');
  const state: RepositoryState = {
    branch: 'main',
    files: ['a.ts', 'b.ts'].map((path) => ({
      fingerprint: path,
      path,
      sections: [
        {
          binary: false,
          id: `${path}:staged`,
          kind: 'staged',
          patch: '@@ -1 +1 @@\n-old\n+new\n',
        },
      ],
      status: 'modified',
    })),
    generatedAt: 1,
    launchPath: directory.path,
    root: directory.path,
    source: { type: 'working-tree' },
  };
  const input = {
    chapters: [
      {
        id: 'changes',
        stops: state.files.map(({ path }, index) => ({
          hunkIds: [`${path}:staged:h1`],
          id: `stop-${index}`,
          prose: 'Explain this change.',
          title: 'Change behavior',
        })),
        title: 'Changes',
      },
    ],
    kind: 'narrative',
    support: [],
    title: 'Review',
    version: 4,
  };
  const walkthroughFile = join(directory.path, 'walkthrough.json');
  const walkthroughResultFile = join(directory.path, 'result.txt');
  const launchOptions: CodiffLaunchOptions = {
    repositoryPathProvided: true,
    walkthrough: true,
    walkthroughFile,
    walkthroughResultFile,
  };
  await writeFile(walkthroughFile, JSON.stringify(input));

  let hasWindows = false;
  const openWindow = vi.fn(
    (_path: string, _launchOptions: CodiffLaunchOptions, _state?: Promise<RepositoryState>) => {
      hasWindows = true;
      return { webContents: { id: 1 } };
    },
  );
  const quit = vi.fn();
  const readRepositoryState = vi.fn(async () => state);
  const controller = createWalkthroughLaunchController({
    hasWindows: () => hasWindows,
    openWindow,
    quit,
    readRepositoryState,
  });

  return {
    ...directory,
    controller,
    input,
    launchOptions,
    open: () => controller.open(directory.path, launchOptions),
    openWindow,
    quit,
    readRepositoryState,
    state,
    walkthroughFile,
    walkthroughResultFile,
  };
};

test('the initial view keeps both stops after the diff and JSON change', async () => {
  await using launch = await createLaunch();
  await launch.open();
  expect(await readFile(launch.walkthroughResultFile, 'utf8')).toBe('ready\n');

  launch.readRepositoryState.mockResolvedValue({ ...launch.state, files: [] });
  await unlink(launch.walkthroughFile);

  // Reloaded windows can request their source explicitly rather than omitting it.
  expect(launch.controller.getInitialRepositoryState(1, { ...launch.state.source })).toBe(
    launch.state,
  );
  const walkthrough = launch.controller.takeInitialWalkthrough(1, { ...launch.state.source });
  expect(walkthrough?.chapters[0].stops).toHaveLength(2);
  expect(walkthrough?.repo).toEqual({ branch: 'main', root: launch.path });
  expect(walkthrough?.source).toEqual(launch.state.source);
  expect(await launch.openWindow.mock.calls[0][2]).toBe(launch.state);
  expect(launch.readRepositoryState).toHaveBeenCalledOnce();
  expect(launch.controller.takeInitialWalkthrough(1)).toBeUndefined();
  expect(launch.controller.getInitialRepositoryState(1)).toBeUndefined();
});

test('a partial hunk mismatch rejects the whole launch before opening a window', async () => {
  await using launch = await createLaunch();
  launch.input.chapters[0].stops[1].hunkIds = ['missing.ts:staged:h1'];
  await writeFile(launch.walkthroughFile, JSON.stringify(launch.input));
  await launch.open();

  expect(await readFile(launch.walkthroughResultFile, 'utf8')).toContain(
    'unavailable\nWalkthrough file could not be applied to this diff: Unresolved hunk ids: missing.ts:staged:h1.',
  );
  expect(launch.openWindow).not.toHaveBeenCalled();
  expect(launch.quit).toHaveBeenCalledOnce();
  expect(launch.controller.hasPending()).toBe(false);
});

test('a rejected launch and closing all windows do not quit during another check', async () => {
  await using launch = await createLaunch();
  const pending = Promise.withResolvers<RepositoryState>();
  launch.readRepositoryState
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error('Repository unavailable.'));

  const first = launch.open();
  const secondResultFile = join(launch.path, 'second-result.txt');
  await launch.controller.open(launch.path, {
    ...launch.launchOptions,
    walkthroughResultFile: secondResultFile,
  });
  expect(await readFile(secondResultFile, 'utf8')).toContain('unavailable\n');
  expect(launch.controller.hasPending()).toBe(true);
  launch.controller.quitIfIdle();
  expect(launch.quit).not.toHaveBeenCalled();

  pending.resolve(launch.state);
  await first;
  expect(await readFile(launch.walkthroughResultFile, 'utf8')).toBe('ready\n');
  expect(launch.openWindow).toHaveBeenCalledOnce();
  expect(launch.quit).not.toHaveBeenCalled();
  expect(launch.controller.hasPending()).toBe(false);
});

test('the app quits only after all overlapping failed checks finish', async () => {
  await using launch = await createLaunch();
  const firstRead = Promise.withResolvers<RepositoryState>();
  const secondRead = Promise.withResolvers<RepositoryState>();
  launch.readRepositoryState
    .mockReturnValueOnce(firstRead.promise)
    .mockReturnValueOnce(secondRead.promise);

  const first = launch.open();
  const second = launch.controller.open(launch.path, {
    ...launch.launchOptions,
    walkthroughResultFile: join(launch.path, 'second-result.txt'),
  });
  firstRead.reject(new Error('First repository unavailable.'));
  await first;
  expect(launch.quit).not.toHaveBeenCalled();

  secondRead.reject(new Error('Second repository unavailable.'));
  await second;
  expect(launch.quit).toHaveBeenCalledOnce();
  expect(launch.controller.hasPending()).toBe(false);
});

test('a window creation failure is reported instead of acknowledging success', async () => {
  await using launch = await createLaunch();
  launch.openWindow.mockImplementationOnce(() => {
    throw new Error('Could not create window.');
  });
  await launch.open();

  expect(await readFile(launch.walkthroughResultFile, 'utf8')).toContain(
    'unavailable\nWalkthrough file could not be applied to this diff: Could not create window.',
  );
  expect(launch.controller.takeInitialWalkthrough(1)).toBeUndefined();
  expect(launch.quit).toHaveBeenCalledOnce();
});

test('switching sources or closing a window discards its initial walkthrough', async () => {
  await using launch = await createLaunch();
  await launch.open();
  expect(
    launch.controller.getInitialRepositoryState(1, { ref: 'HEAD', type: 'commit' }),
  ).toBeUndefined();
  expect(launch.controller.takeInitialWalkthrough(1)).toBeUndefined();

  await launch.open();
  launch.controller.clear(1);
  expect(launch.controller.takeInitialWalkthrough(1)).toBeUndefined();
});
