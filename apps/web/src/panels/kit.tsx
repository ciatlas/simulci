import type { Loc, NodeId, Value } from '@simulci/engine';
import type { ReactNode } from 'react';
import { useApp, useSession } from '../app/providers';
import { remoteHref, remoteName, remoteScopes } from '../graph/remote';
import { type PlanIndex, planIndex, resolveSelection } from '../plan/index';
import type { PlanState } from '../state/store';

/**
 * What the right panel's tabs share: the selected node over the plan, a `file:line` link into the YAML pane, a
 * gate's glyph, a section heading, and the sentence a tab shows when it has nothing to say.
 */

export interface Selected {
  plan: PlanState;
  index: PlanIndex;
  /** The selected node; the focused workflow when nothing inside it is selected. */
  node: NodeId | undefined;
}

/** The plan and the node the panels are about; undefined before the first plan. */
export function useSelected(): Selected | undefined {
  const plan = useSession((s) => s.plan);
  const focus = useSession((s) => s.focus);
  const sel = useSession((s) => s.sel);
  if (!plan) return undefined;
  const index = planIndex(plan);
  return { plan, index, node: resolveSelection(index, focus, sel) };
}

/**
 * `file:line`, a button that opens the YAML pane on the line. Its name starts with what it shows (WCAG 2.5.3), the
 * full path after it for a screen reader. A line of a remote's file is not in the pane: it is a link to the file on
 * GitHub at the commit the plan read, in a new tab (M4 synthesis § 5.4).
 */
export function LocLink({ loc, children }: { loc: Pick<Loc, 'file' | 'line'>; children?: ReactNode }) {
  const { store } = useApp();
  const href = useRemoteHref(loc);
  if (href !== undefined)
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded px-1 font-mono text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-text"
        title={`Open ${loc.file} line ${loc.line} on GitHub`}
      >
        {children ?? `${basename(remoteName(loc.file)?.path ?? loc.file)}:${loc.line}`}
        <span className="sr-only">
          {' '}
          on GitHub ({loc.file} line {loc.line}, opens in a new tab)
        </span>
      </a>
    );
  return (
    <button
      type="button"
      className="rounded px-1 font-mono text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-text"
      onClick={() => store.getState().revealLine({ file: loc.file, line: loc.line })}
      title={`Show ${loc.file} line ${loc.line}`}
    >
      {children ?? `${basename(loc.file)}:${loc.line}`}
      <span className="sr-only">
        {' '}
        in the YAML pane ({loc.file} line {loc.line})
      </span>
    </button>
  );
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The GitHub link of a place in a remote's file, read at the commit of the remote around the selected node. */
function useRemoteHref(loc: Pick<Loc, 'file' | 'line'>): string | undefined {
  const selected = useSelected();
  if (!selected || !remoteName(loc.file)) return undefined;
  const plan = selected.plan.plan;
  return remoteHref(plan, loc, selected.node === undefined ? [] : remoteScopes(plan, selected.node));
}

const GATE: Record<'pass' | 'fail' | 'open', { glyph: string; label: string; className: string }> = {
  pass: { glyph: '✓', label: 'passes', className: 'text-run' },
  fail: { glyph: '✗', label: 'fails', className: 'text-danger' },
  open: { glyph: '?', label: 'undecided', className: 'text-might-text' },
};

/** A gate's answer (`reasonGate`): ✓ passes, ✗ fails, ? undecided; the glyph is named for a screen reader. */
export function Gate({ gate }: { gate: Value<boolean> }) {
  const g = GATE[gate.known ? (gate.value ? 'pass' : 'fail') : 'open'];
  return (
    <span role="img" aria-label={g.label} className={`w-3 shrink-0 text-center font-mono ${g.className}`}>
      {g.glyph}
    </span>
  );
}

/** A heading inside a tab. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-medium text-muted text-xs uppercase tracking-wide">{children}</h3>;
}

/** What a tab says when it has nothing to show. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-muted text-sm">{children}</p>;
}
