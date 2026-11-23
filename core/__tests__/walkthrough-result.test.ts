import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { waitForWalkthroughResult } from '../../bin/walkthrough-result.js';
import { createTemporaryDirectory } from './helpers/resources.ts';

const options = { pollIntervalMs: 2, timeoutMs: 100 };

test('walkthrough result waiting returns once the app reports', async () => {
  await using directory = await createTemporaryDirectory('codiff-walkthrough-result-');
  const resultPath = join(directory.path, 'result.txt');

  const result = waitForWalkthroughResult(resultPath, new EventEmitter(), options);
  setTimeout(() => {
    void writeFile(resultPath, 'ready\n');
  }, 20);

  await expect(result).resolves.toEqual({ status: 'ready' });
});

test('walkthrough result waiting returns why the file cannot be applied', async () => {
  await using directory = await createTemporaryDirectory('codiff-walkthrough-result-');
  const resultPath = join(directory.path, 'result.txt');
  await writeFile(
    resultPath,
    'unavailable\nUnresolved hunk ids: a.ts:.1.\nThis diff has no hunks.\n',
  );

  await expect(waitForWalkthroughResult(resultPath, new EventEmitter(), options)).resolves.toEqual({
    reason: 'Unresolved hunk ids: a.ts:.1.\nThis diff has no hunks.',
    status: 'unavailable',
  });
});

test('walkthrough result waiting fails when the app never reports', async () => {
  await using directory = await createTemporaryDirectory('codiff-walkthrough-result-');

  await expect(
    waitForWalkthroughResult(join(directory.path, 'result.txt'), new EventEmitter(), {
      ...options,
      timeoutMs: 10,
    }),
  ).rejects.toThrow('Codiff did not check the walkthrough within 0.01 seconds.');
});

test('walkthrough result waiting fails when the app exits without reporting', async () => {
  await using directory = await createTemporaryDirectory('codiff-walkthrough-result-');
  const child = new EventEmitter();

  const result = waitForWalkthroughResult(join(directory.path, 'result.txt'), child, options);
  child.emit('exit', 1, null);

  await expect(result).rejects.toThrow('Codiff exited before checking the walkthrough (code 1).');
});
