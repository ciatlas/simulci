import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useModal } from '../app/modal';
import type { GitHubOpened } from '../input/sources';
import { type RepoTarget, repoName } from '../lib/repo-words';
import { describeRepository, type ReadOptions } from './read';
import type { RepoInfo } from './repo';
import { parseRepoInput } from './target';

/**
 * Open a GitHub repository (M4 synthesis § 5.5): a name or a github.com link, what GitHub says of the repository once
 * the name is whole (one request, half a second after the last key), then Open, which reads its files with their
 * count as it goes and a Cancel that stops it. The page's sources open what was read (`input/sources.ts`), asking
 * first when edits would be lost; this view, in the `github-*` chunk, gets them as a prop, so the chunk shares no
 * store or provider module with the page.
 */
export interface OpenRepoProps {
  open: (target: RepoTarget, options: ReadOptions) => Promise<GitHubOpened>;
  onClose: () => void;
  /** What the field holds first. */
  initial?: string;
}

/** How long the field waits after the last key before it asks GitHub about the name. */
const DESCRIBE_AFTER_MS = 500;

type Described = { for: string; info?: RepoInfo; line: string; failed?: true };

export function OpenRepo({ open, onClose, initial = '' }: OpenRepoProps) {
  const dialog = useModal(onClose);
  const [text, setText] = useState(initial);
  const parsed = parseRepoInput(text);
  const described = useDescribed(parsed.ok ? parsed.target : undefined);
  const [reading, setReading] = useState<{ done: number; total: number; stop: AbortController }>();
  const [failure, setFailure] = useState<string>();

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!parsed.ok || reading) return;
    const stop = new AbortController();
    setFailure(undefined);
    setReading({ done: 0, total: 0, stop });
    const known = described?.for === key(parsed.target) ? described.info : undefined;
    const opened = await open(parsed.target, {
      signal: stop.signal,
      onProgress: (done, total) => setReading((r) => (r?.stop === stop ? { ...r, done, total } : r)),
      ...(known ? { known } : {}),
    });
    setReading(undefined);
    if (opened.ok) dialog.current?.close();
    else if (opened.message) setFailure(opened.message);
  };

  const cancel = (): void => {
    if (reading) {
      reading.stop.abort();
      setReading(undefined);
    } else dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/40"
      aria-labelledby="github-title"
      aria-describedby="github-reads"
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 p-4">
        <h2 id="github-title" className="font-semibold">
          Open a GitHub repository
        </h2>
        <label className="flex flex-col gap-1 text-sm">
          Repository
          <input
            className="rounded border border-border bg-bg px-2 py-1 font-mono text-sm"
            value={text}
            placeholder="owner/repo, or a github.com link"
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="github-about"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one field of the dialog
            autoFocus
          />
        </label>
        <p id="github-about" className="min-h-5 text-muted text-sm">
          {aboutLine(parsed, described)}
        </p>
        <p id="github-reads" className="text-sm">
          simulci reads its workflow files, and the workflows and actions they call, from api.github.com.
        </p>
        <p role="status" className="text-sm">
          {reading &&
            (reading.total
              ? `Reading ${reading.done} of ${reading.total} files…`
              : 'Reading the repository…')}
        </p>
        {failure && (
          <p role="alert" className="text-danger text-sm">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded border border-border px-3 py-1.5 text-sm" onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-accent px-3 py-1.5 text-on-accent text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!parsed.ok || reading !== undefined}
          >
            Open
          </button>
        </div>
      </form>
    </dialog>
  );
}

const key = (t: RepoTarget): string => `${t.owner}/${t.repo}`.toLowerCase();

/** The line under the field: why the text does not open, or what GitHub said of the repository. */
function aboutLine(parsed: ReturnType<typeof parseRepoInput>, described: Described | undefined): string {
  if (!parsed.ok) return parsed.message ?? '';
  if (described?.for !== key(parsed.target)) return '';
  return described.line;
}

/** What GitHub says of the repository a whole name names, asked once per name, after the typing stops. */
function useDescribed(target: RepoTarget | undefined): Described | undefined {
  const [described, setDescribed] = useState<Described>();
  const asked = useRef(new Map<string, Described>());
  const name = target && key(target);
  useEffect(() => {
    if (!target || !name) return undefined;
    const known = asked.current.get(name);
    if (known) {
      setDescribed(known);
      return undefined;
    }
    const stop = new AbortController();
    const timer = setTimeout(() => {
      describeRepository(target, { signal: stop.signal }).then(
        ({ info, rate }) => {
          const line = [
            repoName(info),
            info.private ? 'private' : 'public',
            `default branch ${info.defaultBranch}`,
            ...(rate ? [rate] : []),
          ].join(' · ');
          const d = { for: name, info, line };
          asked.current.set(name, d);
          setDescribed(d);
        },
        (e: unknown) => {
          if (!stop.signal.aborted)
            setDescribed({ for: name, line: e instanceof Error ? e.message : String(e), failed: true });
        },
      );
    }, DESCRIBE_AFTER_MS);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
    // The name, not the object: a new parse of the same text is the same repository.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  return described;
}
