import { useEffect } from 'react';
import { redoLabel, undoLabel } from '../state/history';
import { dirtyPaths } from '../state/store';
import { CopyAsTest } from '../testcase/CopyAsTest';
import { ChangesButton } from './ChangesButton';
import { useSession } from './providers';
import { SourceMenu } from './SourceMenu';
import { NEXT_THEME } from './theme';
import { ViewToggle } from './ViewToggle';

const THEME_LABEL = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' } as const;

/**
 * What the Shortcuts switch turns on and off (app/shortcuts.ts); the canvas's own keys need the focus in it. The
 * switch says on or off in words, so its state does not lean on a colour.
 */
const KEYS_HINT =
  'The single keys t, f, ., 0, r, c, e, 1 to 4, [, ] and \\, and i, a, n and s in edit mode, act on the page while this is on';

const button =
  'rounded border border-border bg-surface px-2 py-1 text-text hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

/** The page's chrome: the ways in, the scenario id, the engine, the view, the page keys and the theme. */
export function TopBar() {
  const scenarioId = useSession((s) => s.plan?.plan.scenario.id);
  const engine = useSession((s) => s.engine);
  const ms = useSession((s) => (s.plan ? s.plan.ms.simulate + s.plan.ms.derive : undefined));
  const stale = useSession((s) => s.staleShown);
  const theme = useSession((s) => s.ui.prefs.theme);
  const keys = useSession((s) => s.ui.prefs.keys);
  const setPrefs = useSession((s) => s.setPrefs);

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-border border-b bg-chrome px-4 py-2">
      <h1 className="font-semibold text-base tracking-tight" style={{ fontStretch: '110%' }}>
        simulci
      </h1>
      <SourceMenu />
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2 text-muted text-xs">
        {scenarioId && (
          <span
            className="rounded border border-border bg-surface px-2 py-0.5 font-mono text-text"
            title="the scenario"
          >
            {scenarioId}
            {stale && <span className="ml-1 text-might-text">· stale</span>}
          </span>
        )}
        <span aria-live="off" title="the engine in the worker">
          {engine.status === 'booting' && 'engine starting…'}
          {engine.status === 'failed' && <span className="text-danger">engine failed</span>}
          {engine.status === 'ready' &&
            (engine.busy
              ? 'simulating…'
              : ms === undefined
                ? `engine ${engine.version}`
                : `${ms.toFixed(1)} ms`)}
        </span>
        <ViewToggle />
        <EditControls />
        <ChangesButton />
        <CopyAsTest />
        <button
          type="button"
          className="rounded border border-border bg-surface px-2 py-1 text-text hover:border-border-strong"
          onClick={() => setPrefs({ keys: !keys })}
          role="switch"
          aria-checked={keys}
          title={KEYS_HINT}
        >
          Shortcuts{' '}
          <span aria-hidden="true" className="font-mono">
            {keys ? 'on' : 'off'}
          </span>
        </button>
        <button
          type="button"
          className="rounded border border-border bg-surface px-2 py-1 text-text hover:border-border-strong"
          onClick={() => setPrefs({ theme: NEXT_THEME[theme] })}
          aria-label={`${THEME_LABEL[theme]}; switch to ${NEXT_THEME[theme]}`}
        >
          {THEME_LABEL[theme]}
        </button>
      </div>
    </header>
  );
}

/**
 * Edit mode's switch (`e`, `edit=1`), and in edit mode Undo and Redo, each naming the entry it would take back or do
 * again ("Undo Typed in ci.yml"; Mod+Z, Mod+Shift+Z and Mod+Y do the same). The page's title starts with "• " while
 * a file has unsaved edits.
 */
function EditControls() {
  const on = useSession((s) => s.edit.on);
  const keys = useSession((s) => s.ui.prefs.keys);
  const undo = useSession((s) => undoLabel(s.edit));
  const redo = useSession((s) => redoLabel(s.edit));
  const dirty = useSession((s) => dirtyPaths(s.files).length > 0);
  const setEdit = useSession((s) => s.setEdit);
  const doUndo = useSession((s) => s.undo);
  const doRedo = useSession((s) => s.redo);
  useEffect(() => {
    document.title = dirty ? '• simulci' : 'simulci';
  }, [dirty]);
  return (
    <>
      <button
        type="button"
        className={button}
        role="switch"
        aria-checked={on}
        aria-keyshortcuts={keys ? 'e' : undefined}
        onClick={() => setEdit(!on)}
      >
        Edit{' '}
        <span aria-hidden="true" className="font-mono">
          {on ? 'on' : 'off'}
        </span>
      </button>
      {on && (
        <>
          <HistoryButton verb="Undo" entry={undo} keys="Control+Z Meta+Z" act={doUndo} />
          <HistoryButton
            verb="Redo"
            entry={redo}
            keys="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y"
            act={doRedo}
          />
        </>
      )}
    </>
  );
}

/** Undo or Redo, named by the entry it would take back or do again; disabled with none. */
function HistoryButton({
  verb,
  entry,
  keys,
  act,
}: {
  verb: 'Undo' | 'Redo';
  entry: string | undefined;
  keys: string;
  act: () => boolean;
}) {
  const name = entry === undefined ? verb : `${verb} ${entry}`;
  // aria-disabled rather than disabled: a button that empties its history keeps the focus.
  return (
    <button
      type="button"
      className={button}
      aria-disabled={entry === undefined}
      aria-label={name}
      title={entry === undefined ? `Nothing to ${verb.toLowerCase()}` : name}
      aria-keyshortcuts={keys}
      onClick={() => {
        if (entry !== undefined) act();
      }}
    >
      {verb}
    </button>
  );
}
