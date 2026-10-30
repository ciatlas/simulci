import { Suspense, useState } from 'react';
import { OpenRepoDialog, offersGitHub } from '../github/load';
import { SAMPLES } from '../input/samples';
import { PasteDialog } from './PasteDialog';
import { useApp, useSession } from './providers';

const card = 'rounded-lg border border-border bg-surface p-4';
const button = 'rounded border border-border bg-chrome px-3 py-1.5 text-sm hover:border-border-strong';

/** No files yet: the ways in, the samples, and a folder to reopen when the last visit left one. */
export function EmptyState() {
  const { sources } = useApp();
  const source = useSession((s) => s.source);
  const [pasting, setPasting] = useState(false);
  const [opening, setOpening] = useState(false);
  const github = offersGitHub();
  const reopen = source.kind === 'folder' && source.handle ? source.name : undefined;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-6">
      <div>
        <h2 className="font-semibold text-2xl tracking-tight" style={{ fontStretch: '110%' }}>
          What runs if…
        </h2>
        <p className="mt-1 text-muted">
          Give simulci a repository's workflow files; it tells you which jobs and steps run for an event, and
          why. Your files never leave this page
          {github && '; a public GitHub repository is read from api.github.com'}.
        </p>
      </div>
      {reopen && (
        <div className={`${card} flex items-center justify-between gap-4`}>
          <p>
            <span className="font-medium">{reopen}</span> was open last time. The browser needs a click to
            read it again.
          </p>
          <button type="button" className={button} onClick={() => void sources.reopen()}>
            Reopen {reopen}
          </button>
        </div>
      )}
      <div className={`grid gap-4 sm:grid-cols-2 ${github ? 'lg:grid-cols-3' : ''}`}>
        <div className={card}>
          <h3 className="font-medium">A folder</h3>
          <p className="mt-1 text-muted text-sm">
            A checkout, or any folder holding <code className="font-mono">.github/workflows</code>. Drop it
            anywhere on the page, or
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {sources.canPickFolder ? (
              <button type="button" className={button} onClick={() => void sources.openFolder()}>
                Open folder
              </button>
            ) : (
              <p className="text-muted text-xs">Use Choose folder in the bar above (the files are copied).</p>
            )}
          </div>
        </div>
        <div className={card}>
          <h3 className="font-medium">Pasted YAML</h3>
          <p className="mt-1 text-muted text-sm">
            One workflow or several, each at a path such as{' '}
            <code className="font-mono">.github/workflows/ci.yml</code>.
          </p>
          <button type="button" className={`${button} mt-3`} onClick={() => setPasting(true)}>
            Paste YAML
          </button>
        </div>
        {github && (
          <div className={card}>
            <h3 className="font-medium">A GitHub repository</h3>
            <p className="mt-1 text-muted text-sm">
              A public repository, by name or link, at its default branch or a ref.
            </p>
            <button type="button" className={`${button} mt-3`} onClick={() => setOpening(true)}>
              Open GitHub repository…
            </button>
          </div>
        )}
      </div>
      <div className={card}>
        <h3 className="font-medium">Or try a sample</h3>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {SAMPLES.map((s) => (
            <li key={s.name}>
              <button
                type="button"
                className="w-full rounded border border-border bg-chrome p-3 text-left hover:border-border-strong"
                onClick={() => sources.useSample(s.name)}
              >
                <span className="font-medium">{s.title}</span>
                <span className="mt-0.5 block text-muted text-xs">{s.blurb}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {pasting && <PasteDialog onClose={() => setPasting(false)} />}
      {opening && (
        <Suspense fallback={null}>
          <OpenRepoDialog
            open={(target, options) => sources.openGitHub(target, options)}
            onClose={() => setOpening(false)}
          />
        </Suspense>
      )}
    </main>
  );
}
