import type { Failure } from '@simulci/engine';
import type { ReactNode } from 'react';
import { fileLabel } from '../../lib/file-label';
import type { SessionActions, TestsState } from '../../state/store';
import type { TestedCase, TestedFile } from '../../worker/protocol';
import { headerOf, opensOnFailures, STATUS } from './words';

/**
 * The Tests tab (synthesis § 5.1): the route tests under `.github/simulci/tests`, run in the engine worker as
 * `simulci test --ci` runs them, after each plan of new files. "As CI", on by default, says so; off, a missing snapshot
 * passes, unwritten, and `only` is honoured. Cases are grouped by file; a failed one opens on its failures. Each case
 * shows its line in its test file, the workflow line that decided it, and loads its scenario and mocks into the form.
 * The page hands it the store's slice and actions: the chunk reaches no page module but leaves, so rolldown splits no
 * chunk the page and it would share (the shared-chunk rule of PR #73).
 */

export type TestsActions = Pick<SessionActions, 'setTestsCi' | 'revealLine' | 'loadCase'>;

export interface TestsProps {
  tests: TestsState;
  /** Whether the project loaded holds route tests. */
  hasTests: boolean;
  actions: TestsActions;
}

export function Tests({ tests, hasTests, actions }: TestsProps) {
  if (!tests.run && !hasTests && tests.status !== 'running') return <NoTests />;
  return (
    <section aria-label="Route tests" className="flex flex-col gap-3">
      <Header tests={tests} actions={actions} />
      {tests.status === 'failed' && (
        <p role="alert" className="text-danger text-sm">
          The tests could not run: {tests.error}
        </p>
      )}
      {tests.run ? (
        tests.run.files.map((file) => <File key={file.path} file={file} actions={actions} />)
      ) : (
        <Note>The tests run once the plan is in.</Note>
      )}
    </section>
  );
}

/** What the tab says when it has nothing to show, as the other tabs say it (`kit.tsx` `EmptyNote`). */
const Note = ({ children }: { children: ReactNode }) => <p className="text-muted text-sm">{children}</p>;

function NoTests() {
  return (
    <Note>
      No route tests in <code className="font-mono">.github/simulci/tests</code>. Add a case from a plan (Add
      case…) or{' '}
      <a
        href="https://github.com/ciatlas/simulci/blob/main/apps/docs/content/docs/reference/test-files.mdx"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-text"
      >
        read how
      </a>
      .
    </Note>
  );
}

function Header({ tests, actions }: { tests: TestsState; actions: TestsActions }) {
  const { run, ci } = tests;
  const running = tests.status === 'running';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status" className="font-mono text-xs tabular-nums">
        {running ? 'running…' : run ? headerOf(run) : ''}
      </p>
      <label
        className="flex items-center gap-1.5 text-muted text-xs"
        title="Run as simulci test --ci: a missing snapshot fails and only is invalid"
      >
        <input type="checkbox" checked={ci} onChange={(e) => actions.setTestsCi(e.target.checked)} />
        As CI
      </label>
    </div>
  );
}

function File({ file, actions }: { file: TestedFile; actions: TestsActions }) {
  const status = STATUS[file.status];
  return (
    <section
      aria-label={file.path}
      data-file={file.path}
      data-status={file.status}
      className="flex flex-col gap-1"
    >
      <h3 className="flex items-center gap-1.5 font-medium text-xs">
        <span aria-hidden="true" className={`w-3 text-center font-mono ${status.className}`}>
          {status.glyph}
        </span>
        <span className="font-mono" title={file.path}>
          {fileLabel(file.path)}
        </span>
        <span className="text-muted">{file.status}</span>
      </h3>
      {file.failures.length > 0 && <Failures failures={file.failures} file={file.path} />}
      {file.notes.map((note) => (
        <p key={note} className="text-muted text-xs">
          {note}
        </p>
      ))}
      <ul aria-label={`Cases in ${fileLabel(file.path)}`} className="flex flex-col">
        {file.cases.map((c, i) => (
          <Case key={`${i}:${c.name}`} c={c} file={file} actions={actions} />
        ))}
      </ul>
    </section>
  );
}

interface CaseProps {
  c: TestedCase;
  file: TestedFile;
  actions: TestsActions;
}

function Case({ c, file, actions }: CaseProps) {
  const status = STATUS[c.status];
  const title = (
    <span className="flex min-w-0 items-center gap-1.5 text-sm">
      <span aria-hidden="true" className={`w-3 shrink-0 text-center font-mono ${status.className}`}>
        {status.glyph}
      </span>
      <span className="min-w-0 break-words">{c.name}</span>
      <span className="shrink-0 text-muted text-xs">
        {c.status}
        {c.reason !== undefined && ` (${c.reason})`}
      </span>
    </span>
  );
  return (
    <li
      data-case={c.name}
      data-status={c.status}
      className="flex flex-col gap-1 border-border border-b py-2 last:border-b-0"
    >
      {opensOnFailures(c) ? (
        <details open className="group">
          <summary className="flex cursor-default list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
            {title}
            <span aria-hidden="true" className="text-[10px] text-muted group-open:rotate-90">
              ▸
            </span>
          </summary>
          <Failures failures={c.failures} file={file.path} />
        </details>
      ) : (
        title
      )}
      {c.notes.map((note) => (
        <p key={note} className="pl-4.5 text-muted text-xs">
          {note}
        </p>
      ))}
      <Actions c={c} file={file} actions={actions} />
    </li>
  );
}

function Failures({ failures, file }: { failures: Failure[]; file: string }) {
  return (
    <ul className="flex flex-col gap-1.5 pt-1 pl-4.5">
      {failures.map((f, i) => (
        <li key={i} className="flex flex-col gap-0.5">
          <p className="whitespace-pre-wrap break-words text-sm">
            {f.headline}{' '}
            <span className="font-mono text-[11px] text-muted">
              {fileLabel(file)}:{f.at.line}
            </span>
          </p>
          {f.detail.length > 0 && (
            <pre className="overflow-x-auto rounded bg-chrome px-2 py-1 font-mono text-[11px] leading-snug">
              {f.detail.join('\n')}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Text buttons, as the panels' `file:line` links are drawn (`kit.tsx` `LocLink`), so three per case stay quiet. */
const BUTTON =
  'rounded px-1 text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-text disabled:no-underline disabled:opacity-60';

/** Show in test file, Show deciding line and Load into scenario; each names its case for a screen reader. */
function Actions({ c, file, actions }: CaseProps) {
  const named = <span className="sr-only">: {c.name}</span>;
  const { deciding, scenario, assume } = c;
  const workflow = file.workflow;
  return (
    <div className="flex flex-wrap gap-x-2 pl-3.5">
      <button
        type="button"
        className={BUTTON}
        onClick={() => actions.revealLine({ file: file.path, line: c.line })}
      >
        Show in test file{named}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={!deciding}
        onClick={() => deciding && actions.revealLine({ file: deciding.file, line: deciding.line })}
      >
        Show deciding line{named}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={!scenario || workflow === undefined}
        onClick={() => scenario && workflow && actions.loadCase(scenario, assume ?? [], workflow)}
      >
        Load into scenario{named}
      </button>
    </div>
  );
}
