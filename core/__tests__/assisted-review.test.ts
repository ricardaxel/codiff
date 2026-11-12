import { expect, test } from 'vite-plus/test';
import {
  commentsFromBridge,
  commentsToBridge,
  findingsFromAnnotations,
  reviewedFromViewed,
  sameComments,
  viewedFromReviewed,
} from '../lib/assisted-review.ts';
import type { RepositoryState } from '../types.ts';

const file = (path: string, fingerprint: string) => ({
  fingerprint,
  path,
  sections: [{ id: `${path}:snapshot` }],
  status: 'modified',
});

const state = {
  assistedReview: {
    markKeys: { 'a.txt': 'oa na a.txt', 'b c.txt': 'ob nb b c.txt' },
  },
  files: [file('a.txt', 'fa'), file('b c.txt', 'fb')],
} as unknown as RepositoryState;

test('viewed files are exactly the files whose mark key the bridge holds', () => {
  expect(viewedFromReviewed(state, { 'ob nb b c.txt': 5, 'unrelated x z.txt': 9 })).toEqual({
    'b c.txt': 'fb',
  });
});

test('viewing rebuilds this review’s marks and keeps other files’ marks and times', () => {
  const previous = {
    'ob nb b c.txt': 5,
    'old-a x a.txt': 7, // stale blobs of a file in this review: can never match again
    'oz nz elsewhere.txt': 3,
  };

  expect(reviewedFromViewed(state, { 'a.txt': 'fa', 'b c.txt': 'fb' }, previous, 100)).toEqual({
    'oa na a.txt': 100,
    'ob nb b c.txt': 5,
    'oz nz elsewhere.txt': 3,
  });
  expect(reviewedFromViewed(state, { 'a.txt': 'changed-since' }, previous, 100)).toEqual({
    'oz nz elsewhere.txt': 3,
  });
});

test('agent annotations become titled new-side findings', () => {
  expect(
    findingsFromAnnotations([
      {
        category: 'needs_verification',
        file: 'a.txt',
        id: 'n1',
        line: 3,
        line_end: 4,
        side: 'new',
        text: 'Check',
      },
      {
        category: 'decision',
        file: 'a.txt',
        id: 'n2',
        line: 1,
        line_end: 1,
        side: 'old',
        text: 'Gone',
      },
    ]),
  ).toEqual([
    {
      description: 'Check',
      filePath: 'a.txt',
      fingerprint: 'n1',
      lineNumber: 3,
      severity: 'major',
      status: 'new',
      title: 'Agent · Needs verification',
    },
  ]);
});

const bridgeComments = {
  'a.txt': [
    { file: 'a.txt', id: 'c1', line: 2, line_end: 4, side: 'new', text: 'range', type: 'issue' },
    {
      branch: 'feat',
      created_at: 12,
      file: 'a.txt',
      id: 'c2',
      line: 1,
      line_end: 1,
      side: 'old',
      text: 'old',
      type: 'praise',
    },
  ],
  'gone.txt': [
    {
      file: 'gone.txt',
      id: 'c3',
      line: 1,
      line_end: 1,
      side: 'new',
      text: 'elsewhere',
      type: 'note',
    },
  ],
} as const;

test('bridge comments round trip through Codiff comments, keeping unshown files', () => {
  const { retained, shown } = commentsFromBridge(state, bridgeComments);

  expect(
    shown.map((comment) => [comment.id, comment.lineNumber, comment.startLineNumber, comment.side]),
  ).toEqual([
    ['c1', 4, 2, 'additions'],
    ['c2', 1, undefined, 'deletions'],
  ]);
  expect(shown[0].sectionId).toBe('a.txt:snapshot');
  expect(retained.map((comment) => comment.id)).toEqual(['c3']);
  expect(commentsToBridge(shown, retained)).toEqual(bridgeComments);
  // An echo of our own save is recognised as unchanged whatever the key order.
  expect(sameComments(commentsToBridge(shown, retained), bridgeComments)).toBe(true);
  expect(sameComments(commentsToBridge(shown.slice(1), retained), bridgeComments)).toBe(false);
});

test('drafts, file comments and remote comments are not sent, and ranges stay on one side', () => {
  const base = { body: 'text', filePath: 'a.txt', sectionId: 's' };
  const sent = commentsToBridge([
    { ...base, body: '  ', id: 'draft', lineNumber: 1, side: 'additions' },
    { ...base, anchor: 'file', id: 'file-level' },
    { ...base, id: 'remote', isReadOnly: true, lineNumber: 1, side: 'additions' },
    { ...base, id: 'bad id!', lineNumber: 1, side: 'additions' },
    {
      ...base,
      id: 'cross',
      lineNumber: 9,
      side: 'additions',
      startLineNumber: 2,
      startSide: 'deletions',
    },
    {
      ...base,
      id: 'backwards',
      lineNumber: 3,
      side: 'deletions',
      startLineNumber: 8,
      startSide: 'deletions',
    },
  ]);

  expect(
    sent['a.txt'].map((comment) => [
      comment.id,
      comment.line,
      comment.line_end,
      comment.side,
      comment.type,
    ]),
  ).toEqual([
    ['cross', 9, 9, 'new', 'note'],
    ['backwards', 3, 8, 'old', 'note'],
  ]);
});
