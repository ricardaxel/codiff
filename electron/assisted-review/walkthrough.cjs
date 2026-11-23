// @ts-check

const { getSectionWalkthroughHunks } = require('../../core/lib/narrative-walkthrough-diff.cjs');
const { normalizeNarrativeWalkthrough } = require('../narrative-walkthrough.cjs');

const CATEGORY_LABELS = {
  decision: 'Decision',
  known_gap: 'Known gap',
  needs_verification: 'Needs verification',
  your_judgment: 'Your judgment',
};

/**
 * Distance from a stop's line range to a hunk's range on the stop's side; 0 when they overlap or
 * the hunk has no line range (a synthetic, file-level hunk).
 *
 * @param {any} hunk @param {{line: number; line_end: number; side: string}} stop
 */
const distance = (hunk, stop) => {
  const start = stop.side === 'old' ? hunk.deletionStart : hunk.additionStart;
  const end = stop.side === 'old' ? hunk.deletionEnd : hunk.additionEnd;
  if (start == null || end == null) {
    return 0;
  }
  return Math.max(0, start - stop.line_end, stop.line - end);
};

/**
 * Turns the bridge's reading-order stops into a walkthrough over the live diff. Each anchor (a
 * stop's own lines and its `also` anchors, or a support group's anchors) points at the hunks of
 * its file overlapping its lines, else the nearest one. Stops are grouped by their chapter in
 * order of first appearance; a stop's narration is its prose followed by the agent annotations in
 * its range, as a list. Returns null when there is nothing to show.
 *
 * @param {import('../../core/types.ts').AssistedReviewStatus} status
 * @param {import('../../core/types.ts').RepositoryState} state
 */
const buildAssistedWalkthrough = (status, state) => {
  /** @type {Map<string, any[]>} */
  const hunksByPath = new Map();
  for (const file of state.files) {
    for (const section of file.sections ?? []) {
      const list = hunksByPath.get(file.path) ?? [];
      list.push(...getSectionWalkthroughHunks(file, section));
      hunksByPath.set(file.path, list);
    }
  }

  /** @param {{file: string; line: number; line_end: number; side: string}} anchor */
  const hunkIdsFor = (anchor) => {
    const candidates = (hunksByPath.get(anchor.file) ?? []).map((hunk) => ({
      distance: distance(hunk, anchor),
      hunk,
    }));
    const nearest = Math.min(...candidates.map((candidate) => candidate.distance));
    return candidates
      .filter((candidate) => candidate.distance === nearest)
      .map((candidate) => candidate.hunk.id);
  };
  /** @param {ReadonlyArray<any>} anchors */
  const unionHunkIds = (anchors) => [...new Set(anchors.flatMap(hunkIdsFor))];

  const chapterInfo = new Map((status.chapters ?? []).map((chapter) => [chapter.id, chapter]));
  /** @type {Map<string, any>} */
  const chapters = new Map();
  for (const stop of status.stops) {
    const hunkIds = unionHunkIds([stop, ...(stop.also ?? [])]);
    if (!hunkIds.length) {
      continue;
    }
    const notes = status.annotations
      .filter(
        (annotation) =>
          annotation.file === stop.file &&
          annotation.side === stop.side &&
          annotation.line <= stop.line_end &&
          annotation.line_end >= stop.line,
      )
      .map((annotation) => `- **${CATEGORY_LABELS[annotation.category]}:** ${annotation.text}`);
    // The stop's own prose, then its annotations as a list, each labelled with its category.
    const prose = [stop.prose, notes.join('\n')].filter(Boolean).join('\n\n');
    const info = (stop.chapter && chapterInfo.get(stop.chapter)) || {
      icon: 'path',
      id: 'reading-order',
      title: 'Reading order',
    };
    if (!chapters.has(info.id)) {
      chapters.set(info.id, {
        blurb: info.blurb ?? '',
        icon: info.icon ?? 'path',
        id: info.id,
        stops: [],
        title: info.title,
      });
    }
    chapters.get(info.id).stops.push({
      hunkIds,
      id: stop.id,
      importance: stop.importance,
      prose: prose || stop.title,
      summary: stop.summary,
      title: stop.title,
    });
  }
  if (!chapters.size) {
    return null;
  }

  const support = (status.support ?? [])
    .map((group, index) => ({
      hunkIds: unionHunkIds(group.anchors),
      id: `bridge-support-${index + 1}`,
      note: group.note,
      reason: group.reason,
    }))
    .filter((group) => group.hunkIds.length);
  const walkthrough = normalizeNarrativeWalkthrough(
    {
      chapters: [...chapters.values()],
      focus: 'Review in the agent’s recommended order.',
      support,
      title: 'Assisted review',
    },
    state.files,
    { agent: 'assisted-review', branch: status.branch, root: state.root, source: state.source },
  );
  // normalize collapses whitespace; the briefing is markdown.
  return { ...walkthrough, focus: status.briefing || walkthrough.focus };
};

module.exports = { buildAssistedWalkthrough };
