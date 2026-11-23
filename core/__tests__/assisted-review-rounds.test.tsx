import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vite-plus/test';
import { walkthroughFinishAction } from '../app/components/walkthrough/parts.tsx';
import {
  assistedReviewNotice,
  assistedReviewViewKey,
  endReviewLabel,
} from '../lib/assisted-review.ts';
import { renderBlockMarkdown } from '../lib/markdown.tsx';
import type { AssistedReviewStatus } from '../types.ts';

test('agent briefings render as headings, lists and paragraphs', () => {
  const html = renderToStaticMarkup(
    <>
      {renderBlockMarkdown(
        [
          '## Intent',
          'Retry once',
          'on timeouts.',
          '',
          '- **Validation:** `npm test`',
          '- Gap: no load test',
          '  beyond one client.',
          '1. Read the model',
          'After.',
        ].join('\n'),
      )}
    </>,
  );

  expect(html).toBe(
    '<h4>Intent</h4><p>Retry once on timeouts.</p>' +
      '<ul><li><strong>Validation:</strong> <code class="walkthrough-inline-code">npm test</code></li>' +
      '<li>Gap: no load test beyond one client.</li></ul>' +
      '<ol><li>Read the model</li></ol><p>After.</p>',
  );
});

test('an assisted review ends its round where other walkthroughs are shared', () => {
  const share = vi.fn();
  const onEnd = vi.fn();
  expect(walkthroughFinishAction({ onShareWalkthrough: share })?.label).toBe('Share walkthrough');
  const end = walkthroughFinishAction({
    endReview: { ended: false, label: 'Finish commit', onEnd, title: 'Next' },
    onShareWalkthrough: share,
  });
  expect(end).toMatchObject({ disabled: false, label: 'Finish commit', onClick: onEnd });
  expect(
    walkthroughFinishAction({
      endReview: { ended: true, label: 'Review ended', onEnd, title: '' },
    }),
  ).toMatchObject({ disabled: true, label: 'Review ended' });
  expect(walkthroughFinishAction({})).toBeNull();
});

test('commit by commit, the round finishes each commit until the last ends the review', () => {
  const commits = ['a', 'b'].map((sha) => ({ parent: '', prepared: true, sha, subject: sha }));
  const status = {
    commits,
    current_commit: 'a',
    mode: 'commits',
  } as unknown as AssistedReviewStatus;
  expect(endReviewLabel(status).label).toBe('Finish commit');
  expect(endReviewLabel({ ...status, current_commit: 'b' }).label).toBe('End review');
  expect(endReviewLabel({ ...status, mode: 'full' }).label).toBe('End review');
  expect(endReviewLabel({ ...status, ended: true }).label).toBe('Review ended');
});

test('the agent calling for the user outranks the round notices', () => {
  const status = { ended: true, round: 2, stale: true } as unknown as AssistedReviewStatus;
  expect(assistedReviewNotice(status)).toBe(
    'Review round 2 ended: the agent is handling your comments.',
  );
  expect(assistedReviewNotice({ ...status, attention: { id: '1', text: 'Drop commit 1?' } })).toBe(
    'Claude needs you in the conversation: Drop commit 1?',
  );
  expect(assistedReviewNotice({ ...status, ended: false, stale: false })).toBeNull();
});

test('a new round or commit is a different view of the review', () => {
  const status = { current_commit: null, round: 1 } as unknown as AssistedReviewStatus;
  expect(assistedReviewViewKey(status)).toBe('1:');
  expect(assistedReviewViewKey({ ...status, round: 2 })).toBe('2:');
  expect(assistedReviewViewKey({ ...status, current_commit: 'abc' })).toBe('1:abc');
  expect(assistedReviewViewKey(null)).toBeNull();
});
