import { BugIcon as Bug } from '@phosphor-icons/react/Bug';
import { FlagCheckeredIcon as FlagCheckered } from '@phosphor-icons/react/FlagCheckered';
import { FlaskIcon as Flask } from '@phosphor-icons/react/Flask';
import { GearIcon as Gear } from '@phosphor-icons/react/Gear';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { ReadCvLogoIcon as Doc } from '@phosphor-icons/react/ReadCvLogo';
import { ShareNetworkIcon as ShareNetwork } from '@phosphor-icons/react/ShareNetwork';
import { WrenchIcon as Wrench } from '@phosphor-icons/react/Wrench';
import type { ComponentType } from 'react';
import { renderBlockMarkdown } from '../../../lib/markdown.tsx';
import { importanceLabel } from '../../../lib/narrative-walkthrough.ts';
import type { WalkthroughIcon, WalkthroughStop } from '../../../types.ts';

type IconProps = {
  size?: number;
  weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
};

const chapterIcons: Record<WalkthroughIcon, ComponentType<IconProps>> = {
  beaker: Flask,
  bug: Bug,
  doc: Doc,
  flask: Flask,
  gear: Gear,
  path: Path,
  wrench: Wrench,
};

export function ChapterIcon({ icon, size = 13 }: { icon: WalkthroughIcon; size?: number }) {
  const Icon = chapterIcons[icon] ?? chapterIcons.path;
  return <Icon size={size} />;
}

export function ImportancePill({ importance }: { importance: WalkthroughStop['importance'] }) {
  return <span className={`wt-importance ${importance}`}>{importanceLabel[importance]}</span>;
}

export function WalkthroughLineCount({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="codiff-line-count">
      <span className="codiff-line-count-added">+{added}</span>
      {deleted > 0 ? <span className="codiff-line-count-deleted">−{deleted}</span> : null}
    </span>
  );
}

export function Narration({ prose }: { prose: string }) {
  return (
    <div className="wt-narration">
      <div className="wt-narration-prose">{renderBlockMarkdown(prose)}</div>
    </div>
  );
}

/** An assisted review's end of round, offered where a walkthrough is otherwise shared. */
export type EndReviewAction = { ended: boolean; label: string; onEnd: () => void; title: string };

/** The walkthrough's closing action: end the assisted-review round, else share it, else none. */
export const walkthroughFinishAction = ({
  endReview,
  onShareWalkthrough,
  shareWalkthroughDisabled = false,
}: {
  endReview?: EndReviewAction;
  onShareWalkthrough?: () => void;
  shareWalkthroughDisabled?: boolean;
}) =>
  endReview
    ? {
        disabled: endReview.ended,
        heading: 'Finish',
        Icon: FlagCheckered,
        label: endReview.label,
        onClick: endReview.onEnd,
        title: endReview.title,
      }
    : onShareWalkthrough
      ? {
          disabled: shareWalkthroughDisabled,
          heading: 'Share',
          Icon: ShareNetwork,
          label: shareWalkthroughDisabled ? 'Sharing walkthrough' : 'Share walkthrough',
          onClick: onShareWalkthrough,
          title: shareWalkthroughDisabled ? 'Sharing walkthrough' : 'Share walkthrough',
        }
      : null;
