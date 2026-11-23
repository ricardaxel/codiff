import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Also stands in for the app's walkthrough result: when FAKE_WALKTHROUGH_RESULT is
// set, it is written to the path following --walkthrough-result-file, after
// FAKE_WALKTHROUGH_RESULT_DELAY seconds when that is set.
const loggerScript =
  '#!/bin/sh\nprevious=""\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\n  if [ "$previous" = "--walkthrough-result-file" ] && [ -n "$FAKE_WALKTHROUGH_RESULT" ]; then\n    (sleep "${FAKE_WALKTHROUGH_RESULT_DELAY:-0}"; printf "%s\\n" "$FAKE_WALKTHROUGH_RESULT" > "$arg") &\n  fi\n  previous="$arg"\ndone\n';

export const createFakeOpenLogger = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const openPath = join(fakeBin, 'open');

  await mkdir(fakeBin);
  await writeFile(openPath, loggerScript);
  await chmod(openPath, 0o755);

  return {
    directory,
    env: {
      ...process.env,
      OPEN_ARGS_FILE: logPath,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    readArgs: async () => (await readFile(logPath, 'utf8')).trim().split('\n'),
    reset: () => writeFile(logPath, ''),
    async [Symbol.asyncDispose]() {
      await rm(directory, { force: true, recursive: true });
    },
  };
};

export const createFakeCommandLogger = async (prefix: string, commandName: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const commandPath = join(directory, commandName);
  const logPath = join(directory, 'args.txt');

  await writeFile(commandPath, loggerScript);
  await chmod(commandPath, 0o755);

  return {
    commandPath,
    directory,
    env: {
      ...process.env,
      OPEN_ARGS_FILE: logPath,
    },
    readArgs: async () => (await readFile(logPath, 'utf8')).trim().split('\n'),
    async [Symbol.asyncDispose]() {
      await rm(directory, { force: true, recursive: true });
    },
  };
};
