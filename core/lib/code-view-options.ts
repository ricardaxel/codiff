import {
  disposeHighlighter,
  getFiletypeFromFileName,
  preloadHighlighter,
  registerCustomTheme,
  setCustomExtension,
} from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from '@pierre/diffs/worker';
import type { CodiffSyntaxHighlighter } from '../config/types.ts';
import dunkelTheme from '../themes/dunkel.json' with { type: 'json' };
import lichtTheme from '../themes/licht.json' with { type: 'json' };
import type { DiffSection } from '../types.ts';

registerCustomTheme('Licht', async () => lichtTheme as never, 'zed');
registerCustomTheme('Dunkel', async () => dunkelTheme as never, 'zed');
setCustomExtension('cts', 'typescript');
setCustomExtension('mts', 'typescript');

export const sectionLabel: Record<DiffSection['kind'], string> = {
  commit: 'Commit',
  'pull-request': 'PR',
  staged: 'Staged',
  unstaged: 'Unstaged',
};

// 11px needed to account for the box shadow around individual diffs
export const DEFAULT_PADDING = 11;

export const codeViewLayout = {
  // 2px is used to account for a 10px gap with the 1px box shadows
  gap: 12,
  paddingBottom: DEFAULT_PADDING,
  paddingTop: DEFAULT_PADDING,
};

export const codeViewItemMetrics = {
  diffHeaderHeight: 54,
};

// Default-path line height for diff layout estimates. Runtime diff rendering
// may override --diffs-line-height through code font preferences.
export const DIFF_LINE_HEIGHT = 20;

export const diffContextExpansionLineCount = 100;
export const diffCollapsedContextThreshold = 12;

/**
 * `highlights` is the fast default; Shiki colors many more languages (D, for
 * example) but is much slower. Only one engine can be active per JavaScript
 * context, so a window uses one engine for all of its code views.
 */
export type CodeViewHighlighter = 'highlights' | 'shiki-js';

// Licht and Dunkel are Zed themes, which Shiki cannot load, so Shiki uses GitHub's.
const codeViewThemes = {
  highlights: { dark: 'Dunkel', light: 'Licht' },
  'shiki-js': { dark: 'github-dark', light: 'github-light' },
} as const satisfies Record<CodeViewHighlighter, { dark: string; light: string }>;

export const getCodeViewThemes = (highlighter: CodeViewHighlighter) => codeViewThemes[highlighter];

export const getWorkerHighlighterOptions = (highlighter: CodeViewHighlighter) => ({
  maxLineDiffLength: 2000,
  preferredHighlighter: highlighter,
  theme: codeViewThemes[highlighter],
  tokenizeMaxLineLength: 20_000,
  // Pierre's editor requires token metadata. Generate it in the workers so
  // entering edit mode can reuse the highlighted result without a local pass.
  useTokenTransformer: true,
});

// The engine preloaded at startup, before the review's files are known.
let activeHighlighter: CodeViewHighlighter = 'highlights';

export const getActiveCodeViewHighlighter = () => activeHighlighter;

let pendingSwitch: Promise<void> = Promise.resolve();

/**
 * Release the active engine's shared highlighter and worker pool, then make
 * `highlighter` the active one. Code views must be unmounted while this runs.
 * Switches run one at a time.
 */
export const switchCodeViewHighlighter = (highlighter: CodeViewHighlighter) =>
  (pendingSwitch = pendingSwitch.then(async () => {
    if (highlighter === activeHighlighter) {
      return;
    }
    terminateWorkerPoolSingleton();
    await disposeHighlighter().catch(() => {});
    activeHighlighter = highlighter;
  }));

/** Languages of the given paths, as the highlighters name them. */
export const getReviewLanguages = (paths: Iterable<string>) =>
  [...new Set(Array.from(paths, (path) => getFiletypeFromFileName(path)))]
    .filter((language) => language !== 'text')
    .sort();

/**
 * Pick the engine for a review. `auto` keeps the fast engine unless a file is
 * in a language it cannot color; every language a file name maps to has a
 * Shiki grammar, so Shiki then colors the whole review.
 */
export const resolveCodeViewHighlighter = async (
  setting: CodiffSyntaxHighlighter,
  languages: ReadonlyArray<string>,
): Promise<CodeViewHighlighter> => {
  if (setting !== 'auto') {
    return setting === 'shiki' ? 'shiki-js' : 'highlights';
  }
  if (languages.length === 0) {
    return 'highlights';
  }
  // The fast engine loads this module anyway, so checking costs no extra download.
  const { isSupportedLanguage } = await import('@pierre/highlights');
  return languages.every((language) => isSupportedLanguage(language)) ? 'highlights' : 'shiki-js';
};

export const maxWorkerThreads = 3;

export const getCodeViewWorkerPoolOptions = () => ({
  mainThreadMaxCharacters: 100_000,
  poolSize: Math.min(
    maxWorkerThreads,
    Math.max(1, navigator.hardwareConcurrency || maxWorkerThreads),
  ),
  workerFactory: () =>
    new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), {
      type: 'module',
    }),
});

export const preloadCodeView = () => {
  void document.fonts.load('13px "Fira Code"').catch(() => {});
  void getOrCreateWorkerPoolSingleton({
    highlighterOptions: getWorkerHighlighterOptions(activeHighlighter),
    poolOptions: getCodeViewWorkerPoolOptions(),
  })
    .initialize()
    .catch(() => {});
  void preloadCodeViewHighlighter().catch(() => {});
};

// File metadata is fetched over IPC before CodeView mounts. Use that time to
// load the shared highlighter that small diffs will need on the main thread.
export const preloadCodeViewHighlighter = () => {
  const themes = getCodeViewThemes(activeHighlighter);
  return preloadHighlighter({
    langs: ['text'],
    preferredHighlighter: activeHighlighter,
    themes: [themes.light, themes.dark],
  });
};

export const codeViewUnsafeCSS = `
  :host {
    border-radius: var(--codiff-diff-radius, 28px);
    corner-shape: squircle;
    --diffs-font-family: var(--font-diff-mono, var(--font-mono));
    --diffs-header-font-family: var(--font-sans);
    --diffs-font-size: var(--font-diff-size, 13px);
    --diffs-line-height: var(--font-diff-line-height, 20px);
    --diffs-light-bg: var(--code-bg);
    --diffs-dark-bg: var(--code-bg);
    --diffs-bg-selection-override: rgb(61 135 245 / 0.34);
    --diffs-bg-selection-number-override: rgb(61 135 245 / 0.46);
  }

  [data-diff-type="split"][data-overflow="scroll"] {
    grid-template-columns: minmax(0, 42fr) minmax(0, 58fr);
  }

  [data-diffs-header="custom"][data-sticky] {
    background-color: transparent;
    border-radius: 0;
  }

  :host(.codiff-walkthrough-header-item) {
    background: var(--app-bg);
    border-radius: 0;
    box-shadow: none;
    corner-shape: initial;
    overflow: visible;
  }

  :host(.codiff-walkthrough-header-item) [data-file],
  :host(.codiff-walkthrough-header-item) pre,
  :host(.codiff-walkthrough-header-item) code,
  :host(.codiff-walkthrough-header-item) [data-code],
  :host(.codiff-walkthrough-header-item) [data-line-annotation] {
    background: var(--app-bg);
    border-radius: 0;
    box-shadow: none;
    overflow: visible;
  }

  :host(.codiff-walkthrough-header-item) [data-column-number],
  :host(.codiff-walkthrough-header-item) [data-line-number],
  :host(.codiff-walkthrough-header-item) [data-gutter],
  :host(.codiff-walkthrough-header-item) [data-gutter-buffer],
  :host(.codiff-walkthrough-header-item) [data-content] > [data-line] {
    display: none;
  }

  .review-comment-thread {
    padding: 8px 0 8px 16px;
  }

  /* Align scrollbar with number column */
  [data-code]::-webkit-scrollbar-track {
    margin-left: var(--diffs-column-number-width);
  }

  /* Ensure right edge of scrollbar never gets cropped by rounded corners */
  [data-file] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="single"] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="split"] [data-code][data-additions]::-webkit-scrollbar-track {
    margin-right: 14px;
  }

  :host(.codiff-markdown-preview-item) [data-file] [data-code] {
    grid-column: 1 / -1;
  }

  :host(.codiff-markdown-preview-item) [data-file] [data-line="1"][data-line-index="0"][data-line-type="context"],
  :host(.codiff-markdown-preview-item) [data-file] [data-column-number="1"][data-line-index="0"][data-line-type="context"],
  :host(.codiff-markdown-preview-item) [data-gutter] > [data-gutter-utility-slot] {
    display: none;
    pointer-events: none;
  }

  :host(.codiff-image-preview-item) [data-file] {
    --diffs-code-grid: 1fr;
  }

  :host(.codiff-image-preview-item) [data-file] [data-code] {
    grid-column: 1 / -1;
    padding-block: 0;
  }

  :host(.codiff-image-preview-item) [data-file] [data-content] {
    grid-column: 1;
  }

  :host(.codiff-image-preview-item) [data-file] [data-gutter],
  :host(.codiff-image-preview-item) [data-file] [data-line="1"][data-line-index="0"][data-line-type="context"] {
    display: none;
    pointer-events: none;
  }

  :host(.codiff-loadable-summary-item) [data-file] [data-line],
  :host(.codiff-loadable-summary-item) [data-file] [data-column-number] {
    cursor: pointer;
  }

  :host(.codiff-loading-summary-item) [data-file] [data-line],
  :host(.codiff-loading-summary-item) [data-file] [data-column-number] {
    cursor: progress;
  }

  :host([data-codiff-definition-mode]) [data-codiff-identifier] {
    cursor: pointer;
    text-decoration-color: color-mix(in srgb, currentColor 38%, transparent);
    text-decoration-line: underline;
    text-decoration-style: dotted;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }

  :host([data-codiff-definition-mode]) [data-codiff-identifier]:hover {
    text-decoration-color: currentColor;
    text-decoration-style: solid;
  }

  .codiff-search-mark {
    background: var(--diffs-find-highlight-bg, rgb(255 216 92 / 0.65));
    border-radius: 3px;
    color: inherit;
    padding: 0 1px;
  }

  .codiff-search-mark.active {
    background: var(--diffs-find-active-bg, rgb(255 176 46 / 0.96));
    box-shadow: 0 0 0 1px rgb(255 142 36 / 0.4);
  }

  [data-utility-button] {
    background: color-mix(in srgb, var(--diffs-bg) 88%, var(--diffs-modified-base));
    border: 1px solid color-mix(in srgb, var(--diffs-modified-base) 34%, transparent);
    border-radius: 3px;
    box-shadow: 0 7px 18px -14px rgb(0 0 0 / 0.72);
    color: var(--diffs-modified-base);
    height: calc(1lh - 4px);
    transform: translate(-4px, 2px);
    width: calc(1lh - 4px);
  }

  [data-selected-line] [data-gutter-utility-slot] {
    display: none;
  }

  /* The imperative API wraps annotations in a node that resets white-space, but
     the React API slots them in bare, so they inherit "pre" from the shadow
     <pre> and prose never wraps. */
  [data-annotation-content] slot::slotted(*) {
    white-space: normal;
  }
`;
