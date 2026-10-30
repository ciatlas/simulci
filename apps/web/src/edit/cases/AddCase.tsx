import type { CaseJson } from '@simulci/document';
import { useEffect, useId, useMemo, useState } from 'react';
import { useApp, useSession } from '../../app/providers';
import { fileLabel } from '../../lib/file-label';
import type { SessionState } from '../../state/store';
import { documents } from '../documents';
import { RefusalNote } from '../Refusal';
import { addTestCase, nameIn, type Placement, placementOf, showAdded } from './add';

interface AddCaseProps {
  /** The depth-0 workflow the case is about. */
  workflow: string;
  /** The case the dialog shows; undefined while there is none to add (a plan format, an answer to come, a failure). */
  testCase: CaseJson | undefined;
  /** Tells the dialog the `given` of the file the case goes to, as JSON text, so the case is planned under it. */
  onGiven: (given: string | undefined) => void;
  /** Closes the dialog once the case is written. */
  onAdded: () => void;
}

/**
 * Whether Save writes to the folder, as the saver decides it (`app/saver.ts` `canSave`, which the edit runtime does not
 * import: the saver reaches the dialogs, and they this runtime).
 */
const savesToFolder = (s: Pick<SessionState, 'source'>): boolean =>
  s.source.kind === 'folder' && s.source.handle !== undefined;

/**
 * Where the case goes, read from the texts now, so it follows an edit made behind the dialog; the documents are cached
 * by revision, so this parses a file once. The file's `given` goes to the dialog.
 */
function usePlacement(workflow: string, onGiven: AddCaseProps['onGiven']): Placement {
  const { store } = useApp();
  const files = useSession((s) => s.files);
  const generated = useSession((s) => s.generated);
  const edit = useSession((s) => s.edit);
  const to = useMemo(
    () => placementOf({ files, generated, edit }, documents(store), workflow),
    [store, files, generated, edit, workflow],
  );
  const given = to.kind === 'add' ? to.given : undefined;
  useEffect(() => onGiven(given), [onGiven, given]);
  return to;
}

/**
 * The case dialog's destination (synthesis § 4.9): the case's name, which the author may change, and the button that
 * adds it to the workflow's test file, or creates that file, as one undoable entry. A refusal (a file testing another
 * workflow, one that does not parse) shows under the button with its fixes; whichever writes the case closes the
 * dialog, and the page shows the case in the YAML pane, unsaved.
 */
export function AddCase({ workflow, testCase, onGiven, onAdded }: AddCaseProps) {
  const { store } = useApp();
  const to = usePlacement(workflow, onGiven);
  const saves = useSession(savesToFolder);
  const github = useSession((s) => s.source.kind === 'github');
  const suggested = testCase?.name ?? '';
  const [typed, setTyped] = useState<{ for: string; name: string }>();
  const name = typed?.for === suggested ? typed.name : suggested;
  const [seq, setSeq] = useState<number>();
  const heading = useId();
  const ready = testCase !== undefined && name.trim() !== '';

  const done = (): void => {
    setSeq(undefined);
    onAdded();
  };
  const add = (): void => {
    if (!testCase || !ready) return;
    const result = addTestCase(store, to, workflow, { ...testCase, name });
    if (!result.ok) setSeq(result.refused.seq);
    else if (result.changed) done();
  };

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 rounded border border-border p-3">
      <h3 id={heading} className="font-medium text-sm">
        Add it to the repository
      </h3>
      <NameField
        to={to}
        name={name}
        disabled={testCase === undefined}
        onChange={(next) => setTyped({ for: suggested, name: next })}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          className="rounded border border-border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!ready}
          onClick={add}
        >
          {to.kind === 'add' ? 'Add to' : 'Create'} {fileLabel(to.path)}
        </button>
        <Where to={to} saves={saves} github={github} />
      </div>
      <RefusalNote
        seq={seq}
        onFixed={() => {
          showAdded(store);
          done();
        }}
      />
    </section>
  );
}

/** The case's name, and the name it is written under when the file already has a case by it. */
function NameField({
  to,
  name,
  disabled,
  onChange,
}: {
  to: Placement;
  name: string;
  disabled: boolean;
  onChange: (name: string) => void;
}) {
  const field = useId();
  const written = nameIn(to, name);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={field} className="text-muted text-sm">
        Case name
      </label>
      <input
        id={field}
        type="text"
        className="rounded border border-border bg-bg px-2 py-1 text-sm"
        value={name}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {written !== name && (
        <p className="text-muted text-xs">
          {fileLabel(to.path)} has a case by that name: this one is added as{' '}
          <code className="font-mono">{written}</code>.
        </p>
      )}
    </div>
  );
}

/**
 * The file the case goes to, how many cases it holds, whether its `given` applies to the case, and what writes it to
 * the repository.
 */
function Where({ to, saves, github }: { to: Placement; saves: boolean; github: boolean }) {
  const count = to.kind === 'add' ? to.cases : 0;
  return (
    <p className="min-w-0 flex-1 text-muted text-xs">
      {to.kind === 'add' ? 'Into ' : 'A new '}
      <code className="break-all font-mono">{to.path}</code>
      {to.kind === 'add' && ` (${count} ${count === 1 ? 'case' : 'cases'})`}, where{' '}
      <code className="font-mono">simulci test</code> runs it
      {to.kind === 'add' && to.given !== undefined && (
        <>
          {' '}
          with the file&apos;s <code className="font-mono">given</code>, which the case above is planned under
        </>
      )}
      . It stays unsaved until you{' '}
      {saves ? 'save it to the folder' : `download it${github ? ' in a patch' : ''}`}.
    </p>
  );
}
