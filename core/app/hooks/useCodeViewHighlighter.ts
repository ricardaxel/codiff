import { useEffect, useMemo, useState } from 'react';
import type { CodiffSyntaxHighlighter } from '../../config/types.ts';
import {
  type CodeViewHighlighter,
  getActiveCodeViewHighlighter,
  getReviewLanguages,
  resolveCodeViewHighlighter,
  switchCodeViewHighlighter,
} from '../../lib/code-view-options.ts';

/**
 * The syntax highlighting engine for every code view in this window, or `null`
 * while it is being chosen or switched. Code views must not render while this
 * is `null`: switching releases the previous engine's highlighter and worker
 * pool, which only works once no code view uses them.
 */
export function useCodeViewHighlighter(
  setting: CodiffSyntaxHighlighter,
  paths: ReadonlyArray<string>,
): CodeViewHighlighter | null {
  const languagesKey = useMemo(() => getReviewLanguages(paths).join('\n'), [paths]);
  const [wanted, setWanted] = useState<CodeViewHighlighter | null>(null);
  const [active, setActive] = useState(getActiveCodeViewHighlighter);

  useEffect(() => {
    let cancelled = false;
    void resolveCodeViewHighlighter(setting, languagesKey ? languagesKey.split('\n') : [])
      .catch((): CodeViewHighlighter => 'highlights')
      .then((highlighter) => {
        if (!cancelled) {
          setWanted(highlighter);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [languagesKey, setting]);

  const switching = wanted != null && wanted !== active;
  useEffect(() => {
    if (!switching || wanted == null) {
      return;
    }
    // Runs after the commit that unmounted the code views (this hook returned
    // null). Always report the engine that is actually active, even if `wanted`
    // changed meanwhile: the next render then switches again if needed.
    void switchCodeViewHighlighter(wanted)
      .catch(() => {})
      .then(() => setActive(getActiveCodeViewHighlighter()));
  }, [switching, wanted]);

  return wanted == null || switching ? null : active;
}
