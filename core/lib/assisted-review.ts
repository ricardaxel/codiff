import type {
  AssistedReviewComment,
  AssistedReviewStatus,
  PullRequestCodeQualityFinding,
  RepositoryState,
} from '../types.ts';
import type { ReviewComment } from './app-types.ts';

// Pure translations between the review bridge's data and Codiff's own models. The bridge is the
// only durable store; none of this is persisted by Codiff.

type Marks = Readonly<Record<string, number>>;
type BridgeComments = Readonly<Record<string, ReadonlyArray<AssistedReviewComment>>>;

/**
 * Which diff a status shows: its round and, in commits mode, its commit. A state read for another
 * key is out of date, and its comments and marks belong to another view.
 */
export const assistedReviewViewKey = (status: AssistedReviewStatus | null | undefined) =>
  status ? `${status.round ?? 1}:${status.current_commit ?? ''}` : null;

/**
 * The round's closing action. Commit by commit, it finishes the shown commit and moves everyone
 * to the next one, until the last commit, which ends the review.
 */
export const endReviewLabel = (status: AssistedReviewStatus) => {
  if (status.ended) {
    return { label: 'Review ended', title: 'The agent is handling your comments' };
  }
  const commits = status.commits ?? [];
  const index = commits.findIndex((commit) => commit.sha === status.current_commit);
  if (status.mode === 'commits' && index >= 0 && index < commits.length - 1) {
    return {
      label: 'Finish commit',
      title: "Hand this commit's comments to the agent and go to the next commit",
    };
  }
  return {
    label: 'End review',
    title: 'End this review round and hand your comments to the agent',
  };
};

/** What the window tells the user about the review: the agent's call first, then the round. */
export const assistedReviewNotice = (status: AssistedReviewStatus) =>
  status.attention
    ? `Claude needs you in the conversation: ${status.attention.text}`
    : status.ended
      ? `Review round ${status.round ?? 1} ended: the agent is handling your comments.`
      : status.stale
        ? 'This review is stale: tracked files changed since the agent began it. Ask it to begin a new review.'
        : null;

/** The path inside a review.nvim mark key, `"<old blob> <new blob> <path>"`. */
const markPath = (key: string) => key.match(/^\S+ \S+ (.*)$/)?.[1];

/** Files the bridge has marked reviewed, as Codiff's viewed map (path → current fingerprint). */
export const viewedFromReviewed = (state: RepositoryState, reviewed: Marks) => {
  const keys = state.assistedReview?.markKeys ?? {};
  const viewed: Record<string, string> = {};
  for (const file of state.files) {
    const key = keys[file.path];
    if (key && reviewed[key] !== undefined) {
      viewed[file.path] = file.fingerprint;
    }
  }
  return viewed;
};

/**
 * The bridge's reviewed set after a viewed change. Whole-file marks of files in this review are
 * rebuilt from `viewed` (a changed file's old mark can never match again); marks of other files
 * are kept, as is the time of marks that stay.
 */
export const reviewedFromViewed = (
  state: RepositoryState,
  viewed: Readonly<Record<string, string>>,
  previous: Marks,
  now = Math.floor(Date.now() / 1000),
): Record<string, number> => {
  const keys = state.assistedReview?.markKeys ?? {};
  const paths = new Set(state.files.map((file) => file.path));
  const next: Record<string, number> = {};
  for (const [key, at] of Object.entries(previous)) {
    const path = markPath(key);
    if (path === undefined || !paths.has(path)) {
      next[key] = at;
    }
  }
  for (const file of state.files) {
    const key = keys[file.path];
    if (key && viewed[file.path] === file.fingerprint) {
      next[key] = previous[key] ?? now;
    }
  }
  return next;
};

const categoryLabel = {
  decision: 'Decision',
  known_gap: 'Known gap',
  needs_verification: 'Needs verification',
  your_judgment: 'Your judgment',
} as const;

/**
 * Agent annotations as Codiff's read-only inline findings. Findings only exist on the new side, so
 * old-side annotations are not shown here.
 */
export const findingsFromAnnotations = (
  annotations: AssistedReviewStatus['annotations'],
): Array<PullRequestCodeQualityFinding> =>
  annotations
    .filter((annotation) => annotation.side === 'new')
    .map((annotation) => ({
      description: annotation.text,
      filePath: annotation.file,
      fingerprint: annotation.id,
      lineNumber: annotation.line,
      severity: annotation.category === 'needs_verification' ? 'major' : 'info',
      status: 'new',
      title: `Agent · ${categoryLabel[annotation.category]}`,
    }));

const diffSide = (side: 'new' | 'old') => (side === 'old' ? 'deletions' : 'additions');

/**
 * Bridge comments as Codiff comments. Comments on files outside this diff, or made on another
 * commit of a commit-by-commit review, cannot be shown, so they are returned as `retained` and
 * must go back into every save: a save replaces the whole set.
 */
export const commentsFromBridge = (
  state: RepositoryState,
  comments: BridgeComments,
  commit?: string | null,
) => {
  const sectionByPath = new Map(state.files.map((file) => [file.path, file.sections[0]?.id]));
  const shown: Array<ReviewComment> = [];
  const retained: Array<AssistedReviewComment> = [];
  for (const entries of Object.values(comments)) {
    for (const comment of entries) {
      const sectionId = sectionByPath.get(comment.file);
      if (!sectionId || (comment.commit ?? null) !== (commit ?? null)) {
        retained.push(comment);
        continue;
      }
      const side = diffSide(comment.side);
      shown.push({
        anchor: 'line',
        body: comment.text,
        bridge: {
          ...(comment.branch === undefined ? {} : { branch: comment.branch }),
          ...(comment.created_at === undefined ? {} : { createdAt: comment.created_at }),
          type: comment.type,
        },
        filePath: comment.file,
        id: comment.id,
        lineNumber: comment.line_end ?? comment.line,
        sectionId,
        side,
        ...(comment.line_end === undefined || comment.line_end === comment.line
          ? {}
          : { startLineNumber: comment.line, startSide: side }),
      });
    }
  }
  return { retained, shown };
};

const bridgeIdentifier = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Codiff comments as the bridge's comment set, keyed by file. Drafts without text, file-level
 * comments (the bridge only anchors lines) and remote review comments are not sent.
 */
export const commentsToBridge = (
  comments: ReadonlyArray<ReviewComment>,
  retained: ReadonlyArray<AssistedReviewComment> = [],
  commit?: string | null,
): Record<string, Array<AssistedReviewComment>> => {
  const result: Record<string, Array<AssistedReviewComment>> = {};
  const add = (comment: AssistedReviewComment) => {
    (result[comment.file] ??= []).push(comment);
  };
  for (const comment of comments) {
    if (
      comment.isReadOnly ||
      comment.anchor === 'file' ||
      comment.lineNumber == null ||
      comment.side == null ||
      comment.body.trim() === '' ||
      !bridgeIdentifier.test(comment.id)
    ) {
      continue;
    }
    // A range that crosses diff sides has no single-side form; keep its last line.
    const start =
      comment.startLineNumber != null && (comment.startSide ?? comment.side) === comment.side
        ? comment.startLineNumber
        : comment.lineNumber;
    add({
      file: comment.filePath,
      id: comment.id,
      line: Math.min(start, comment.lineNumber),
      line_end: Math.max(start, comment.lineNumber),
      side: comment.side === 'deletions' ? 'old' : 'new',
      text: comment.body,
      type: comment.bridge?.type ?? 'note',
      ...(comment.bridge?.createdAt === undefined ? {} : { created_at: comment.bridge.createdAt }),
      ...(comment.bridge?.branch === undefined ? {} : { branch: comment.bridge.branch }),
      ...(commit ? { commit } : {}),
    });
  }
  for (const comment of retained) {
    add(comment);
  }
  return result;
};

// Key order is not stable across the formatter, the bridge's JSON and our own export.
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/** Whether two comment sets are the same, so an echo of our own save is not mistaken for a change. */
export const sameComments = (a: BridgeComments, b: BridgeComments) => canonical(a) === canonical(b);

export const questionProgress = (delivery: 'acknowledged' | 'answered' | 'queued') =>
  delivery === 'answered'
    ? 'Answered in the agent session.'
    : delivery === 'acknowledged'
      ? 'The agent is working on it.'
      : 'Sent to the agent.';
