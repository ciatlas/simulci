import type { RemoteUse } from '@simulci/engine';
import { retryRemotes } from '../engine/remotes';
import { offersGitHub } from '../github/load';
import { failureWords } from '../graph/remote';
import { listed } from '../lib/words';
import type { RemoteNeed } from '../worker/protocol';
import { useApp, useSession } from './providers';

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

/**
 * `3 remote workflows and 1 action`, or after a count of the plan's remote workflows, `2 workflows and 1 action`:
 * what the project calls that the page has not read.
 */
function remotesWords(needed: readonly RemoteNeed[], counted: boolean): string {
  const workflows = needed.filter((n) => n.kind === 'workflow').length;
  const actions = needed.length - workflows;
  if (counted && actions === 0) return String(workflows);
  return listed([
    ...(workflows ? [count(workflows, counted ? 'workflow' : 'remote workflow')] : []),
    ...(actions ? [count(actions, workflows || counted ? 'action' : 'remote action')] : []),
  ]);
}

/** The remote workflows the plan calls, a ref read at two commits counted once; and the refs a Retry may read. */
function planned(rows: readonly RemoteUse[] | undefined): { workflows: number; retry: string[] } {
  const workflows = new Set((rows ?? []).filter((r) => r.kind === 'workflow').map((r) => r.ref));
  const retry = (rows ?? [])
    .filter((r) => r.state === 'failed' && failureWords(r.failure).retry)
    .map((r) => r.ref);
  return { workflows: workflows.size, retry: [...new Set(retry)] };
}

const BUTTON = 'underline decoration-dotted hover:text-text';

/**
 * The status bar's line of remotes (M4 synthesis § 5.3-5.4, failure mode 15): `3 remote workflows · 2 not fetched ·
 * Fetch from api.github.com`. A folder, a paste or a sample asks GitHub for nothing until the author clicks Fetch, and
 * the click holds for the page's life. A GitHub repository opened here never offers it: opening it was the click (one
 * restored by a reload does, as nothing is asked before a click). Reads GitHub may answer now (it did not, or its rate
 * limit was spent) offer Retry. While a read is out it says so. A host whose API the page may not reach shows only
 * the count.
 */
export function RemotesChip() {
  const { store } = useApp();
  const needed = useSession((s) => s.remotes.needed);
  const consent = useSession((s) => s.remotes.consent);
  const fetching = useSession((s) => s.remotes.status === 'fetching');
  const rows = useSession((s) => s.plan?.plan.remotes);
  const consentRemotes = useSession((s) => s.consentRemotes);
  const { workflows, retry } = planned(rows);
  const offers = offersGitHub();
  if (offers && fetching) return <span className="shrink-0">reading remotes from api.github.com…</span>;
  const fetch = offers && consent === 'none' && needed.length > 0;
  const again = offers && consent !== 'none' && retry.length > 0;
  if (workflows === 0 && !fetch && !again) return null;
  return (
    <span className="shrink-0">
      {workflows > 0 && count(workflows, 'remote workflow')}
      {fetch && (
        <>
          {workflows > 0 && ' · '}
          {remotesWords(needed, workflows > 0)} not fetched ·{' '}
          <button type="button" className={BUTTON} onClick={() => consentRemotes('page')}>
            Fetch from api.github.com
          </button>
        </>
      )}
      {again && (
        <>
          {workflows > 0 && ' · '}
          {retry.length} not read ·{' '}
          <button type="button" className={BUTTON} onClick={() => retryRemotes(store, retry)}>
            Retry
          </button>
        </>
      )}
    </span>
  );
}
