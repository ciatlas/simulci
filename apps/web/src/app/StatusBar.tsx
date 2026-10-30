import type { RunPlan } from '@simulci/engine';
import { lazy, Suspense, useEffect, useState } from 'react';
import { heldSentence } from '../engine/hold';
import type { ChangeRow } from '../plan/change-rows';
import { summarize } from '../plan/summary';
import type { Change } from '../state/store';
import { ChangeDetails } from './ChangeDetails';
import { useSession } from './providers';
import { RemotesChip } from './RemotesChip';
import { SaveLine } from './SaveButton';

/**
 * The sentence the line says, the key of the element that says it, and the rows Details lists with it. A polite live
 * region reads a node that comes, or a text that changes: two changes in a row whose sentence is the same change no
 * text, so each change's sentence comes in an element of its own (`change-<seq>`). A summary keeps one element, and
 * says only what changed.
 */
interface Line {
  text: string;
  key: string;
  rows?: readonly ChangeRow[];
}

/** The key of every sentence but a change's and the hold's. */
const SUMMARY = 'summary';

/** A refused edit's sentence and fixes: the edit runtime refused it, so its chunk is in by then. */
const RefusalLine = lazy(() => import('../edit/edit').then((m) => ({ default: m.RefusalLine })));

/**
 * One sentence per plan, for the eye and the screen reader, half a second behind so bursts read once. The plan that
 * answers a pin or an edit says what it changed ("pinned; deploy now runs", "Edited ci.yml: CI is no longer
 * triggered"), with Details beside it; every other plan says its summary, and so does the plan of keys typed in the
 * pane that changed nothing. While an edit broke the YAML, the line says what the plan waits for instead (synthesis
 * § 7.2). While the inputs or the texts have changed since the plan, the sentence is set in italics: the top bar says
 * "· stale" in words, and the sentence keeps the contrast of the rest of the line. Details is outside the live region,
 * so the region reads the sentence alone. A refused edit adds its sentence and its fixes (edit/Refusal.tsx) in a
 * status region of its own, read when the refusal comes.
 */
export function StatusBar() {
  const plan = useSession((s) => s.plan?.plan);
  const change = useSession((s) => s.change);
  const project = useSession((s) => s.project.status);
  const waits = useSession((s) => (s.project.held ? heldSentence(s.project.held) : undefined));
  const stale = useSession((s) => s.staleShown);
  const refused = useSession((s) => s.edit.refused !== undefined);
  const [line, setLine] = useState<Line>({ text: '', key: SUMMARY });

  // Keyed on the plan, not the change: a change is answered together with its plan, and one made since says nothing
  // until its own plan comes, so each plan reads one sentence.
  useEffect(() => {
    const next = waits
      ? { text: waits, key: 'held' }
      : plan
        ? planLine(plan, change)
        : { text: project === 'loading' ? 'loading the files…' : '', key: SUMMARY };
    const t = setTimeout(() => setLine(next), 500);
    return () => clearTimeout(t);
  }, [plan, project, waits]);

  return (
    <footer className="flex items-center gap-3 border-border border-t bg-chrome px-4 py-1 text-muted text-xs">
      {/* One line tall even before the first sentence comes, so the canvas does not shrink under a fit already made. */}
      <span aria-live="polite" className="min-h-4 min-w-0">
        <span key={line.key} className={stale && line.key !== 'held' ? 'italic' : undefined}>
          {line.text}
        </span>
      </span>
      {line.rows && <ChangeDetails rows={line.rows} />}
      <div role="status" className="min-w-0">
        {refused && (
          <Suspense fallback={null}>
            <RefusalLine />
          </Suspense>
        )}
      </div>
      <RemotesChip />
      <SaveLine />
    </footer>
  );
}

/** The change's sentence for the plan that answered it, in the change's own element; the summary for any other. */
function planLine(plan: RunPlan, change: Change | undefined): Line {
  const after = change?.after;
  if (!change || after?.plan !== plan || after.sentence === undefined)
    return { text: summarize(plan).sentence, key: SUMMARY };
  return {
    text: after.sentence,
    key: `change-${change.seq}`,
    ...(after.rows.length ? { rows: after.rows } : {}),
  };
}
