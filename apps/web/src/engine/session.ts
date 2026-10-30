import { loadGitHub } from '../github/load';
import { isProjectFile, isTestFile } from '../input/filter';
import { debounce, scheduler, type Timers } from '../lib/debounce';
import { hashFiles } from '../lib/hash';
import { markEdit } from '../lib/marks';
import { defaultBranchOf, defaultScenario, scenarioFor } from '../scenario/defaults';
import { remotePool, type SessionState, type SessionStore, type TestRun } from '../state/store';
import { type CaseFormat, type CaseOutcome, requestCase } from '../testcase/case';
import type { EngineClient, SimulateResult, TestResult } from '../worker/client';
import type { LoadedResponse, Outline, RefsResponse } from '../worker/protocol';
import { heldSentence, newlyBroken } from './hold';
import { createRemoteReads, type ReadRemotes } from './remotes';

/**
 * The store's one bridge to the engine: new files are loaded and simulated at once; a changed scenario, assume
 * entries or detail re-simulates after a short quiet; answers for an older request, project or files are dropped.
 * Edited texts load on the cadence of synthesis § 7.1: in the same tick for an op, an undo, a redo, a revert, a
 * restore or a disk take, so the edits of one tick send one load, and after a quiet for keys typed in the pane. Every
 * load is the whole project, so the worker never holds an edit the page does not. The first load of an epoch (a new
 * source) gives the scenario its defaults; a load of texts edited within the epoch keeps the scenario, the selection
 * and the plan on screen, which says it is stale until the next one comes. A load that breaks the YAML of a file that
 * parsed on the plan shown is held (§ 7.2): the plan stays, nothing simulates, and the next load without new YAML
 * errors releases it. In edit mode the focused workflow is planned even when nothing triggers it, so its jobs stay
 * on the canvas; edit mode or the focus moving re-simulates when that changes the plan. Each plan is labelled with
 * the files version it was simulated from, so a plan of older texts never passes for one of the texts on screen.
 * The engine reads busy while any request of the session is unanswered, and failed once the client gives up on it.
 * After each plan settles, the route tests run once per project and "As CI" setting (synthesis § 5.1), in the
 * background: busy does not count them, and a plan never waits for them. Each load carries the remotes read so far
 * and answers what the project still needs of them; once the author lets the page read them, they are read
 * (`engine/remotes.ts`) and the same texts load again with them, level by level (M4 synthesis § 5.3).
 */

export interface SessionOptions {
  store: SessionStore;
  client: EngineClient;
  timers?: Timers;
  /** Milliseconds of quiet after an input change before the simulate request goes out. */
  debounceMs?: number;
  /**
   * Milliseconds of quiet after a key typed in the YAML pane before the texts load. A project whose last edit took
   * the worker longer to load and simulate waits that long instead, so the worker is never more than one load behind.
   */
  typingMs?: number;
  /** Reads the remotes a load needs; by default from GitHub, through the `github-*` chunk. */
  readRemotes?: ReadRemotes;
}

/**
 * Why a load goes out: a new source, an edit of its texts, the same texts again after a stale reply, or with the
 * remotes read since (M4 synthesis § 5.3).
 */
type Cause = 'source' | 'edit' | 'reload' | 'remotes';

const fromGitHub: ReadRemotes = (needs, signal) => loadGitHub().then((m) => m.readRemotes(needs, { signal }));

/**
 * What a load sends: the project's files, which the engine loads, and the route tests apart, which the worker checks
 * (synthesis § 4.9) and runs with the snapshots, read-only, beside them (§ 5.1). `tests` and `readonly` are left out
 * when there are none.
 */
function loadBody(
  byPath: Record<string, string>,
  readonly: Record<string, string> | undefined,
): { files: Record<string, string>; tests?: Record<string, string>; readonly?: Record<string, string> } {
  const paths = Object.keys(byPath);
  const extra = readonly ? { readonly } : {};
  if (paths.every(isProjectFile)) return { files: byPath, ...extra };
  const pick = (keep: (path: string) => boolean): Record<string, string> =>
    Object.fromEntries(paths.filter(keep).map((p) => [p, byPath[p]!]));
  const tests = pick(isTestFile);
  const files = pick(isProjectFile);
  return Object.keys(tests).length ? { files, tests, ...extra } : { files, ...extra };
}

/** The loads that put the project out of sight until they answer: an edit's, or the remotes', leave it on screen. */
const SHOWS_LOADING: ReadonlySet<Cause> = new Set(['source', 'reload']);

/** The newest texts, and every remote read: a restarted worker replays the last load, and loses none of them. */
function loadRequest({ files, remotes }: SessionState): Parameters<EngineClient['load']>[0] {
  const pool = remotePool(remotes);
  return { ...loadBody(files.byPath, files.readonly), ...(pool ? { remotes: pool } : {}) };
}

/**
 * The project shown and the files version it was loaded from, when it may be simulated or tested: loaded, and not
 * held (while held, a changed scenario waits for valid YAML: the worker holds the broken texts, not the plan's).
 */
function shownProject(s: SessionState): { project: number; files: number } | undefined {
  const { status, held, version, files } = s.project;
  if (status !== 'ready' || held || version === undefined || files === undefined) return undefined;
  return { project: version, files };
}

/** Whether the project loaded holds route tests: the Outline lists them. */
const hasTests = (s: SessionState): boolean =>
  s.project.outline?.files.some((f) => f.kind === 'test') ?? false;

/** A short digest of what a test run reads: the texts and the snapshots, as the Tests tab's header names them. */
const digestOf = (files: SessionState['files']): string =>
  hashFiles({ ...files.byPath, ...files.readonly }).slice(0, 7);

const hasProjectFiles = (s: SessionState): boolean => Object.keys(s.files.byPath).some(isProjectFile);

/**
 * The texts changed within the epoch, or the snapshots beside them were read again (Reload): either loads, so the
 * worker holds what the plan and the tests are of.
 */
const textsMoved = (s: SessionState, prev: SessionState): boolean =>
  s.files.version !== prev.files.version || s.files.readonly !== prev.files.readonly;

/** The texts changed by keys typed in the pane, which load after a pause; anything else loads at once. */
const typedInPane = (s: SessionState, prev: SessionState): boolean =>
  s.files.version !== prev.files.version && s.edit.lastOrigin === 'pane';

/** Remotes were read (or found unreadable) since: the same texts load again with them, for the next level. */
const remotesRead = (s: SessionState, prev: SessionState): boolean =>
  s.remotes.byKey !== prev.remotes.byKey || s.remotes.failed !== prev.remotes.failed;

const inputsChanged = (s: SessionState, prev: SessionState): boolean =>
  s.scenario !== prev.scenario || s.assume !== prev.assume || s.detail !== prev.detail;

/**
 * The workflows the engine plans although nothing triggers them: in edit mode the focused one, so a filter edit that
 * stops it from running leaves its jobs on the canvas to edit (synthesis § 4.12).
 */
const untriggeredOf = (s: SessionState): string[] | undefined =>
  s.edit.on && s.focus ? [s.focus] : undefined;

/**
 * Edit mode or the focus moved the workflow planned untriggered, and the plan shown leaves that workflow, or the one
 * before it, untriggered: only then does a new plan differ, since the option leaves a triggered workflow as it is.
 */
function untriggeredMoved(s: SessionState, prev: SessionState): boolean {
  const now = untriggeredOf(s)?.[0];
  const before = untriggeredOf(prev)?.[0];
  if (now === before) return false;
  const untriggered = (path: string | undefined): boolean =>
    s.plan?.plan.workflows.some((w) => w.depth === 0 && w.path === path && w.triggered.verdict === 'no') ??
    false;
  return untriggered(now) || untriggered(before);
}

/** The project the worker holds is of the store's newest texts: its number, that files version and its revisions. */
export type Current =
  | { ok: true; project: number; files: number; revs: Readonly<Record<string, number>> }
  | { ok: false; message: string };

/** Where a job's or a step's id is written in the texts of `files`, as the worker found it in `project`. */
export type FoundRefs =
  | (Extract<Current, { ok: true }> & Pick<RefsResponse, 'refs' | 'exact' | 'notes'>)
  | { ok: false; message: string };

export interface Session {
  /** Simulates now, skipping the quiet period. */
  simulateNow(): void;
  /**
   * Resolves once the worker holds the store's newest texts (synthesis § 8.2): at once when the project shown is of
   * them, else when the load of them commits, sent now when a pause in typing still holds it back. Texts that do not
   * parse, a load that failed, a new source or an engine gone answer why instead.
   */
  current(): Promise<Current>;
  /** The references of a job or a step in the newest texts, for a rename (C11). */
  refs(target: RefsTarget): Promise<FoundRefs>;
  /**
   * The focused workflow's case, or the plan in another format, from the scenario and the assumptions the store
   * holds now: the worker simulates them again, a test case under the `given` of the test file it is for. Busy and
   * the plan are not touched; the dialog shows the answer.
   */
  testCase(format: CaseFormat, given?: unknown): Promise<CaseOutcome>;
  dispose(): void;
}

type RefsTarget = Parameters<EngineClient['refs']>[0]['target'];

/** Whether the project shown is of the newest texts, why it never will be, or undefined while a load may still come. */
function currentOf(s: SessionState, epoch: number, failed: number | undefined): Current | undefined {
  const { files, project } = s;
  if (files.epoch !== epoch) return { ok: false, message: 'Other files were opened.' };
  if (s.engine.status === 'failed') return { ok: false, message: 'The engine stopped.' };
  if (project.held?.files === files.version) return { ok: false, message: heldSentence(project.held) };
  if (failed === files.version) return { ok: false, message: 'The files could not be loaded.' };
  if (project.status !== 'ready' || project.files !== files.version || project.version === undefined)
    return undefined;
  return { ok: true, project: project.version, files: files.version, revs: files.revs };
}

export function createSession({
  store,
  client,
  timers,
  debounceMs = 100,
  typingMs = 150,
  readRemotes = fromGitHub,
}: SessionOptions): Session {
  const actions = store.getState();
  let request = 0;
  /** Requests of the session the client has not answered yet. */
  let unanswered = 0;
  /** The epoch last loaded: its files loaded again (a stale reply, an edit) keep the author's place. */
  let loaded: number | undefined;
  /** Milliseconds the worker spent loading and simulating the last edit: its own clock, no queue, no restart. */
  let lastCycle = 0;
  /** The Outline of the project last committed: what the hold compares a load with, whatever failed since. */
  let shown: Outline | undefined;
  /** The files version whose load the worker refused. */
  let failed: number | undefined;

  const busy = (delta: 1 | -1): void => {
    unanswered += delta;
    if (store.getState().engine.busy !== unanswered > 0) actions.engineBusy(unanswered > 0);
  };

  client.ready.then(
    (r) =>
      actions.engineReady({
        version: r.engine.version,
        models: r.models,
        ...(r.events ? { events: r.events } : {}),
      }),
    () => undefined, // the failure listener reports it
  );
  client.onFailure((message) =>
    actions.engineFailed({
      kind: store.getState().engine.status === 'booting' ? 'boot' : 'stopped',
      message,
    }),
  );
  client.onRestart((restarts, project) => {
    // The fresh worker holds the newest texts it was sent. That is the project shown only when the shown one is of the
    // store's texts and not held; otherwise the shown project went with the old worker, and nothing simulates until a
    // load of the newest texts commits (one is always on its way, or held).
    const s = store.getState();
    const current = s.project.files === s.files.version && !s.project.held;
    actions.engineRestarted(restarts, current ? project : null);
    actions.notify(restarts > 1 ? `the engine restarted again (${restarts})` : 'the engine restarted');
  });

  /**
   * The store's newest texts to the worker. The load counts as unanswered until the simulate it leads to is
   * answered, so busy does not blink between. The texts of an edit leave the project as it was, ready to simulate
   * until the new one replaces it: busy says it.
   */
  const load = async (cause: Cause): Promise<void> => {
    const { version, epoch } = store.getState().files;
    if (SHOWS_LOADING.has(cause)) actions.projectLoading();
    busy(1);
    try {
      const r = await client.load(loadRequest(store.getState()));
      if (store.getState().files.version !== version) return;
      if (r.type === 'loaded') {
        if (cause === 'edit') markEdit('edit:loaded', version);
        await commit(r, version, epoch);
        if (cause === 'edit') lastCycle = r.ms + planMs(version);
      } else if (r.type === 'error') {
        failed = version;
        actions.projectFailed({
          kind: r.kind === 'engine' ? 'engine' : 'source',
          message: r.message,
          ...(r.stack ? { stack: r.stack } : {}),
        });
      }
    } finally {
      busy(-1);
    }
  };

  /**
   * A loaded project on screen, and its plan, unless the hold keeps it off: a later load of the epoch, with a plan
   * shown, that broke the YAML of a file which parsed on it. Then nothing is simulated, so a restart that replays
   * these texts is held again and cannot loop.
   */
  const commit = async (r: LoadedResponse, version: number, epoch: number): Promise<void> => {
    const fresh = loaded !== epoch;
    const broken = fresh || !store.getState().plan ? [] : newlyBroken(shown, r.outline);
    if (broken.length) {
      // A simulate still out was for the project the worker no longer holds: its answer must not land.
      request++;
      actions.projectHeld({ files: version, outline: r.outline, broken });
      return;
    }
    actions.projectReady(r.project, r.outline, version);
    actions.setRemotesNeeded(r.remotesNeeded ?? []);
    shown = r.outline;
    loaded = epoch;
    // New files under the page's own scenario get the defaults for them, and a selection made in other files goes.
    if (fresh && store.getState().scenarioFrom === 'default') {
      const d = defaultScenario(r.outline, defaultBranchOf(store.getState().source));
      actions.setScenario(d.scenario, { assumed: d.assumed, from: 'default' });
      actions.select(d.focus, undefined);
      simulate.cancel();
    }
    await run();
  };

  const run = async (): Promise<void> => {
    const s = store.getState();
    const ready = shownProject(s);
    if (!ready) return;
    const { project, files } = ready;
    const id = ++request;
    const { epoch } = s.files;
    const { assume, scenario } = s;
    busy(1);
    const r = await client.simulate({
      project,
      scenario: scenarioFor(scenario, s.source),
      assume,
      detail: s.detail,
      planUntriggered: untriggeredOf(s),
    });
    busy(-1);
    if (id !== request) return;
    // The files the project was loaded from, not the store's newest: an edit since is not in this plan.
    await settle(r, { files, epoch, project, assume, scenario });
  };

  const settle = async (
    r: SimulateResult,
    asked: NonNullable<SessionState['plan']>['for'],
  ): Promise<void> => {
    const { files } = asked;
    const now = store.getState();
    if (r.type === 'superseded') return;
    if (r.type === 'plan') {
      if (r.project !== now.project.version || now.project.held) return;
      actions.planReceived({ plan: r.plan, derived: r.derived, text: r.text, ms: r.ms, for: asked });
      markEdit('edit:plan', files);
      void test();
      return;
    }
    if (r.type === 'invalid') {
      actions.rejected({
        kind: r.what,
        message: r.issues.map((i) => i.message).join('; '),
        issues: r.issues,
      });
      // The tests bring their own scenarios: an invalid one in the form does not keep them from running.
      void test();
      return;
    }
    if (r.kind === 'stale') {
      // The worker holds another project (it was restarted, or a reply crossed a load): load these files again.
      if (now.files.version === files) await load('reload');
      return;
    }
    actions.rejected({ kind: 'engine', message: r.message, ...(r.stack ? { stack: r.stack } : {}) });
  };

  /** The project and the setting the route tests last ran for: they run again only when one of them changes. */
  let tested: { project: number; ci: boolean } | undefined;

  /** The route tests of the project shown, unless they already ran for it as the switch says; in the background. */
  const test = async (): Promise<void> => {
    const s = store.getState();
    const ready = shownProject(s);
    if (!ready) return;
    if (!hasTests(s)) {
      tested = undefined;
      actions.testsCleared();
      return;
    }
    const { ci } = s.tests;
    if (tested?.project === ready.project && tested.ci === ci) return;
    tested = { project: ready.project, ci };
    const asked = { ...ready, ci, digest: digestOf(s.files) };
    actions.testsRunning();
    testsAnswered(await client.test({ project: ready.project, ci }), asked);
  };

  /** A test run's answer, unless a newer run took its place or another project is loaded: its own run follows its plan. */
  const testsAnswered = (r: TestResult, asked: TestRun['for']): void => {
    if (r.type === 'superseded' || tested?.project !== asked.project || tested.ci !== asked.ci) return;
    if (r.type === 'tested') {
      const { files, summary, exitCode, ms } = r;
      actions.testsReceived({ files, summary, exitCode, ms, for: asked });
    } else if (r.kind === 'stale') tested = undefined;
    else actions.testsFailed(r.message);
  };

  const simulate = debounce(() => void run(), debounceMs, timers);
  // An edit that removed every project file loads too: the worker must not keep simulating the files that went.
  const edits = scheduler(() => void load('edit'), timers);
  // Remotes read since the last load: the same texts again, at once; reads that land together load once.
  const withRemotes = scheduler(() => void load('remotes'), timers);
  const stopReads = createRemoteReads({ store, read: readRemotes, ...(timers ? { timers } : {}) });

  /** What the worker spent simulating the plan of `version`, once it is on screen. */
  const planMs = (version: number): number => {
    const { plan } = store.getState();
    return plan?.for.files === version ? plan.ms.simulate + plan.ms.derive : 0;
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.files.epoch !== prev.files.epoch) {
      // A new source: what was waiting belongs to the files that were there.
      edits.cancel();
      withRemotes.cancel();
      simulate.cancel();
      if (hasProjectFiles(s)) void load('source');
      return;
    }
    if (textsMoved(s, prev)) {
      edits.schedule(typedInPane(s, prev) ? Math.max(typingMs, lastCycle) : 0);
      return;
    }
    if (!shownProject(s)) return;
    if (inputsChanged(s, prev) || untriggeredMoved(s, prev)) simulate.call();
  });
  const unwatchRemotes = store.subscribe((s, prev) => {
    if (remotesRead(s, prev) && hasProjectFiles(s)) withRemotes.schedule(0);
  });
  // "As CI" runs the tests of the project shown again, as the switch now says.
  const unwatchCi = store.subscribe((s, prev) => {
    if (s.tests.ci !== prev.tests.ci) void test();
  });

  if (hasProjectFiles(store.getState())) void load('source');

  const current = (): Promise<Current> => {
    const { epoch } = store.getState().files;
    return new Promise((resolve) => {
      const answered = (s: SessionState): boolean => {
        const answer = currentOf(s, epoch, failed);
        if (answer) resolve(answer);
        return answer !== undefined;
      };
      if (answered(store.getState())) return;
      if (edits.pending()) {
        edits.cancel();
        void load('edit');
      }
      const stop = store.subscribe((s) => {
        if (answered(s)) stop();
      });
    });
  };

  return {
    simulateNow: () => {
      simulate.cancel();
      void run();
    },
    current,
    refs: async (target) => {
      const at = await current();
      if (!at.ok) return at;
      const r = await client.refs({ project: at.project, target });
      if (r.type === 'refs')
        return { ...at, project: r.project, refs: r.refs, exact: r.exact, notes: r.notes };
      return { ok: false, message: r.type === 'error' ? r.message : 'a newer request replaced it' };
    },
    testCase: (format, given) => requestCase(client, store.getState(), format, given),
    dispose: () => {
      unsubscribe();
      unwatchCi();
      unwatchRemotes();
      stopReads();
      simulate.cancel();
      edits.cancel();
      withRemotes.cancel();
    },
  };
}
