import { useState } from 'react';
import { isTarget, type RepoTarget, repoName } from '../lib/repo-words';
import { useApp, useSession } from './providers';

const button =
  'rounded border border-border bg-surface px-2 py-1 text-xs text-text hover:border-border-strong';

/**
 * A link that names a repository the page has not open (`gh=`, M4 synthesis § 5.5, failure mode 15): the page asks
 * first and sends GitHub nothing before the click. A link to the repository stored here opens it offline instead, and
 * this never shows.
 */
export function GitHubOffer() {
  const offer = useSession((s) =>
    s.githubOffer && !isTarget(s.source, s.githubOffer) ? s.githubOffer : undefined,
  );
  return offer ? <Offer key={`${offer.owner}/${offer.repo}@${offer.ref ?? ''}`} offer={offer} /> : null;
}

function Offer({ offer }: { offer: RepoTarget }) {
  const { store, sources } = useApp();
  const [reading, setReading] = useState<{ done: number; total: number; stop: AbortController }>();
  const [failure, setFailure] = useState<string>();
  const name = `${repoName(offer)}${offer.ref === undefined ? '' : ` @ ${offer.ref}`}`;

  const open = async (): Promise<void> => {
    const stop = new AbortController();
    setFailure(undefined);
    setReading({ done: 0, total: 0, stop });
    const opened = await sources.openGitHub(offer, {
      signal: stop.signal,
      onProgress: (done, total) => setReading((r) => (r?.stop === stop ? { ...r, done, total } : r)),
    });
    setReading(undefined);
    if (!opened.ok && opened.message) setFailure(opened.message);
  };

  return (
    <section
      aria-label="Open from GitHub"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-border border-b bg-surface px-4 py-2 text-sm"
    >
      <p className="min-w-0 flex-1">
        Open <strong className="font-semibold">{name}</strong> from GitHub? simulci reads its workflow files,
        and the workflows and actions they call, from api.github.com.
      </p>
      <p role="status" className="text-muted text-xs">
        {reading &&
          (reading.total ? `Reading ${reading.done} of ${reading.total} files…` : 'Reading the repository…')}
      </p>
      {failure && (
        <p role="alert" className="basis-full text-danger text-xs">
          {failure}
        </p>
      )}
      {reading ? (
        <button
          type="button"
          className={button}
          onClick={() => {
            reading.stop.abort();
            setReading(undefined);
          }}
        >
          Cancel
        </button>
      ) : (
        <>
          <button type="button" className={button} onClick={() => store.getState().offerGitHub(undefined)}>
            Dismiss
          </button>
          <button
            type="button"
            className="rounded bg-accent px-2 py-1 text-on-accent text-xs"
            onClick={() => void open()}
          >
            Open {repoName(offer)}
          </button>
        </>
      )}
    </section>
  );
}
