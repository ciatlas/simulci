import { type Json, planOp, type WorkflowDocument } from '@simulci/document';
import { useMemo } from 'react';
import { useApp, useSession } from '../../app/providers';
import { callsOut } from '../../lib/unit-path';
import { EmptyNote } from '../../panels/kit';
import { newestOutline } from '../../state/store';
import { storeLock } from '../dispatch';
import { documents } from '../documents';
import { gestures } from '../gestures';
import { RefusalView } from '../Refusal';
import { livesIn, remoteSelection } from '../remote';
import { type Target, targetOf } from '../selection';
import type { Refused } from '../types';
import { MatrixEditor } from '../matrix/MatrixEditor';
import { catalogAction, catalogInputs, splitUses, useCatalog } from '../catalog';
import { PropertyField } from './Field';
import { KeyValueRows } from './KeyValueRows';
import { asText, type FieldSpec, jobFields, stepFields, workflowFields } from './model';
import { PinToSha } from './Pin';
import { PanelSteps } from '../steps/PanelSteps';
import { EvaluatesTo, Needs, YamlRows } from './sections';
import type { SessionTarget } from './session';

/**
 * The Node tab in edit mode (synthesis § 4.4): the selected workflow, job or step as fields of its file. Values come
 * from the text now, through the document, not from the plan; the plan's facts stay under the panel, read-only. A
 * route-deciding value is a field; the rest of the YAML is a row with Edit in YAML. A locked file (generated, broken
 * YAML, mixed line endings, too large) says why above fields that take no input.
 */
export function Properties() {
  const { store } = useApp();
  const focus = useSession((s) => s.focus);
  const sel = useSession((s) => s.sel);
  // A new text, or a new lock of it, is a new document: the target is read again.
  const rev = useSession((s) => (focus === undefined ? undefined : s.files.revs[focus]));
  const marker = useSession((s) => (focus === undefined ? undefined : s.generated?.[focus]));
  const unlocked = useSession((s) => s.edit.unlocked);
  const target = useMemo(() => targetOf(store, focus, sel), [store, focus, sel, rev, marker, unlocked]);
  if (!target) {
    const remote = callsOut(sel) ? remoteSelection(store.getState()) : undefined;
    return (
      <EmptyNote>
        {remote
          ? livesIn(remote.home)
          : callsOut(sel)
            ? 'This is a job of the workflow it calls: select it there to edit it.'
            : 'Select a workflow, a job or a step of the focused workflow to edit it.'}
      </EmptyNote>
    );
  }
  const doc = documents(store).of(store.getState(), target.file)!;
  return <Editor target={target} doc={doc} />;
}

function Editor({ target, doc }: { target: Target; doc: WorkflowDocument }) {
  const lock = useFileLock(target, doc);
  const locked = lock !== undefined;
  return (
    <div className="flex flex-col gap-4" aria-label="Properties">
      {lock && (
        <div className="flex flex-col gap-1.5 rounded border border-might bg-might-soft px-2 py-1.5 text-xs">
          <RefusalView refused={lock} dismiss={false} />
        </div>
      )}
      {target.path.length === 0 && <WorkflowProperties target={target} doc={doc} locked={locked} />}
      {target.path.length === 2 && <JobProperties target={target} doc={doc} locked={locked} />}
      {target.step && <StepProperties target={target} doc={doc} locked={locked} />}
    </div>
  );
}

/**
 * Why no field of the file takes input: the document's lock (generated, broken YAML, more than one document, too
 * large), mixed line endings, bytes that are not UTF-8. The refusal an op would get, with its fixes (Edit anyway,
 * Convert to LF, Show line 14).
 */
function useFileLock(target: Target, doc: WorkflowDocument): Refused | undefined {
  const { store } = useApp();
  const meta = useSession((s) => s.files.meta[target.file]);
  const known = useSession((s) => s.generated !== undefined);
  return useMemo(() => {
    const refusal =
      storeLock(store.getState(), target.file) ??
      (!doc.status.editable
        ? doc.status.refusal
        : meta?.eol === 'mixed'
          ? probe(store, target.file)
          : undefined);
    if (!refusal || refusal.ok) return undefined;
    return { seq: 0, refusal, ops: [], at: 0, meta: { revs: { [target.file]: target.rev } } };
  }, [store, target, doc, meta, known]);
}

/** The refusal any op on the file gets before it asks anything: what locks the file as a whole. */
function probe(store: ReturnType<typeof useApp>['store'], file: string) {
  const s = store.getState();
  const docs = documents(store);
  return planOp({ op: 'setWorkflowField', file, field: 'name', value: null }, { doc: (p) => docs.of(s, p) });
}

interface PartProps {
  target: Target;
  doc: WorkflowDocument;
  locked: boolean;
}

function Fields({ specs, target, doc, locked }: PartProps & { specs: FieldSpec[] }) {
  const request = useFieldRequest();
  const options = useRunnerLabels(doc);
  const session: SessionTarget = target.step
    ? { file: target.file, step: { job: target.job!, index: target.step.index } }
    : { file: target.file };
  return (
    <div className="flex flex-col gap-3">
      {specs.map((spec) => (
        <PropertyField
          key={spec.key}
          spec={spec}
          target={session}
          doc={doc}
          locked={locked}
          {...(spec.key === 'if' ? { idle: 400, after: <EvaluatesTo /> } : {})}
          {...(request?.field === spec.key ? { request } : {})}
          {...(spec.key === 'runs-on' ? { options } : {})}
          {...(spec.key === 'uses' && target.step
            ? {
                after: (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ChangeUses target={target} locked={locked} />
                    <PinToSha target={target} doc={doc} locked={locked} />
                  </div>
                ),
              }
            : {})}
        />
      ))}
    </div>
  );
}

/**
 * A request to put the focus in a field once this panel shows it: the `i` key's Run if, a script step's Run once the
 * palette inserted it.
 */
function useFieldRequest(): { field: string; seq: number; done: () => void } | undefined {
  const request = useSession((s) => s.propertyFocus);
  const done = useSession((s) => s.propertyFocused);
  return request && { ...request, done: () => done(request.seq) };
}

/** Uses → Change… (synthesis § 4.4): the palette, to pick another action for the step. */
function ChangeUses({ target, locked }: { target: Target; locked: boolean }) {
  const { store } = useApp();
  const { job, step } = target;
  if (job === undefined || !step) return null;
  return (
    <button
      type="button"
      disabled={locked}
      className="self-start rounded border border-border px-2 py-0.5 text-xs hover:bg-chrome disabled:opacity-50"
      onClick={() => gestures.of(store)?.palette({ job, index: step.index, change: true })}
    >
      Change…
    </button>
  );
}

/** The runner labels the file's jobs use, and GitHub's hosted ones: what Runs on offers. */
function useRunnerLabels(doc: WorkflowDocument): string[] {
  return useMemo(() => {
    const labels = new Set<string>();
    for (const job of doc.jobs()) {
      const value = doc.get(['jobs', job.id, 'runs-on'])?.value;
      if (typeof value === 'string') labels.add(value);
    }
    for (const hosted of ['ubuntu-latest', 'windows-latest', 'macos-latest']) labels.add(hosted);
    return [...labels];
  }, [doc]);
}

function WorkflowProperties({ target, doc, locked }: PartProps) {
  return (
    <>
      <Heading kind="Workflow" name={doc.get(['name'])?.value} fallback={target.file} />
      <Fields specs={workflowFields(target.file)} target={target} doc={doc} locked={locked} />
      <YamlRows
        doc={doc}
        file={target.file}
        at={[]}
        keys={[
          ['env', 'Env'],
          ['permissions', 'Permissions'],
          ['concurrency', 'Concurrency'],
          ['defaults', 'Defaults'],
        ]}
      />
    </>
  );
}

function JobProperties({ target, doc, locked }: PartProps) {
  const job = target.job!;
  const outline = useSession(newestOutline);
  const uses = doc.get(['jobs', job, 'uses'])?.value;
  const call = typeof uses === 'string';
  const callee = call ? outline?.workflows.find((w) => w.path === localPath(uses))?.call : undefined;
  const secrets = doc.get(['jobs', job, 'secrets']);
  const at = ['jobs', job];
  return (
    <>
      <Heading kind="Job" name={doc.get([...at, 'name'])?.value} fallback={job} />
      <Fields specs={jobFields(target.file, job, call)} target={target} doc={doc} locked={locked} />
      <Needs doc={doc} file={target.file} job={job} locked={locked} />
      <MatrixEditor key={`${target.file}#${job}`} target={target} doc={doc} locked={locked} />
      {call ? (
        <>
          <KeyValueRows
            title="With"
            target={{ file: target.file }}
            doc={doc}
            path={[...at, 'with']}
            op={(name, value) => ({ op: 'setBinding', file: target.file, job, kind: 'with', name, value })}
            {...(callee ? { declared: { inputs: callee.inputs, by: uses } } : {})}
            locked={locked}
          />
          {secrets?.value !== 'inherit' && (
            <KeyValueRows
              title="Secrets"
              target={{ file: target.file }}
              doc={doc}
              path={[...at, 'secrets']}
              op={(name, value) => ({
                op: 'setBinding',
                file: target.file,
                job,
                kind: 'secrets',
                name,
                value,
              })}
              {...(callee
                ? {
                    declared: {
                      inputs: callee.secrets.map((name) => ({ name, required: false })),
                      by: uses,
                    },
                  }
                : {})}
              locked={locked}
            />
          )}
        </>
      ) : (
        <>
          <KeyValueRows
            title="Outputs"
            target={{ file: target.file }}
            doc={doc}
            path={[...at, 'outputs']}
            op={(name, value) => ({
              op: 'setOutput',
              file: target.file,
              job,
              name,
              value: value === null ? null : asText(value),
            })}
            locked={locked}
          />
          <KeyValueRows
            title="Env"
            target={{ file: target.file }}
            doc={doc}
            path={[...at, 'env']}
            op={(name, value) => ({ op: 'setBinding', file: target.file, job, kind: 'env', name, value })}
            locked={locked}
          />
          <PanelSteps doc={doc} file={target.file} job={job} locked={locked} />
        </>
      )}
      <YamlRows
        doc={doc}
        file={target.file}
        at={at}
        keys={[
          ['permissions', 'Permissions'],
          ['concurrency', 'Concurrency'],
          ['services', 'Services'],
          ['container', 'Container'],
          ['defaults', 'Defaults'],
          ...(secrets?.value === 'inherit' ? ([['secrets', 'Secrets']] as [string, string][]) : []),
        ]}
      />
    </>
  );
}

function StepProperties({ target, doc, locked }: PartProps) {
  const job = target.job!;
  const index = target.step!.index;
  const outline = useSession(newestOutline);
  const at = ['jobs', job, 'steps', index];
  const uses = doc.get([...at, 'uses'])?.value;
  const action = typeof uses === 'string';
  const local = action ? outline?.actions?.find((a) => a.dir === localPath(uses)) : undefined;
  // A remote action's inputs come from the bundled catalog, as of the ref it records.
  const remote = action && !local ? splitUses(uses) : undefined;
  const { catalog } = useCatalog(remote?.ref !== undefined);
  const known = remote?.ref === undefined ? undefined : catalogAction(catalog, remote.name);
  const id = doc.get([...at, 'id']);
  const session = { file: target.file, step: { job, index } };
  return (
    <>
      <Heading
        kind="Step"
        name={doc.get([...at, 'name'])?.value ?? (action ? uses : undefined)}
        fallback={`${job}, step ${index + 1}`}
      />
      {id && (
        <p className="text-xs">
          <span className="text-muted">Id </span>
          <code className="font-mono">{id.source}</code>
        </p>
      )}
      <Fields specs={stepFields(target.file, job, index, action)} target={target} doc={doc} locked={locked} />
      {action && (
        <KeyValueRows
          title="With"
          target={session}
          doc={doc}
          path={[...at, 'with']}
          op={(name, value, fp) => ({
            op: 'setBinding',
            file: target.file,
            job,
            step: { index, fp: fp ?? {} },
            kind: 'with',
            name,
            value,
          })}
          {...(local
            ? { declared: { inputs: local.inputs, by: local.name ?? uses } }
            : known
              ? { declared: { inputs: catalogInputs(known), by: `${known.uses}@${known.ref}` } }
              : {})}
          locked={locked}
        />
      )}
      <KeyValueRows
        title="Env"
        target={session}
        doc={doc}
        path={[...at, 'env']}
        op={(name, value, fp) => ({
          op: 'setBinding',
          file: target.file,
          job,
          step: { index, fp: fp ?? {} },
          kind: 'env',
          name,
          value,
        })}
        locked={locked}
      />
    </>
  );
}

/** A local reference as a repository path: `./.github/actions/setup/` → `.github/actions/setup`. */
const localPath = (uses: string): string => uses.replace(/^\.\//, '').replace(/\/+$/, '');

function Heading({ kind, name, fallback }: { kind: string; name: Json | undefined; fallback: string }) {
  return (
    <header className="flex flex-col gap-0.5">
      <p className="text-muted text-xs">{kind}</p>
      <h2 className="min-w-0 break-words font-medium text-sm">
        {typeof name === 'string' ? name : fallback}
      </h2>
    </header>
  );
}
