import type { AssistedReviewStatus } from '../../types.ts';

/**
 * Commit-by-commit assisted review: which commit is shown, oldest first, and controls to move.
 * The bridge owns the current commit, so Neovim and other windows follow the same choice.
 */
export function AssistedReviewCommitBar({
  onSelect,
  status,
}: {
  onSelect: (index: number) => void;
  status: AssistedReviewStatus;
}) {
  const commits = status.commits ?? [];
  const index = commits.findIndex((commit) => commit.sha === status.current_commit);
  if (status.mode !== 'commits' || index < 0) {
    return null;
  }
  return (
    <span className="review-top-bar-branch assisted-review-commit-bar">
      <button
        aria-label="Previous commit"
        disabled={index === 0}
        onClick={() => onSelect(index - 1)}
        type="button"
      >
        ‹
      </button>
      <select
        aria-label="Commit to review"
        onChange={(event) => onSelect(Number(event.target.value))}
        value={index}
      >
        {commits.map((commit, position) => (
          <option key={commit.sha} value={position}>
            {`${position + 1}/${commits.length} ${commit.subject}${
              commit.prepared ? '' : ' (agent preparing)'
            }`}
          </option>
        ))}
      </select>
      <button
        aria-label="Next commit"
        disabled={index === commits.length - 1}
        onClick={() => onSelect(index + 1)}
        type="button"
      >
        ›
      </button>
    </span>
  );
}
