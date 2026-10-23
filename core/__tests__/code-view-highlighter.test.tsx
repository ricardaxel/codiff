/**
 * @vitest-environment jsdom
 */

import { getHighlighterOptions, getSharedHighlighter } from '@pierre/diffs';
import { act } from 'react';
import { expect, test } from 'vite-plus/test';
import { useCodeViewHighlighter } from '../app/hooks/useCodeViewHighlighter.ts';
import type { CodiffSyntaxHighlighter } from '../config/types.ts';
import {
  getActiveCodeViewHighlighter,
  getCodeViewThemes,
  getReviewLanguages,
  getWorkerHighlighterOptions,
  resolveCodeViewHighlighter,
  switchCodeViewHighlighter,
} from '../lib/code-view-options.ts';
import { renderReact } from './helpers/react.tsx';

const waitForValue = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the highlighter.');
    }
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
};

const dSource = `module app.main;
import std.stdio;
/// Prints the origins.
void main() {
  auto origins = item.origin.names;
  writeln("Occurrences: ", origins.length);
}
`;

test('collects the languages of a review', () => {
  expect(getReviewLanguages(['src/a.ts', 'tools/b.d', 'README', 'src/c.ts', 'run.sh'])).toEqual([
    'd',
    'typescript',
    'zsh',
  ]);
});

test('automatic highlighting keeps the fast engine unless a language needs Shiki', async () => {
  expect(await resolveCodeViewHighlighter('auto', [])).toBe('highlights');
  expect(await resolveCodeViewHighlighter('auto', ['typescript', 'zsh', 'cpp'])).toBe('highlights');
  // D has no lexer in the fast engine, so the whole review uses Shiki.
  expect(await resolveCodeViewHighlighter('auto', ['typescript', 'd'])).toBe('shiki-js');
  expect(await resolveCodeViewHighlighter('highlights', ['d'])).toBe('highlights');
  expect(await resolveCodeViewHighlighter('shiki', [])).toBe('shiki-js');
});

function HighlighterHarness({
  onRender,
  paths,
  setting,
}: {
  onRender: (highlighter: string | null) => void;
  paths: ReadonlyArray<string>;
  setting: CodiffSyntaxHighlighter;
}) {
  onRender(useCodeViewHighlighter(setting, paths));
  return null;
}

test('the window engine is hidden while it is chosen or switched', async () => {
  const rendered: Array<string | null> = [];
  const record = (highlighter: string | null) => {
    if (rendered.at(-1) !== highlighter) {
      rendered.push(highlighter);
    }
  };
  const tsOnly = ['src/a.ts'];
  const withD = ['src/a.ts', 'tools/b.d'];

  await using view = await renderReact(
    <HighlighterHarness onRender={record} paths={tsOnly} setting="auto" />,
  );
  await waitForValue(() => rendered.at(-1) === 'highlights');
  // Code views stay unmounted until the engine is known.
  expect(rendered).toEqual([null, 'highlights']);

  await view.rerender(<HighlighterHarness onRender={record} paths={withD} setting="auto" />);
  await waitForValue(() => rendered.at(-1) === 'shiki-js');
  expect(rendered).toEqual([null, 'highlights', null, 'shiki-js']);
  expect(getActiveCodeViewHighlighter()).toBe('shiki-js');

  await view.rerender(<HighlighterHarness onRender={record} paths={withD} setting="highlights" />);
  await waitForValue(() => rendered.at(-1) === 'highlights');
  expect(getActiveCodeViewHighlighter()).toBe('highlights');
});

test('switching to Shiki colors D with the GitHub themes', async () => {
  expect(getActiveCodeViewHighlighter()).toBe('highlights');
  await switchCodeViewHighlighter('shiki-js');
  try {
    expect(getActiveCodeViewHighlighter()).toBe('shiki-js');
    const options = getWorkerHighlighterOptions('shiki-js');
    expect(options.theme).toEqual({ dark: 'github-dark', light: 'github-light' });

    const highlighter = await getSharedHighlighter(getHighlighterOptions('d', options));
    const { tokens } = highlighter.codeToTokens(dSource, {
      lang: 'd',
      theme: getCodeViewThemes('shiki-js').light,
    });
    const colors = new Set(tokens.flat().map((token) => token.color?.toLowerCase()));
    // Keywords, comments and strings each get their own color.
    expect(colors.size).toBeGreaterThan(3);
    expect(colors).toContain('#6a737d');
    expect(colors).toContain('#032f62');
  } finally {
    await switchCodeViewHighlighter('highlights');
  }
  expect(getActiveCodeViewHighlighter()).toBe('highlights');
});
