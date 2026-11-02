import type { NodeId } from '@simulci/engine';
import { remoteName, remoteScopes } from '../graph/remote';
import { planIndex, resolveSelection } from '../plan/index';
import type { SessionState, SessionStore } from '../state/store';
import type { Refused } from './types';

/**
 * Edits inside a remote callee (M4 synthesis § 5.4): its file is another repository's, read at a commit, so every
 * gesture on its jobs and steps refuses, with where to make it. Its jobs stay selectable; only the edit is refused.
 */

/** "This workflow lives in octo/ship; edit it there." */
export const livesIn = (home: string): string => `This workflow lives in ${home}; edit it there.`;

/** Where a selection inside a remote callee is: the node, the callee's file as the plan shows it, its repository. */
interface RemoteSelection {
  node: NodeId;
  file: string;
  home: string;
}

/** The selected node, when it is inside a remote callee, and the repository that callee lives in. */
export function remoteSelection(
  s: Pick<SessionState, 'plan' | 'focus' | 'sel'>,
): RemoteSelection | undefined {
  if (!s.plan || s.sel === undefined) return undefined;
  const node = resolveSelection(planIndex(s.plan), s.focus, s.sel);
  const file = node === undefined ? undefined : remoteScopes(s.plan.plan, node)[0]?.remote?.ref;
  const name = file === undefined ? undefined : remoteName(file);
  return node === undefined || file === undefined || !name
    ? undefined
    : { node, file, home: `${name.owner}/${name.repo}` };
}

/**
 * Refuses a gesture made on the selection when it is inside a remote callee: the sentence goes to the status line and,
 * through `shown`, to the card. True when it refused.
 */
export function refuseRemote(store: SessionStore, shown: (seq: number, node: NodeId) => void): boolean {
  const s = store.getState();
  const at = s.edit.on ? remoteSelection(s) : undefined;
  if (!at) return false;
  const refused: Omit<Refused, 'seq'> = {
    refusal: { ok: false, reason: 'other-workflow', message: livesIn(at.home), file: at.file, fixes: [] },
    ops: [],
    at: 0,
    meta: {},
  };
  shown(s.refused(refused), at.node);
  return true;
}
