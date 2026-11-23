/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vite-plus/test';

const desktopCss = readFileSync(resolve('core/Desktop.css'), 'utf8').replaceAll(
  /\/\*[\s\S]*?\*\//g,
  '',
);
// jsdom does not implement Electron's app regions or pseudo-element layout.
// Match the actual desktop rules against the DOM used by each startup screen.
const dragRules = Array.from(desktopCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)).filter(
  ([, selector, declarations]) =>
    selector.includes('::before') && /-webkit-app-region:\s*drag\s*;/.test(declarations),
);

test.each([
  ['before the renderer mounts', ''],
  ['while loading repository state', '<main class="loading pulse">Thinking…</main>'],
  ['while building a walkthrough', '<main class="loading codex">Building walkthrough… 9s</main>'],
  ['while loading a plan', '<main class="loading">Loading…</main>'],
  ['after a startup error', '<main class="empty-state"><button>Retry</button></main>'],
])('provides a title-bar drag region %s', (_label, html) => {
  const root = document.createElement('div');
  root.id = 'root';
  root.innerHTML = html;

  const declarations = dragRules.find(([, selector]) =>
    root.matches(selector.replaceAll('::before', '')),
  )?.[2];

  expect(declarations).toBeDefined();
  expect(declarations).toMatch(/content:\s*['"]{2}\s*;/);
  expect(declarations).toMatch(/position:\s*fixed\s*;/);
  expect(declarations).toMatch(/height:\s*40px\s*;/);
  for (const edge of ['top', 'left', 'right']) {
    expect(declarations).toMatch(new RegExp(`${edge}:\\s*0\\s*;`));
  }
});

test('does not cover the loaded toolbar or in-app empty states with a startup drag region', () => {
  const root = document.createElement('div');
  root.id = 'root';
  root.innerHTML =
    '<main class="app-shell"><header class="workspace-top-bar"><button>Open</button></header><main class="review"><div class="empty-state">No changes</div></main></main>';

  expect(dragRules.some(([, selector]) => root.matches(selector.replaceAll('::before', '')))).toBe(
    false,
  );
});
