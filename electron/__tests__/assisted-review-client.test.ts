import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { call } = require('../assisted-review/client.cjs') as {
  call: (
    connection: { socket: string; token: string },
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};
const { discoverReviews, readConnection } = require('../assisted-review/sessions.cjs') as {
  discoverReviews: (
    root: string,
    options?: { runtimeDir?: string },
  ) => Promise<Array<{ file: string; state: { review_id: string } }>>;
  readConnection: (file: string) => {
    review_id: string;
    root: string;
    socket: string;
    token: string;
  };
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiff-ar-'));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
};

/** A fake bridge: `reply` receives the parsed request line and returns the raw bytes to send. */
const fakeBridge = async (
  directory: string,
  reply: (request: Record<string, unknown>) => string | null,
  name = 'editor.sock',
) => {
  const socket = join(directory, name);
  const requests: Array<Record<string, unknown>> = [];
  const server = net.createServer((client) => {
    let received = '';
    client.on('data', (chunk) => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end === -1) {
        return;
      }
      const request = JSON.parse(received.slice(0, end));
      requests.push(request);
      const response = reply(request);
      if (response !== null) {
        client.end(response);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(() => server.close());
  return { requests, socket };
};

test('sends one JSON line with the token and returns the reply', async () => {
  const { requests, socket } = await fakeBridge(
    temporaryDirectory(),
    () => JSON.stringify({ question_id: 'q1' }) + '\n',
  );

  const reply = await call({ socket, token: 'secret' }, 'ask', { question_id: 'q1' });

  expect(reply).toEqual({ question_id: 'q1' });
  expect(requests).toEqual([{ method: 'ask', question_id: 'q1', token: 'secret' }]);
});

test('rejects with the bridge error message', async () => {
  const { socket } = await fakeBridge(
    temporaryDirectory(),
    () => JSON.stringify({ error: 'Review is stale' }) + '\n',
  );

  await expect(call({ socket, token: 't' }, 'status')).rejects.toThrow('Review is stale');
});

test('rejects invalid, oversize and unfinished replies', async () => {
  const directory = temporaryDirectory();
  const invalid = await fakeBridge(directory, () => 'not json\n', 'a.sock');
  const huge = await fakeBridge(directory, () => 'x'.repeat(1024 * 1024 + 1), 'b.sock');
  const closed = await fakeBridge(directory, () => '', 'c.sock');

  await expect(call({ socket: invalid.socket, token: 't' }, 'status')).rejects.toThrow(
    'Invalid review bridge response',
  );
  await expect(call({ socket: huge.socket, token: 't' }, 'status')).rejects.toThrow('too large');
  await expect(call({ socket: closed.socket, token: 't' }, 'status')).rejects.toThrow('closed');
});

test('rejects oversize requests without connecting', async () => {
  await expect(
    call({ socket: '/nonexistent', token: 't' }, 'ask', { text: 'x'.repeat(1024 * 1024) }),
  ).rejects.toThrow('too large');
});

const privateFile = (file: string, value: unknown, mode = 0o600) => {
  writeFileSync(file, JSON.stringify(value), { mode });
  chmodSync(file, mode);
};

test('readConnection enforces ownership mode and shape', () => {
  const directory = temporaryDirectory();
  const good = { review_id: 'r1', root: '/repo', socket: '/s', token: 't' };
  privateFile(join(directory, 'good.json'), good);
  privateFile(join(directory, 'open.json'), good, 0o644);
  privateFile(join(directory, 'bad.json'), { ...good, token: '' });

  expect(readConnection(join(directory, 'good.json'))).toEqual(good);
  expect(() => readConnection(join(directory, 'open.json'))).toThrow('private');
  expect(() => readConnection(join(directory, 'bad.json'))).toThrow('Invalid connection file');
});

test('discoverReviews keeps live, non-stale reviews of this root', async () => {
  const runtime = temporaryDirectory();
  const parent = join(runtime, `assisted-review-${process.getuid?.()}`);
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o700);

  const session = async (name: string, root: string, review: string, stale: boolean) => {
    const directory = join(parent, name);
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const { socket } = await fakeBridge(
      directory,
      () => JSON.stringify({ review_id: review, root, stale }) + '\n',
    );
    privateFile(join(directory, 'connection.json'), {
      review_id: review,
      root,
      socket,
      token: 't',
    });
  };
  await session('session-live', '/repo', 'live', false);
  await session('session-stale', '/repo', 'stale', true);
  await session('session-other', '/elsewhere', 'other', false);
  mkdirSync(join(parent, 'session-dead'), { mode: 0o700 });
  privateFile(join(parent, 'session-dead', 'connection.json'), {
    review_id: 'dead',
    root: '/repo',
    socket: join(parent, 'session-dead', 'gone.sock'),
    token: 't',
  });

  const reviews = await discoverReviews('/repo', { runtimeDir: runtime });

  expect(reviews.map((review) => review.state.review_id)).toEqual(['live']);
});
