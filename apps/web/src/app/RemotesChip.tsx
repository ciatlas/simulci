import { offersGitHub } from '../github/load';
import { listed } from '../lib/words';
import type { RemoteNeed } from '../worker/protocol';
import { useSession } from './providers';

/** `3 remote workflows and 1 action`: what the project calls that the page has not read. */
function remotesWords(needed: readonly RemoteNeed[]): string {
  const workflows = needed.filter((n) => n.kind === 'workflow').length;
  const actions = needed.length - workflows;
  const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;
  return listed([
    ...(workflows ? [count(workflows, 'remote workflow')] : []),
    ...(actions ? [count(actions, workflows ? 'action' : 'remote action')] : []),
  ]);
}

/**
 * The status bar's chip for remotes not read (M4 synthesis § 5.3, failure mode 15): a folder, a paste or a sample asks
 * GitHub for nothing until the author clicks Fetch, and the click holds for the page's life. A GitHub repository opened
 * here never shows it: opening it was the click (one restored by a reload does, as nothing is asked before a click).
 * While a read is out it says so. A host whose API the page may not reach shows nothing.
 */
export function RemotesChip() {
  const needed = useSession((s) => s.remotes.needed);
  const consent = useSession((s) => s.remotes.consent);
  const fetching = useSession((s) => s.remotes.status === 'fetching');
  const consentRemotes = useSession((s) => s.consentRemotes);
  if (!offersGitHub()) return null;
  if (fetching) return <span className="shrink-0">reading remotes from api.github.com…</span>;
  if (consent !== 'none' || needed.length === 0) return null;
  return (
    <span className="shrink-0">
      {remotesWords(needed)} not fetched ·{' '}
      <button
        type="button"
        className="underline decoration-dotted hover:text-text"
        onClick={() => consentRemotes('page')}
      >
        Fetch from api.github.com
      </button>
    </span>
  );
}
