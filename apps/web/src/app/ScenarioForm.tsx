import { lazy, type ReactNode, type RefObject, Suspense, useEffect, useMemo, useRef } from 'react';
import {
  changedKeepKey,
  deriveForm,
  type GroupId,
  routeIssues,
  showsChanged,
  showsRef,
} from '../scenario/derive';
import { unlistedSentence } from '../lib/repo-words';
import { ActivityTypeField } from '../scenario/fields/ActivityType';
import { AdvancedFields } from '../scenario/fields/Advanced';
import { ChangedFilesField } from '../scenario/fields/ChangedFiles';
import { CronField } from '../scenario/fields/Cron';
import { DispatchFields } from '../scenario/fields/Dispatch';
import { EventField } from '../scenario/fields/Event';
import type { FieldContext, GroupProps } from '../scenario/fields/kit';
import { MessageField } from '../scenario/fields/Message';
import { PullRequestFields } from '../scenario/fields/PullRequest';
import { RefField } from '../scenario/fields/Ref';
import { ReleaseFields } from '../scenario/fields/Release';
import { WorkflowRunFields } from '../scenario/fields/WorkflowRun';
import {
  FOCUS_FRAMES,
  requestedField,
  resolveField,
  retryFrames,
  selectionFor,
  textOf,
} from '../scenario/focus';
import { useKept } from '../scenario/keep';
import type { FieldFocus, Issue } from '../state/store';
import type { Outline } from '../worker/protocol';
import { useApp, useSession } from './providers';

/**
 * The scenario, field by field: `deriveForm` says which groups the event shows and what the filters hint, and each
 * group writes one `ScenarioInputSchema` key per field through the store. The worker validates; its refusal shows
 * on the field it names, and what no field shows is summed up at the top. The page's error banner is what announces
 * a refusal, so neither copy here is a live region. A pin, or a reason's Set … button, asks for a field's focus.
 */

const GROUPS: Record<GroupId, (props: GroupProps) => ReactNode> = {
  event: EventField,
  activityType: ActivityTypeField,
  ref: RefField,
  pullRequest: PullRequestFields,
  release: ReleaseFields,
  cron: CronField,
  workflowRun: WorkflowRunFields,
  dispatch: DispatchFields,
  changedFiles: ChangedFilesField,
  message: MessageField,
  advanced: AdvancedFields,
};

/** The triggers editor, from the edit runtime's chunk (`edit-*`), fetched when edit mode first shows it. */
const TriggerRows = lazy(() => import('../edit/edit').then((m) => ({ default: m.TriggerRows })));

export function ScenarioForm() {
  const outline = useSession((s) => s.project.outline);
  const editing = useSession((s) => s.edit.on);
  // Why the source cannot say which files changed: a pull request past what GitHub lists (M4 synthesis § 5.8).
  const unlisted = useSession((s) => unlistedSentence(s.source));
  // The fields go with the project and come back with the next one, so what they keep in view (the Ref or the
  // changed files under the caret, Merged, the fork) is decided afresh for it, as on a first mount.
  if (!outline) return null;
  // In edit mode the triggers editor's rows pick the event (synthesis § 4.6), so the form drops its Event field.
  return editing ? (
    <>
      <Suspense fallback={<p className="text-muted text-xs">loading the editor…</p>}>
        <TriggerRows />
      </Suspense>
      <Fields outline={outline} unlisted={unlisted} without="event" />
    </>
  ) : (
    <Fields outline={outline} unlisted={unlisted} />
  );
}

function Fields({
  outline,
  unlisted,
  without,
}: {
  outline: Outline;
  unlisted: string | undefined;
  without?: GroupId;
}) {
  const scenario = useSession((s) => s.scenario);
  const from = useSession((s) => s.scenarioFrom);
  const assumed = useSession((s) => s.assumed);
  const focus = useSession((s) => s.focus);
  const issues = useSession((s) => (s.error?.kind === 'scenario' ? s.error.issues : undefined));
  const patch = useSession((s) => s.patchScenario);
  const setScenario = useSession((s) => s.setScenario);
  const request = useSession((s) => s.fieldFocus);
  const keepRef = useKept(scenario.event, showsRef(scenario), from === 'author');
  const keepChanged = useKept(changedKeepKey(scenario), showsChanged(scenario), from === 'author');
  const model = useMemo(
    () => deriveForm(outline, scenario, focus, { ref: keepRef, changed: keepChanged }),
    [outline, scenario, focus, keepRef, keepChanged],
  );
  const routed = useMemo(() => routeIssues(issues ?? [], model.fields), [issues, model]);
  const form = useRef<HTMLFormElement>(null);
  useFieldFocus(form, request, model.fields);

  const f: FieldContext = {
    scenario,
    model,
    from,
    assumed: (key) => assumed.includes(key),
    issue: (field) => routed.byField.get(field),
    requested: requestedField(request, model.fields),
    patch,
    setScenario: (next) => setScenario(next),
    unlisted,
  };
  return (
    <form
      ref={form}
      className="flex flex-col gap-3"
      onSubmit={(e) => e.preventDefault()}
      aria-label="Scenario"
    >
      {routed.summary.length > 0 && <Summary issues={routed.summary} />}
      {model.groups
        .filter((id) => id !== without)
        .map((id) => {
          const Group = GROUPS[id];
          return <Group key={id} f={f} />;
        })}
    </form>
  );
}

/**
 * Takes the store's focus request (`fieldFocus`): opens the scenario column when it is closed, then, once the field
 * shows (Advanced opens for a request for one of its rows and mounts them after), focuses the control with the
 * example selected so the author types over it. Each request is taken once, its field found or not, so the form never pulls the focus back.
 */
function useFieldFocus(
  form: RefObject<HTMLFormElement | null>,
  request: FieldFocus | undefined,
  fields: Map<string, string>,
): void {
  const { store } = useApp();
  const taken = useRef<number>(undefined);
  useEffect(() => {
    if (!request || request.seq === taken.current) return undefined;
    const take = (): void => {
      taken.current = request.seq;
      store.getState().fieldFocused(request.seq);
    };
    const field = resolveField(request, fields);
    if (field === undefined) {
      take();
      return undefined;
    }
    if (store.getState().ui.prefs.collapsed.left) store.getState().togglePane('left');
    return retryFrames(() => placeFocus(form.current, field, request.entry), take, FOCUS_FRAMES);
  }, [request, fields, store, form]);
}

/** Focuses the control that shows the field, its example selected; false while the field is not shown yet. */
function placeFocus(form: HTMLFormElement | null, field: string, entry: string | undefined): boolean {
  const controls = form ? Array.from(form.querySelectorAll<HTMLElement>('[data-field]')) : [];
  const control = controls.find((el) => el.dataset.field === field);
  if (!control || control.closest('[hidden]')) return false;
  control.focus({ preventScroll: true });
  if (control.ownerDocument.activeElement !== control) return false;
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    const range = selectionFor(field, entry, textOf(control));
    if (range) control.setSelectionRange(...range);
  }
  control.scrollIntoView({ block: 'nearest' });
  return true;
}

/** What the worker refused that no field shows: a key without a field, or the scenario as a whole. */
function Summary({ issues }: { issues: Issue[] }) {
  return (
    <div className="rounded border border-danger bg-danger-soft px-2 py-1.5 text-xs">
      <p className="font-medium">The scenario was refused</p>
      <ul className="mt-0.5 font-mono">
        {issues.map((i, n) => (
          <li key={n}>
            {i.path.length ? `${i.path.join('.')}: ` : ''}
            {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
