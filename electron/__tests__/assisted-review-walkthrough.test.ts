import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { buildAssistedWalkthrough } = require('../assisted-review/walkthrough.cjs') as {
  buildAssistedWalkthrough: (status: any, state: any) => any;
};

const patch = (start: number) => `@@ -${start},1 +${start},1 @@\n-old ${start}\n+new ${start}\n`;

const state = {
  files: [
    {
      path: 'a.ts',
      sections: [{ id: 'a.ts:range', kind: 'range', patch: patch(3) + patch(40) }],
      status: 'modified',
    },
    {
      path: 'b.ts',
      sections: [{ id: 'b.ts:range', kind: 'range', patch: patch(1) }],
      status: 'modified',
    },
  ],
  root: '/repo',
  source: { assistedReview: true, base: 'b', head: 'h', symmetric: false, type: 'range' },
};

const status = (overrides: Record<string, unknown> = {}) => ({
  annotations: [
    {
      category: 'decision',
      file: 'a.ts',
      id: 'n1',
      line: 3,
      line_end: 3,
      side: 'new',
      text: 'Why.',
    },
  ],
  branch: 'feature',
  briefing: 'First paragraph.\n\nSecond paragraph.',
  stops: [{ file: 'a.ts', id: 's1', line: 40, line_end: 40, side: 'new', title: 'Second hunk' }],
  ...overrides,
});

test('anchors a stop to the hunk covering its lines and keeps the briefing as markdown', () => {
  const walkthrough = buildAssistedWalkthrough(status(), state);

  expect(walkthrough.agent).toBe('assisted-review');
  expect(walkthrough.focus).toBe('First paragraph.\n\nSecond paragraph.');
  const [stop] = walkthrough.chapters[0].stops;
  expect(stop.hunkIds).toEqual(['a.ts:range:h2']);
  expect(stop.prose).toBe('Second hunk');
  // Everything the agent did not mention is still reviewable.
  expect(JSON.stringify(walkthrough.support)).toContain('a.ts:range:h1');
  expect(JSON.stringify(walkthrough.support)).toContain('b.ts:range:h1');
});

test('narrates a stop with the annotations overlapping its lines', () => {
  const walkthrough = buildAssistedWalkthrough(
    status({ stops: [{ file: 'a.ts', id: 's1', line: 2, line_end: 4, side: 'new', title: 'T' }] }),
    state,
  );

  expect(walkthrough.chapters[0].stops[0].prose).toBe('- **Decision:** Why.');
});

test('falls back to the nearest hunk and skips stops outside the diff', () => {
  const walkthrough = buildAssistedWalkthrough(
    status({
      stops: [
        { file: 'a.ts', id: 's1', line: 30, line_end: 30, side: 'new', title: 'Near second' },
        { file: 'gone.ts', id: 's2', line: 1, line_end: 1, side: 'new', title: 'Unchanged file' },
      ],
    }),
    state,
  );

  expect(walkthrough.chapters[0].stops.map((stop: any) => stop.hunkIds)).toEqual([
    ['a.ts:range:h2'],
  ]);
});

test('returns null without anything to show', () => {
  expect(buildAssistedWalkthrough(status({ stops: [] }), state)).toBeNull();
  expect(
    buildAssistedWalkthrough(
      status({
        stops: [{ file: 'gone.ts', id: 's', line: 1, line_end: 1, side: 'new', title: 'x' }],
      }),
      state,
    ),
  ).toBeNull();
});

test('groups stops by chapter with their narration, extra anchors and support groups', () => {
  const walkthrough = buildAssistedWalkthrough(
    status({
      chapters: [{ blurb: 'The fix.', icon: 'bug', id: 'core', title: 'Core' }],
      stops: [
        {
          also: [{ file: 'b.ts', line: 1, line_end: 1, side: 'new' }],
          chapter: 'core',
          file: 'a.ts',
          id: 's1',
          importance: 'critical',
          line: 3,
          line_end: 3,
          prose: 'Retries `once`.',
          side: 'new',
          summary: 'Bounds the retry.',
          title: 'Bound retries',
        },
      ],
      support: [
        {
          anchors: [{ file: 'a.ts', line: 40, line_end: 40, side: 'new' }],
          note: 'Rename only.',
          reason: 'Mechanical',
        },
      ],
    }),
    state,
  );

  const [chapter] = walkthrough.chapters;
  expect([chapter.id, chapter.title, chapter.icon, chapter.blurb]).toEqual([
    'core',
    'Core',
    'bug',
    'The fix.',
  ]);
  const [stop] = chapter.stops;
  expect(stop.hunkIds).toEqual(['a.ts:range:h1', 'b.ts:range:h1']);
  expect(stop.importance).toBe('critical');
  expect(stop.summary).toBe('Bounds the retry.');
  expect(stop.prose).toBe('Retries `once`.\n\n- **Decision:** Why.');
  const [group] = walkthrough.support;
  expect([group.reason, group.note, group.hunkIds]).toEqual([
    'Mechanical',
    'Rename only.',
    ['a.ts:range:h2'],
  ]);
});
