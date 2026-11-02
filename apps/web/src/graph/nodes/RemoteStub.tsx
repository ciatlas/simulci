import type { MouseEvent } from 'react';
import { useApp, useSession } from '../../app/providers';
import { retryRemotes } from '../../engine/remotes';
import { offersGitHub } from '../../github/load';
import type { RemoteStub } from '../remote';
import { calleeOffset } from '../size';
import { CARD, type JobModel } from '../types';

/**
 * The dashed stub in a call job's card where its remote callee would be (M4 synthesis § 5.4): the callee's title and
 * why the plan does not simulate it, with Fetch while the author has not let the page read remotes, or Retry for a
 * read GitHub may answer now. Its buttons are tab stops only while the card holds the selection.
 */
export function RemoteStubView({
  job,
  stub,
  tabStop,
}: {
  job: JobModel;
  stub: RemoteStub;
  tabStop: boolean;
}) {
  const at = calleeOffset(job);
  return (
    <div
      className="sc-stub"
      data-state={stub.state}
      style={{
        left: at.x,
        top: at.y,
        width: `calc(100% - ${2 * CARD.callPadding}px)`,
        height: CARD.stub.height,
      }}
    >
      <p className="sc-stub-title">
        <span aria-hidden="true">↗</span>
        <span className="sc-stub-name">
          <span className="font-mono">{stub.title}</span>, {stub.status}.
        </span>
      </p>
      <p className="sc-stub-words">
        {stub.words} <StubAction stub={stub} tabStop={tabStop} />
      </p>
    </div>
  );
}

function StubAction({ stub, tabStop }: { stub: RemoteStub; tabStop: boolean }) {
  const { store } = useApp();
  const consent = useSession((s) => s.remotes.consent);
  const fetching = useSession((s) => s.remotes.status === 'fetching');
  const action = stubAction(stub, consent);
  if (!action) return null;
  if (fetching) return <span className="text-muted">Reading…</span>;
  const click = (e: MouseEvent): void => {
    e.stopPropagation();
    if (action === 'fetch') store.getState().consentRemotes('page');
    else retryRemotes(store, [stub.ref]);
  };
  return (
    <button
      type="button"
      className="sc-stub-action nodrag nopan"
      tabIndex={tabStop ? 0 : -1}
      aria-label={action === 'fetch' ? 'Fetch remote workflows from api.github.com' : `Retry ${stub.title}`}
      onClick={click}
    >
      {action === 'fetch' ? 'Fetch' : 'Retry'}
    </button>
  );
}

/** Fetch while the author has not let the page read remotes; Retry once they have; neither where GitHub is not asked. */
function stubAction(stub: RemoteStub, consent: string): RemoteStub['action'] {
  if (!stub.action || !offersGitHub()) return undefined;
  return (stub.action === 'fetch') === (consent === 'none') ? stub.action : undefined;
}
