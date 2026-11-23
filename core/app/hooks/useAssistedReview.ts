import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { ReviewComment } from '../../lib/app-types.ts';
import {
  assistedReviewNotice,
  assistedReviewViewKey,
  endReviewLabel,
  commentsFromBridge,
  commentsToBridge,
  findingsFromAnnotations,
  questionProgress,
  reviewedFromViewed,
  sameComments,
  viewedFromReviewed,
} from '../../lib/assisted-review.ts';
import type {
  AssistedReviewComment,
  AssistedReviewStatus,
  PullRequestCodeQualityFinding,
  RepositoryState,
} from '../../types.ts';

type Viewed = Record<string, string>;

type UseAssistedReviewOptions = {
  bumpItemVersion: (key: string) => void;
  reviewComments: ReadonlyArray<ReviewComment>;
  reviewCommentsRef: RefObject<ReadonlyArray<ReviewComment>>;
  setReviewComments: Dispatch<SetStateAction<ReadonlyArray<ReviewComment>>>;
  setViewed: Dispatch<SetStateAction<Viewed>>;
  state: RepositoryState | null;
  stateRef: RefObject<RepositoryState | null>;
  statusRef: RefObject<AssistedReviewStatus | null>;
  viewedRef: RefObject<Viewed>;
};

const SAVE_DELAY_MS = 300;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Connects a Codiff window to the review bridge when it shows an assisted review. The bridge owns
 * every durable thing, so this only mirrors it: comments and viewed marks are hydrated from the
 * bridge's status and written back whole, and agent annotations are shown read-only.
 */
export function useAssistedReview({
  bumpItemVersion,
  reviewComments,
  reviewCommentsRef,
  setReviewComments,
  setViewed,
  state,
  stateRef,
  statusRef,
  viewedRef,
}: UseAssistedReviewOptions) {
  const active = state?.assistedReview != null;
  // A state read carries the bridge status it was made with; pushed updates supersede it.
  const attached = state?.assistedReview?.status;
  const [liveStatus, setLiveStatus] = useState<AssistedReviewStatus | null>(null);
  const status = liveStatus ?? attached ?? null;
  const [error, setError] = useState<string | null>(null);
  // Comments the bridge holds that this diff cannot show; every save must carry them along.
  const retainedRef = useRef<ReadonlyArray<AssistedReviewComment>>([]);
  // The comment set last known to be the bridge's, so echoes of our own saves are not changes.
  const syncedRef = useRef<ReturnType<typeof commentsToBridge> | null>(null);
  const savePendingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const questionsRef = useRef(new Map<string, { commentId: string; file: string }>());
  const askCountRef = useRef(0);
  const blocked = error != null || status?.stale === true;
  // The commit (commits mode) and the round and commit whose diff the shown comments belong to.
  const hydratedCommitRef = useRef<string | null>(null);
  const hydratedViewRef = useRef<string | null>(null);

  const hydrateComments = useCallback(
    (current: RepositoryState, next: AssistedReviewStatus) => {
      // The commit this state's diff shows, which may lag a newer status while it is re-read.
      const commit = current.assistedReview?.status.current_commit ?? null;
      const { retained, shown } = commentsFromBridge(current, next.comments, commit);
      hydratedCommitRef.current = commit;
      hydratedViewRef.current = assistedReviewViewKey(current.assistedReview?.status);
      retainedRef.current = retained;
      syncedRef.current = next.comments as ReturnType<typeof commentsToBridge>;
      setReviewComments(shown);
    },
    [setReviewComments],
  );

  const applyStatus = useCallback(
    (next: AssistedReviewStatus) => {
      statusRef.current = next;
      setLiveStatus(next);
      const current = stateRef.current;
      if (!current?.assistedReview) {
        return;
      }
      const viewed = viewedFromReviewed(current, next.reviewed);
      if (JSON.stringify(viewed) !== JSON.stringify(viewedRef.current)) {
        setViewed(viewed);
      }
      if (
        !savePendingRef.current &&
        !sameComments(next.comments, syncedRef.current ?? ({} as typeof next.comments))
      ) {
        hydrateComments(current, next);
      }
      for (const [questionId, { commentId, file }] of questionsRef.current) {
        const delivery = next.questions[questionId];
        if (delivery) {
          setReviewComments((comments) =>
            comments.map((comment) =>
              comment.id === commentId
                ? { ...comment, codexReply: { body: questionProgress(delivery), status: 'ready' } }
                : comment,
            ),
          );
          bumpItemVersion(file);
        }
      }
    },
    [
      bumpItemVersion,
      hydrateComments,
      setReviewComments,
      setViewed,
      stateRef,
      statusRef,
      viewedRef,
    ],
  );

  // The first state read hydrates the window's comments.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!state || !attached) {
      return;
    }
    statusRef.current ??= attached;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      hydrateComments(state, attached);
    } else if (assistedReviewViewKey(attached) !== hydratedViewRef.current) {
      // A state read for another commit or round: show its comments and viewed marks.
      const latest = statusRef.current ?? attached;
      hydrateComments(state, latest);
      setViewed(viewedFromReviewed(state, latest.reviewed));
    }
  }, [attached, hydrateComments, setViewed, state, statusRef]);

  useEffect(() => {
    if (!active) {
      return;
    }
    return window.codiff.assistedReview.onUpdate((update) => {
      if ('error' in update) {
        setError(update.error);
      } else {
        applyStatus(update.status);
      }
    });
  }, [active, applyStatus]);

  // Write human comments back whole, shortly after the last edit.
  useEffect(() => {
    if (!active || blocked || syncedRef.current == null) {
      return;
    }
    const comments = commentsToBridge(
      reviewComments,
      retainedRef.current,
      hydratedCommitRef.current,
    );
    if (sameComments(comments, syncedRef.current)) {
      return;
    }
    savePendingRef.current = true;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      window.codiff.assistedReview
        .saveComments(comments)
        .then(() => {
          syncedRef.current = comments;
        })
        .catch((saveError: unknown) => setError(messageOf(saveError)))
        .finally(() => {
          savePendingRef.current = false;
        });
    }, SAVE_DELAY_MS);
  }, [active, blocked, reviewComments]);

  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const ask = useCallback(
    (commentId: string) => {
      const current = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        !current ||
        current.source.type !== 'range' ||
        !comment ||
        blocked ||
        comment.body.trim() === '' ||
        comment.lineNumber == null ||
        comment.side == null
      ) {
        return;
      }
      const side = comment.side === 'deletions' ? 'old' : 'new';
      const start =
        comment.startLineNumber != null && (comment.startSide ?? comment.side) === comment.side
          ? comment.startLineNumber
          : comment.lineNumber;
      const line = Math.min(start, comment.lineNumber);
      const lineEnd = Math.max(start, comment.lineNumber);
      const annotation = statusRef.current?.annotations.find(
        (candidate) =>
          candidate.file === comment.filePath &&
          candidate.side === side &&
          candidate.line <= lineEnd &&
          candidate.line_end >= line,
      );
      askCountRef.current += 1;
      const questionId = `q_${comment.id}_${askCountRef.current}`;
      const setReply = (codexReply: NonNullable<ReviewComment['codexReply']>) => {
        setReviewComments((comments) =>
          comments.map((candidate) =>
            candidate.id === comment.id ? { ...candidate, codexReply } : candidate,
          ),
        );
        bumpItemVersion(comment.filePath);
      };
      setReply({ status: 'loading' });
      window.codiff.assistedReview
        .ask({
          ...(annotation ? { annotation_id: annotation.id } : {}),
          file: comment.filePath,
          head: current.source.head,
          line,
          line_end: lineEnd,
          question: comment.body,
          question_id: questionId,
          side,
        })
        .then(() => {
          questionsRef.current.set(questionId, { commentId: comment.id, file: comment.filePath });
          setReply({ body: questionProgress('queued'), status: 'ready' });
        })
        .catch((askError: unknown) => setReply({ error: messageOf(askError), status: 'error' }));
    },
    [blocked, bumpItemVersion, reviewCommentsRef, setReviewComments, stateRef, statusRef],
  );

  const saveViewed = useCallback(
    (viewed: Viewed) => {
      const current = stateRef.current;
      const previous = statusRef.current;
      if (!current?.assistedReview || !previous || blocked) {
        return;
      }
      const reviewed = reviewedFromViewed(current, viewed, previous.reviewed);
      // Later toggles build on this one before the bridge's next status arrives.
      statusRef.current = { ...previous, reviewed };
      window.codiff.assistedReview
        .saveReviewed(reviewed)
        .catch((saveError: unknown) => setError(messageOf(saveError)));
    },
    [blocked, stateRef, statusRef],
  );

  // A stale review no longer matches the files; the agent's notes would point at the wrong lines.
  const findings = useMemo<Array<PullRequestCodeQualityFinding> | null>(
    () =>
      active ? (status && !status.stale ? findingsFromAnnotations(status.annotations) : []) : null,
    [active, status],
  );

  // Ends the round; a failure (agent unreachable) leaves it open so the user can retry.
  const [endError, setEndError] = useState<string | null>(null);
  const endReview = useMemo(
    () =>
      status
        ? {
            ...endReviewLabel(status),
            ended: status.ended === true,
            onEnd: () => {
              setEndError(null);
              window.codiff.assistedReview
                .endReview()
                .catch((error_: unknown) => setEndError(messageOf(error_)));
            },
          }
        : undefined,
    [status],
  );

  const notice = error
    ? `Lost the review bridge: ${error}. Nothing more is saved; ask the agent to begin a new review.`
    : endError
      ? `Could not end the review round: ${endError}`
      : status
        ? assistedReviewNotice(status)
        : null;

  return { active, ask, endReview, findings, notice, saveViewed, status };
}
