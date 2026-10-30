import type {
  AssumeEntry,
  NodeId,
  RemoteSourceInput,
  RunPlan,
  ScenarioInput,
  UnknownId,
} from '@simulci/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { regionEdit, type TextEdit, touched } from '@simulci/document/edits';
import type { PendingSel, Refused } from '../edit/types';
import type { GraphState, GraphUi } from '../graph/types';
import { isProjectFile } from '../input/filter';
import { fileLabel } from '../lib/file-label';
import { isTarget, type RepoTarget, targetText } from '../lib/repo-words';
import { classifyEol, type FileMeta, textMeta } from '../input/read';
import type { DiskConflict, DiskFile, FileOutcome } from '../input/save';
import { type ChangeRow, changeRows, changeSentence } from '../plan/change-rows';
import { diffOf, pinSentence, verdictChanges } from '../plan/changes';
import type {
  Derived,
  ModelInfo,
  Outline,
  ReadyResponse,
  RemoteNeed,
  RemotePool,
  RemotePoolFailure,
  TestedResponse,
} from '../worker/protocol';
import * as history from './history';
import { carried, changeRenames, inverse, type Renames, renamedBeside } from './renames';
import { DEFAULT_PREFS, type PanelTab, type Prefs } from './prefs';

/**
 * The one store of the page: plain data, nothing derived, nothing the engine owns. Panels read it through selectors;
 * only the session talks to the worker, only the router sync writes the URL, only persist.ts and prefs.ts touch
 * storage.
 */

export type Source =
  | { kind: 'none' }
  | { kind: 'sample'; name: string }
  /** Pasted files, or a sample once edited: its buffers follow every edit (`writtenThrough`); `name` says which sample. */
  | { kind: 'paste'; buffers: { path: string; text: string }[]; name?: string }
  | { kind: 'folder'; name: string; handle?: FileSystemDirectoryHandle; readAt: number }
  | GitHubSource;

/**
 * A public GitHub repository read at a commit (M4 synthesis § 5.5). Read-only to GitHub: its edits leave as a patch.
 * `ref` is what was asked for (a branch, a tag, a commit), `sha` the commit it was read at, `readAt` when.
 */
export interface GitHubSource {
  kind: 'github';
  /** The GitHub host the API serves: `github.com`. */
  host: string;
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  defaultBranch: string;
  /** As GitHub said when it was opened: only a repository seen public has its files cached or put in the URL. */
  private: boolean;
  readAt: number;
  /** The pull request it was opened for (WP). */
  pull?: number;
}

export interface Issue {
  path: (string | number)[];
  message: string;
}

export interface SessionError {
  /**
   * `boot`: the engine never started; `stopped`: it stopped and could not be restarted; `engine`: it threw;
   * `source`: files could not be read; the rest are the author's.
   */
  kind: 'boot' | 'stopped' | 'engine' | 'source' | 'scenario' | 'assume' | 'workflow';
  message: string;
  stack?: string;
  issues?: Issue[];
}

export interface PlanState {
  plan: RunPlan;
  derived: Derived;
  text: string;
  ms: { simulate: number; derive: number };
  /**
   * The files version the plan was simulated from, which may be older than the store's while an edit is answered,
   * the epoch of those files, the project version it answers, and the case layer it was simulated with: the plan
   * names the assume entries by position, so it speaks of the list it was given and of no other. The scenario is the
   * store's object it was simulated from, so a change can tell the plan that answers it.
   */
  for: { files: number; epoch: number; project: number; assume?: AssumeEntry[]; scenario?: ScenarioInput };
}

/**
 * The last change the author made to the plan and, once the plan that answers it came, what it changed (synthesis
 * § 7.4): the status line says it ("pinned; deploy now runs", "Edited ci.yml: CI is no longer triggered"), Details
 * lists it, the cards it changed flash and the cards it added get a ring. A pin is a scenario field or an assume entry
 * written from the Unknowns tab; an edit is any commit of the history that changed a project file. A change belongs
 * to the files it was made over: new files, or none, drop it.
 */
export interface Change {
  seq: number;
  cause: 'pin' | 'edit';
  /** What the author did, as the sentence opens: `pinned`, `Edited ci.yml`, `Undo Typed in ci.yml`, an op's label. */
  label: string;
  /**
   * The plan the change was made over, until the answering plan settled it: then only what it changed is kept. While
   * an edit is unanswered, the edits after it keep the plan from before the first one of the burst.
   */
  before?: Before;
  /**
   * What answers it: for an edit, the first plan of these files or newer ones; for a pin, the plan simulated from
   * exactly the inputs it left in the store, these very objects.
   */
  waitFor: { files?: number; scenario?: ScenarioInput; assume?: AssumeEntry[] };
  /** Old id prefixes and their new ids, for a rename (C11): the plan before's ids in the terms of the answer's. */
  renames?: Readonly<Record<NodeId, NodeId>>;
  /** Only keys typed in the pane: a burst whose plan changed nothing says nothing. */
  quiet?: true;
  /** What the answering plan changed; absent until it comes. */
  after?: ChangeAnswer;
}

/** The plan a change was made over, with the inputs and the files it was simulated from. */
export type Before = Pick<PlanState, 'plan' | 'derived' | 'for'>;

export interface ChangeAnswer {
  plan: RunPlan;
  /** Every node and check it added, removed or turned, in the order Details lists them. */
  rows: ChangeRow[];
  /** The status line's sentence; absent when a quiet change changed nothing. */
  sentence?: string;
}

/** A request to put the focus on an unknown's row in the Unknowns tab: "Show X in Unknowns" in a reason. */
export interface UnknownFocus {
  id: UnknownId;
  seq: number;
}

export interface Notice {
  id: number;
  text: string;
  /** The history entry the notice's Undo takes back, while it is the newest (a removal's toast, synthesis § 4.2). */
  undo?: history.Transaction;
}

/**
 * A request to put the focus in a scenario field: a pin wrote the field, or a reason's Set … button asked for it.
 * The form resolves `path` the way it routes the worker's issues (`deriveForm`'s `fields`: `vars`, `changed`,
 * `action`, `tag`, `workflow_run.branch`, `inputs.deploy`, `actor.login`; a `key.sub` it has no field for falls back
 * to `key`), focuses the control and selects the example so the author types over it. `seq` tells one request from
 * the next; the form acknowledges it with `fieldFocused(seq)`.
 */
export interface FieldFocus {
  path: string;
  /** The entry of a field written one entry per line whose value is selected: the variable's name for `vars`. */
  entry?: string;
  seq: number;
}

/** A request to show a line in the YAML pane: it opens the pane on the file's tab and scrolls the line into view. */
export interface Reveal {
  file: string;
  line: number;
  seq: number;
}

export interface SessionState {
  source: Source;
  files: {
    /** Moves with every change of the texts: a new source, or an edit within the epoch (`withTexts`). */
    version: number;
    /**
     * Moves with a new source only (`setFiles`, `forgetSource`, `awaitReopen`): the picture, the viewport, the
     * pane's states and the scenario's defaults belong to an epoch, so an edit keeps them.
     */
    epoch: number;
    /** The project files' texts, a BOM stripped. */
    byPath: Record<string, string>;
    /**
     * What reading each file in `byPath` found: its BOM, its line endings, whether it is valid UTF-8. A file an edit
     * removed keeps its entry, so undoing the removal brings back what reading found.
     */
    meta: Record<string, FileMeta>;
    /**
     * Per file, the files version that last changed its text. The version only grows, so a path and its rev name one
     * text for the page's life, across epochs too: what the pane keeps a file's state by.
     */
    revs: Record<string, number>;
    /** Per file, its text as read (a save will move it); a file created since has none. */
    base: Record<string, string>;
    /** Per file, its text when the epoch began. */
    opened: Record<string, string>;
    /**
     * Per file whose text was once read from bytes that are not UTF-8 within the epoch, those texts: whenever the
     * history brings one of them back, the file is not UTF-8 again, and whenever it leaves them, it is. Undoing a reload
     * or a "Keep the disk version" that changed a file's encoding gives back the encoding too. Whole texts, not hashes:
     * a text typed that only hashed alike would be taken for one read from other bytes.
     */
    lenient?: Record<string, string[]>;
    /**
     * The edits of the last commit of the history, per file, with each file's rev before it: a view that shows the
     * text of that rev maps the edits instead of comparing texts (`yaml/bridge.ts`).
     */
    /**
     * The route tests' snapshots by path (`*.snap.json`, `lib/snapshot-path.ts`), as the source held them: read-only,
     * so never in `byPath`, with no pane tab, never dirty and never saved. Every load sends them, for the Tests tab;
     * Reload reads them again (`setReadonly`). Absent when the source has none.
     */
    readonly?: Record<string, string>;
    edited?: {
      version: number;
      revs: Record<string, number>;
      edits: Record<string, readonly TextEdit[]>;
      /** Each file's line endings before the commit: the text the edits' offsets are in. */
      eols: Record<string, FileMeta['eol']>;
    };
  };
  project: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    version?: number;
    outline?: Outline;
    files?: number;
    /**
     * An edit broke the YAML of a file that parsed on the plan shown (synthesis § 7.2): the newest texts' Outline,
     * for the pane's problems and the status line, while the project, the plan and the picture stay those shown and
     * nothing is simulated until a load without new YAML errors commits.
     */
    held?: Held;
  };
  scenario: ScenarioInput;
  /** Who set the scenario: the page's defaults (replaced on the next load), the URL, or the author. */
  scenarioFrom: 'default' | 'url' | 'author';
  /** Scenario fields the page chose for the author; an edit clears its mark. */
  assumed: string[];
  assume: AssumeEntry[];
  detail: 'legs' | 'steps';
  engine: {
    status: 'booting' | 'ready' | 'failed';
    version?: string;
    models: ModelInfo[];
    /** Every event `on:` takes, with its activity types: the worker's `ready` sends them once (Add event). */
    events?: ReadyResponse['events'];
    restarts: number;
    busy: boolean;
  };
  plan?: PlanState;
  /**
   * What changed since `plan` was computed, if anything: the inputs (the scenario, the assume entries, the detail),
   * or the texts (`withTexts`). The later change names the cause.
   */
  stale: false | 'inputs' | 'edit';
  /**
   * What the screen says of a stale plan (`app/stale.ts`): `inputs`, the last good plan; `edit`, the plan of the newest
   * texts on its way. An edit says so only once its plan has been slow to come, so typing never flickers.
   */
  staleShown: false | 'inputs' | 'edit';
  error?: SessionError;
  /** The depth-0 workflow the defaults, the copy and the fit are about. */
  focus?: string;
  /**
   * The selection, as the URL's `sel` spells it: a unit path within `focus`. Absent, the focused workflow itself is
   * what the panels are about. A unit path survives a new plan; `plan/index.ts` resolves it to a node.
   */
  sel?: string;
  /** What the canvas shows: committed with its positions, so the previous picture stays until they exist. */
  graph?: GraphState;
  /** The field a pin or a reason asked the form to focus, until the form takes it. */
  fieldFocus?: FieldFocus;
  /** The Properties field the `i` key asked to focus (`if`), until Properties takes it. */
  propertyFocus?: { field: string; seq: number };
  /** The line the YAML pane was last asked to show. */
  reveal?: Reveal;
  /** Whether the Copy as test case dialog is open: the top bar's button and the `c` key open it. */
  caseOpen: boolean;
  /** Whether the Changes dialog is open: the top bar's Changes and Mod+Shift+D in edit mode open it. */
  changesOpen: boolean;
  /** The unknown whose "affects n" the pointer or the focus is on: the canvas dims every card it does not affect. */
  hoveredUnknown?: UnknownId;
  /** The unknown whose row the Unknowns tab was asked to focus, until the tab takes it. */
  unknownFocus?: UnknownFocus;
  change?: Change;
  ui: Omit<GraphUi, 'hideUntriggered' | 'only'> & {
    view: 'graph' | 'text';
    hideUntriggered: boolean;
    prefs: Prefs;
    /** The YAML pane's tab the author picked; absent, the pane follows the selection's file. */
    yamlFile?: string;
  };
  notices: Notice[];
  /** The edit history (`state/history.ts`), cleared by a new epoch only, and the restore waiting to be settled. */
  edit: EditState;
  /** A new source asked to replace files with unsaved edits; the replace prompt answers it (`app/replace.ts`). */
  replacing?: Replacing;
  /** A save to the folder under way, or the last one's report, until new files come (`app/saver.ts`). */
  saving?: Saving;
  /** Files the folder and the page both changed, for the author to settle before a save or a reload goes on. */
  settling?: Settling;
  /**
   * Core's generated marker of each file that has one, from the last Outline committed or held, kept through a load
   * that failed; absent until the epoch's first Outline, when no file is known not to be generated.
   */
  generated?: Record<string, string>;
  /** The Tests tab: the route tests run in the worker after each plan of new files (synthesis § 5.1). */
  tests: TestsState;
  /** The remote workflows and actions the files call, as the page read them (M4 synthesis § 5.3). */
  remotes: RemotesState;
  /**
   * A repository a link names (`gh=`) that is not the source: the page offers to open it and asks GitHub for nothing
   * until the author clicks (M4 synthesis § 5.5, failure mode 15). Opening it, or Dismiss, lets it go.
   */
  githubOffer?: RepoTarget;
}

/**
 * The remotes read from GitHub, beside the files and not among them: no pane tab, no dirty state, no save. A file at a
 * commit never changes, so what was read holds across edits and sources; the worker takes what the pins of the files
 * loaded ask for. Nothing is read before the author lets the page (`consent`): opening a GitHub repository, or Fetch.
 */
export interface RemotesState {
  /** What was read, by `remotePoolKey`. */
  byKey: Record<string, RemoteSourceInput>;
  /** What could not be read, by `remotePoolKey` (a failed resolve has no commit). */
  failed: Record<string, RemotePoolFailure>;
  /** What the project shown needs and nothing above holds: the next reads, or the chip's count. */
  needed: RemoteNeed[];
  /** `fetching` while a read is out; `done` once one came back. */
  status: 'idle' | 'fetching' | 'done';
  /** The author let the page read them from GitHub; it holds for the page's life. */
  consent: boolean;
}

/** A read's place in the pool: its ref as written and the commit it was read at, or asked for. */
export const remotePoolKey = (ref: string, sha: string | undefined): string => `${ref}\n${sha ?? ''}`;

/** What every load sends of the remotes (`LoadRequest.remotes`): nothing until the author lets the page read them. */
export const remotePool = ({ consent, byKey, failed }: RemotesState): RemotePool | undefined =>
  consent ? { sources: Object.values(byKey), failed: Object.values(failed) } : undefined;

/** What the Tests tab shows: the last run of the route tests, the one under way, and how they run. */
export interface TestsState {
  /** Run as `simulci test --ci` runs them (the "As CI" switch, on by default): no snapshot written, `only` refused. */
  ci: boolean;
  /** `idle`: nothing ran for these files (none hold tests, or none loaded yet). */
  status: 'idle' | 'running' | 'done' | 'failed';
  run?: TestRun;
  /** Why the last run failed: the engine's message. */
  error?: string;
}

/** A run of the route tests, with what it ran on: the project, its files version, CI or not, and a digest of them. */
export interface TestRun extends Pick<TestedResponse, 'files' | 'summary' | 'exitCode' | 'ms'> {
  for: { project: number; files: number; ci: boolean; digest: string };
}

/** A file of the crash snapshot that did not come back by itself (synthesis § 5.6): the author settles it. */
export interface RestoreConflict {
  path: string;
  /** The text the snapshot kept. */
  text: string;
  /** `changed`: the file's text is no longer the one the edits were made to; `gone`: it is not there; `exists`: a file the edits created is there now. */
  reason: 'changed' | 'gone' | 'exists';
}

export interface RestoreOffer {
  /** When the snapshot was taken. */
  at: number;
  conflicts: RestoreConflict[];
}

export interface EditState extends history.History {
  restore?: RestoreOffer;
  /**
   * Edit mode (`e`, the top bar's Edit switch, `edit=1`): the pane edits the files it may (`writable`). Turning it on
   * opens the pane.
   */
  on: boolean;
  /** Generated files the author chose to edit this session. */
  unlocked: string[];
  /** Where the selection goes once the plan of the texts an op or an undo left is in (§ 4.10). */
  pendingSel?: PendingSel;
  /** The last refused edit, for the status line and the gesture's callout, until an edit commits or it is dismissed. */
  refused?: Refused;
}

export interface Replacing {
  seq: number;
  /** What would replace the files, as the prompt names it: "the sample starter", "the folder repo". */
  what: string;
  /** The edited files it would drop; edited buffers a paste leaves standing are not among them. */
  paths: readonly string[];
}

/** A save under way, or what the last one did to each file (synthesis § 5.3); `open` while its dialog shows. */
export type Saving =
  | { status: 'running'; folder: string }
  | {
      status: 'done';
      folder: string;
      at: number;
      /** Write access was refused: nothing was written. */
      denied?: true;
      files: FileOutcome[];
      sentence: string;
      open: boolean;
    };

/** The conflicts of a save or a reload (§ 5.4, § 5.7), until the author chose for each or cancelled. */
export interface Settling {
  seq: number;
  /** `fetch`: a GitHub repository's Fetch again, a reload whose other side is GitHub. */
  mode: 'save' | 'reload' | 'fetch';
  folder: string;
  conflicts: DiskConflict[];
}

/** What an edit asked of the store came to: applied, or nothing changed (a refusal says why, if there was one). */
export type EditOutcome = { ok: true } | { ok: false; refusal?: history.Refusal };

/** A load the hold kept off the screen (§ 7.2): its files version, its Outline, and the lines that broke. */
export interface Held {
  files: number;
  outline: Outline;
  /** Per file that parsed on the plan shown and does not now, its first YAML error's line. */
  broken: { path: string; line: number }[];
}

export interface SessionActions {
  /** New files from a source; a file `meta` does not cover is a string no file was read for (a paste, a sample). */
  /** `base` gives the texts some files' edits were made to (`null`: created since), as stored buffers keep them. */
  setFiles: (
    byPath: Record<string, string>,
    source: Source,
    meta?: Record<string, FileMeta>,
    base?: BaseDiff,
    readonly?: Record<string, string>,
  ) => void;
  /** The snapshots of `epoch` read again (Reload): they replace the ones held, unless they are the same. */
  setReadonly: (epoch: number, readonly: Record<string, string>) => void;
  /** The "As CI" switch. */
  /** What the project of the newest files needs of the remotes, from its load. */
  setRemotesNeeded: (needed: RemoteNeed[]) => void;
  /** The author lets the page read remotes from GitHub, for the page's life. */
  consentRemotes: () => void;
  remotesFetching: () => void;
  /** Remotes read, or not; `done` when no other read is out. */
  remotesRead: (read: { sources: RemoteSourceInput[]; failed: RemotePoolFailure[] }, done: boolean) => void;
  setTestsCi: (ci: boolean) => void;
  testsRunning: () => void;
  testsReceived: (run: TestRun) => void;
  testsFailed: (message: string) => void;
  /** No route test is in the project loaded: nothing to show. */
  testsCleared: () => void;
  /**
   * A route test's case loaded into the scenario (the Tests tab's Load into scenario): its scenario and mocks, as `given`
   * and `when` merge them, replace the ones held, as a pin; the case's workflow is focused.
   */
  loadCase: (scenario: ScenarioInput, assume: AssumeEntry[], workflow: string) => void;
  forgetSource: () => void;
  /**
   * The source of `epoch` read again elsewhere, its files merged (a GitHub repository's Fetch again at a new commit):
   * the files, their epoch and the history stay, and the files it changed (`moved`) are opened anew at their new base,
   * so "since opened" compares with the commit the source names and its patch applies there. Nothing happens for
   * another epoch.
   */
  moveSource: (epoch: number, source: Source, moved: readonly string[]) => void;
  /** A source that has no files until the author acts: a stored folder waiting for Reopen. */
  awaitReopen: (source: Source) => void;
  /** The repository a link names, offered until it is opened or dismissed (`undefined`). */
  offerGitHub: (target: RepoTarget | undefined) => void;
  setScenario: (
    scenario: ScenarioInput,
    options?: { assumed?: string[]; from?: SessionState['scenarioFrom'] },
  ) => void;
  patchScenario: (patch: Partial<ScenarioInput>) => void;
  /**
   * Writes the scenario a pin built (`scenario/apply-pin.ts`): the keys it wrote join the assumed marks until the
   * author edits them, and the field that shows the pin asks for the focus.
   */
  pinScenario: (scenario: ScenarioInput, keys: string[], focus: Omit<FieldFocus, 'seq'>) => void;
  /** Asks the form to focus a field. */
  focusField: (focus: Omit<FieldFocus, 'seq'>) => void;
  /** The form took the request `seq`. */
  fieldFocused: (seq: number) => void;
  /** Opens the right panel on Properties (the Node tab in edit mode) and asks a field of it to take the focus. */
  focusProperty: (field: string) => void;
  /** Properties took the request `seq`. */
  propertyFocused: (seq: number) => void;
  setAssume: (assume: AssumeEntry[]) => void;
  /** Writes the assume list a pin built (the Unknowns tab's Assume and Pin… controls), as a pin. */
  pinAssume: (assume: AssumeEntry[]) => void;
  setDetail: (detail: 'legs' | 'steps') => void;
  setFocus: (focus: string | undefined) => void;
  /**
   * Selects a node by its depth-0 workflow and its unit path; no unit path selects the workflow itself. A new
   * selection takes the YAML pane back to its file; the selection already held changes nothing.
   */
  select: (focus: string | undefined, sel: string | undefined) => void;
  toggleExpanded: (job: string) => void;
  setRepresentative: (job: string, leg: string) => void;
  toggleOpened: (scope: string) => void;
  graphReady: (graph: GraphState) => void;
  setView: (view: 'graph' | 'text') => void;
  setHideUntriggered: (hide: boolean) => void;
  setPrefs: (patch: Partial<Prefs>) => void;
  setPanel: (panel: PanelTab) => void;
  /** Opens or closes a pane; the choice is a preference. */
  togglePane: (pane: keyof Prefs['collapsed']) => void;
  /** Opens the YAML pane on a file's tab and shows the line. */
  revealLine: (loc: { file: string; line: number }) => void;
  setYamlFile: (file: string | undefined) => void;
  openCase: () => void;
  closeCase: () => void;
  setChangesOpen: (open: boolean) => void;
  /** The pointer or the focus is on an unknown's "affects n", or left it (`undefined`). */
  hoverUnknown: (id: UnknownId | undefined) => void;
  /** Opens the right panel on the Unknowns tab and asks it to focus the unknown's row. */
  showUnknown: (id: UnknownId) => void;
  /** The Unknowns tab took the request `seq`. */
  unknownFocused: (seq: number) => void;
  /**
   * A transaction over one or more files: all or none, one undo entry. It keeps the plan, the picture, the selection
   * and the scenario: the plan is stale for the edit until the session brings the one of the new texts.
   */
  transact: (input: history.TxInput) => EditOutcome;
  /**
   * A commit of a Properties field: a transaction that joins the open group of the same `key` (the field's focus
   * session), so the session is one undo entry; it closes on blur (`closeGroup`) or at any other edit.
   */
  grouped: (key: string, input: history.TxInput) => EditOutcome;
  /** Text typed in the YAML pane, in the offsets of the file's text now; grouped into undo entries (§ 6). */
  typed: (path: string, edits: readonly TextEdit[], alone?: history.Alone) => EditOutcome;
  /** Closes the open typing group: the pane lost the focus or showed another file. */
  closeGroup: () => void;
  /** Undoes the last entry; false when there is none or the hash guard stopped it. */
  undo: () => boolean;
  redo: () => boolean;
  /** Keeps a refused edit for the status line, or clears it (`undefined`); returns its `seq`. */
  refused: (refused: Omit<Refused, 'seq'> | undefined) => number;
  /** Restore conflicts for the author to settle; the snapshot writer waits until none is left. */
  offerRestore: (offer: RestoreOffer) => void;
  /** Settles a restore conflict: the snapshot's text (`mine`, one undoable entry) or the file as it is (`disk`). */
  settleRestore: (path: string, keep: 'mine' | 'disk') => void;
  /** The replace prompt shows, or goes. */
  setReplacing: (replacing: Replacing | undefined) => void;
  /**
   * Files saved to the folder of `epoch`: each one's base becomes the text written (`null`: the folder has no such
   * file, as here), so it is no longer unsaved unless it changed since. The history and the texts stay; files of
   * another epoch are not these, and nothing moves.
   */
  saved: (epoch: number, texts: Readonly<Record<string, string | null>>) => void;
  /**
   * The folder's files, as a save's conflict or a reload read them, become the base of their paths (`null`: not in
   * the folder), with their BOM; the paths in `take` also take the folder's text, as one undoable `disk` transaction
   * (§ 5.4, § 5.7), planned over the texts `from` gives (`null`: no file), else over the texts now. Nothing happens for
   * files of another epoch, or when the transaction is refused: a text that moved since it was planned over.
   */
  fromDisk: (
    epoch: number,
    label: string,
    disk: Readonly<Record<string, DiskFile | null>>,
    take: readonly string[],
    from?: Readonly<Record<string, string | null>>,
  ) => EditOutcome;
  setSaving: (saving: Saving | undefined) => void;
  setSettling: (settling: Settling | undefined) => void;
  setEdit: (on: boolean) => void;
  /** The author chose to edit a generated file: "Edit anyway". */
  unlock: (path: string) => void;
  projectLoading: () => void;
  projectReady: (version: number, outline: Outline, files: number) => void;
  /** A load of edited texts broke YAML that parsed: the project shown stays (§ 7.2). */
  projectHeld: (held: Held) => void;
  projectFailed: (error: SessionError) => void;
  engineReady: (info: { version: string; models: ModelInfo[]; events?: ReadyResponse['events'] }) => void;
  engineFailed: (error: SessionError) => void;
  /**
   * The engine was restarted. `project` is the id the fresh worker gave the texts it loaded, adopted for the project
   * shown; `null` when those are not the shown project's texts, which the old worker took with it.
   */
  engineRestarted: (restarts: number, project: number | null | undefined) => void;
  engineBusy: (busy: boolean) => void;
  planReceived: (plan: PlanState) => void;
  rejected: (error: SessionError) => void;
  clearError: () => void;
  notify: (text: string, undo?: history.Transaction) => number;
  dismissNotice: (id: number) => void;
}

export type SessionStore = StoreApi<SessionState & SessionActions>;

const DEFAULT_SCENARIO: ScenarioInput = { event: 'push' };

const NO_FILES: SessionState['files'] = {
  version: 0,
  epoch: 0,
  byPath: {},
  meta: {},
  revs: {},
  base: {},
  opened: {},
};

export function initialSessionState(prefs: Prefs = DEFAULT_PREFS): SessionState {
  return {
    source: { kind: 'none' },
    files: NO_FILES,
    project: { status: 'idle' },
    scenario: DEFAULT_SCENARIO,
    scenarioFrom: 'default',
    assumed: [],
    assume: [],
    detail: 'steps',
    engine: { status: 'booting', models: [], restarts: 0, busy: false },
    stale: false,
    staleShown: false,
    caseOpen: false,
    changesOpen: false,
    ui: { view: 'graph', hideUntriggered: false, prefs, expanded: [], representative: {}, opened: [] },
    notices: [],
    edit: { ...history.emptyHistory(), on: false, unlocked: [] },
    tests: { ci: true, status: 'idle' },
    remotes: { byKey: {}, failed: {}, needed: [], status: 'idle', consent: false },
  };
}

/** The remotes of new files: what was read stays, what the old files needed goes. */
const unneeded = (remotes: RemotesState): RemotesState =>
  remotes.needed.length ? { ...remotes, needed: [] } : remotes;

/** The Tests tab of new files: nothing ran yet, the switch as the author left it. */
const untested = (tests: TestsState): TestsState => ({ ci: tests.ci, status: 'idle' });

/** Two sets of snapshots alike, path by path. */
function sameTexts(
  a: Readonly<Record<string, string>> = {},
  b: Readonly<Record<string, string>> = {},
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/**
 * The edit state of a new epoch: no history, no restore offer, nothing unlocked (another repository's file at the same
 * path is another file); entry ids go on, so none is ever reused.
 */
const freshEdit = (edit: EditState): EditState => ({
  ...history.emptyHistory(edit.next),
  on: edit.on,
  unlocked: [],
});

/** Where the last commit changed the files first: its file and the line of its first edit, in the new text. */
function revealPatch(s: SessionState): Partial<SessionState> | undefined {
  const edited = s.files.edited;
  if (!edited) return undefined;
  const path = Object.keys(edited.edits).find((p) => s.files.byPath[p] !== undefined);
  const splices = path === undefined ? undefined : edited.edits[path];
  if (path === undefined || !splices?.length) return undefined;
  const text = s.files.byPath[path]!;
  const at = Math.min(text.length, touched(splices)[0]!.from);
  const line = text.slice(0, at).split(/\r\n?|\n/).length;
  return { reveal: { file: path, line, seq: ++requestSeq }, ui: withYamlFile(s.ui, path) };
}

/** The edit state with its history gone and the rest (the mode, the unlocks, a restore offer) kept. */
const clearedHistory = (edit: EditState): EditState => ({
  ...edit,
  ...history.emptyHistory(edit.next),
  group: undefined,
  lastOrigin: undefined,
});

/** Each generated file's marker, by path. */
function markersOf(outline: Outline): Record<string, string> {
  const markers: Record<string, string> = {};
  for (const f of outline.files) if (f.generated !== undefined) markers[f.path] = f.generated;
  return markers;
}

const withoutConflict = (edit: EditState, path: string): EditState => {
  const conflicts = edit.restore?.conflicts.filter((c) => c.path !== path) ?? [];
  return {
    ...edit,
    restore: conflicts.length > 0 && edit.restore ? { ...edit.restore, conflicts } : undefined,
  };
};

/** The transaction that puts a conflicting file back to the snapshot's text: one region edit, or a creation. */
function restoreOf(s: SessionState, conflict: RestoreConflict): history.TxInput {
  const current = s.files.byPath[conflict.path];
  const name = conflict.path.slice(conflict.path.lastIndexOf('/') + 1);
  const file: history.TxFile =
    current === undefined
      ? { path: conflict.path, edits: [{ from: 0, to: 0, insert: conflict.text }], create: true }
      : {
          path: conflict.path,
          edits: [regionEdit(current, conflict.text)],
          expect: history.stampOf(current),
        };
  return { label: `Restored unsaved edits to ${name}`, origin: 'restore', files: [file] };
}

/** Per path whose text is not its base: the base, or `null` when it has none (a file created since). */
export type BaseDiff = Record<string, string | null>;

/** The files with each saved path's base moved to the text written, or gone where the folder has no file. */
function savedFiles(
  files: SessionState['files'],
  texts: Readonly<Record<string, string | null>>,
): SessionState['files'] {
  const base = { ...files.base };
  for (const [path, text] of Object.entries(texts))
    if (text === null) delete base[path];
    else base[path] = text;
  return { ...files, base };
}

/**
 * The transaction that gives each path of `take` the folder's text: a region edit, a creation or a removal, each over
 * the text it was planned over, so a text that moved since refuses it.
 */
function diskTx(
  byPath: Record<string, string>,
  label: string,
  disk: Readonly<Record<string, DiskFile | null>>,
  take: readonly string[],
  from: Readonly<Record<string, string | null>> = {},
): history.TxInput {
  const files: history.TxFile[] = [];
  for (const path of take) {
    const now = Object.hasOwn(from, path) ? (from[path] ?? undefined) : byPath[path];
    const then = disk[path]?.text;
    if (now === then) continue;
    if (then === undefined) files.push({ path, edits: [], remove: true, expect: history.stampOf(now!) });
    else if (now === undefined) files.push({ path, edits: [{ from: 0, to: 0, insert: then }], create: true });
    else files.push({ path, edits: [regionEdit(now, then)], expect: history.stampOf(now) });
  }
  return { label, origin: 'disk', files };
}

/**
 * The files with each path's base moved to the folder's text, or gone where the folder has none. A path that took
 * the folder's text takes what reading found too; one that keeps its own text takes only the folder's BOM, which a
 * save puts back, and keeps its encoding and line endings, which are its text's.
 */
function rebased(
  files: SessionState['files'],
  disk: Readonly<Record<string, DiskFile | null>>,
  take: ReadonlySet<string>,
  lenient: Readonly<Record<string, string[]>>,
): SessionState['files'] {
  const base = { ...files.base };
  const meta = { ...files.meta };
  for (const [path, d] of Object.entries(disk)) {
    if (d === null) {
      delete base[path];
      continue;
    }
    base[path] = d.text;
    const own = meta[path];
    meta[path] = take.has(path) || !own ? d.meta : { ...own, bom: d.meta.bom };
  }
  return { ...files, base, meta, ...withLenient(files.lenient, lenient) };
}

/**
 * The texts a disk take involves that were read from bytes that are not UTF-8: the text it replaces and the text it
 * takes, so an undo or a redo across it brings the encoding back with the text.
 */
function lenientOf(
  files: SessionState['files'],
  disk: Readonly<Record<string, DiskFile | null>>,
  take: readonly string[],
): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const path of take) {
    const texts: string[] = [];
    const now = files.byPath[path];
    if (now !== undefined && files.meta[path]?.utf8 === false) texts.push(now);
    const d = disk[path];
    if (d && !d.meta.utf8) texts.push(d.text);
    if (texts.length > 0) found[path] = texts;
  }
  return found;
}

const withLenient = (
  known: Readonly<Record<string, string[]>> | undefined,
  more: Readonly<Record<string, string[]>>,
): Pick<SessionState['files'], 'lenient'> => {
  if (Object.keys(more).length === 0) return known ? { lenient: known } : {};
  const lenient = { ...known };
  for (const [path, texts] of Object.entries(more)) lenient[path] = [...(lenient[path] ?? []), ...texts];
  return { lenient };
};

/**
 * The files whose text is not what was read or last saved: edited, created since, or removed since. A selector, never
 * stored: undoing back to the base leaves nothing unsaved.
 */
export function dirtyPaths(files: Pick<SessionState['files'], 'byPath' | 'base'>): string[] {
  const dirty = Object.keys(files.byPath).filter((path) => files.byPath[path] !== files.base[path]);
  for (const path of Object.keys(files.base)) if (!Object.hasOwn(files.byPath, path)) dirty.push(path);
  return dirty;
}

let noticeId = 0;
let requestSeq = 0;
/** Changes count apart from the change the store holds, which new files drop (`pinOver`, `editOver`). */
let changeSeq = 0;

/**
 * What belongs to the files that were there: the change made over their plan, and the unknown hovered or asked for,
 * which the next files' plan may not have. New files, or none, clear it all, so no plan of theirs settles that change.
 */
const UNCHANGED = { change: undefined, hoveredUnknown: undefined, unknownFocus: undefined } as const;

/** What a new source starts from: nothing loaded, simulated or drawn, and nothing pinned over the files before. */
const UNLOADED = {
  project: { status: 'idle' },
  plan: undefined,
  graph: undefined,
  generated: undefined,
  stale: false,
  saving: undefined,
  ...UNCHANGED,
} as const;

export function createSessionStore(initial: SessionState = initialSessionState()): SessionStore {
  return createStore<SessionState & SessionActions>((set, get) => {
    /**
     * Commits a step of the history in one `set()` with the texts it changes (`committed`), and the change it leaves
     * for the status line, said as `said` words it from the state before the step; an op's `after` is the selection
     * it leaves waiting for its plan.
     */
    const commit = (
      step: (s: SessionState) => StepOutcome,
      said: (s: SessionState) => Said,
      verb?: 'undo' | 'redo',
      after?: history.SelectionRef,
      /** What else the same `set()` changes, unless the step was refused. */
      also?: (files: SessionState['files']) => SessionState['files'],
    ): EditOutcome => {
      let outcome: EditOutcome = { ok: false };
      set((s) => {
        const result = committed(s, step(s), said(s), verb && { verb, id: ++noticeId }, after);
        outcome = result.outcome;
        if (!also || ('refusal' in result.outcome && result.outcome.refusal)) return result.patch;
        const files = also(result.patch.files ?? s.files);
        return result.patch === s ? { files } : { ...result.patch, files };
      });
      return outcome;
    };
    /**
     * After an undo or a redo, the pane shows the file and the line it changed (§ 6), without being opened for it, and
     * the selection goes back to where the entry was made (or to where a redone op left it) once its plan is in.
     */
    const revealed = (outcome: EditOutcome, verb: 'undo' | 'redo'): boolean => {
      if (outcome.ok)
        set((s) => {
          const patch = { ...revealPatch(s), ...restoredSelection(s, verb) };
          return Object.keys(patch).length > 0 ? patch : s;
        });
      return outcome.ok;
    };
    return {
      ...initial,
      setFiles: (byPath, source, meta, base, readonly) =>
        set((s) => ({
          source,
          // The repository a link offered is open now.
          githubOffer: s.githubOffer && isTarget(source, s.githubOffer) ? undefined : s.githubOffer,
          files: withReadonly(sourceFiles(s.files, byPath, metaOf(byPath, meta), base), readonly),
          ...UNLOADED,
          tests: untested(s.tests),
          remotes: unneeded(s.remotes),
          edit: freshEdit(s.edit),
          error: s.error?.kind === 'source' ? undefined : s.error,
        })),
      forgetSource: () =>
        set((s) => ({
          source: { kind: 'none' },
          files: sourceFiles(s.files, {}, {}),
          ...UNLOADED,
          tests: untested(s.tests),
          remotes: unneeded(s.remotes),
          edit: freshEdit(s.edit),
          focus: undefined,
          sel: undefined,
          error: replaceError(s.error, undefined),
        })),
      offerGitHub: (target) =>
        set((s) =>
          target === s.githubOffer ||
          (target && s.githubOffer && targetText(target) === targetText(s.githubOffer))
            ? s
            : { githubOffer: target },
        ),
      moveSource: (epoch, source, moved) =>
        set((s) => (s.files.epoch === epoch ? { source, files: reopened(s.files, moved) } : s)),
      // A new epoch, so the session takes it for a source with no files, not for an edit that emptied them.
      awaitReopen: (source) => get().setFiles({}, source),
      setReadonly: (epoch, readonly) =>
        set((s) =>
          s.files.epoch !== epoch || sameTexts(s.files.readonly, readonly)
            ? s
            : { files: withReadonly(s.files, readonly) },
        ),
      setRemotesNeeded: (needed) =>
        set((s) =>
          needed.length === 0 && s.remotes.needed.length === 0 ? s : { remotes: { ...s.remotes, needed } },
        ),
      consentRemotes: () =>
        set((s) => (s.remotes.consent ? s : { remotes: { ...s.remotes, consent: true } })),
      remotesFetching: () =>
        set((s) => (s.remotes.status === 'fetching' ? s : { remotes: { ...s.remotes, status: 'fetching' } })),
      remotesRead: (read, done) =>
        set((s) => {
          const byKey = { ...s.remotes.byKey };
          const failed = { ...s.remotes.failed };
          for (const source of read.sources) {
            const key = remotePoolKey(source.ref, source.sha);
            byKey[key] = source;
            delete failed[key];
            if (source.pinned === 'resolved') delete failed[remotePoolKey(source.ref, undefined)];
          }
          for (const f of read.failed) failed[remotePoolKey(f.ref, f.sha)] = f;
          const status = done ? 'done' : s.remotes.status;
          return { remotes: { ...s.remotes, byKey, failed, status } };
        }),
      setTestsCi: (ci) => set((s) => (s.tests.ci === ci ? s : { tests: { ...s.tests, ci } })),
      testsRunning: () => set((s) => ({ tests: { ...s.tests, status: 'running', error: undefined } })),
      testsReceived: (run) => set((s) => ({ tests: { ci: s.tests.ci, status: 'done', run } })),
      testsFailed: (error) => set((s) => ({ tests: { ...s.tests, status: 'failed', error } })),
      testsCleared: () =>
        set((s) => (s.tests.status === 'idle' && !s.tests.run ? s : { tests: untested(s.tests) })),
      loadCase: (scenario, assume, workflow) =>
        set((s) => ({
          scenario,
          scenarioFrom: 'author',
          assumed: [],
          assume,
          focus: workflow,
          sel: undefined,
          stale: inputsStale(s),
          error: authorsErrorCleared(authorsErrorCleared(s.error, 'scenario'), 'assume'),
          change: pinOver(s, scenario, assume),
        })),
      setScenario: (scenario, options) =>
        set((s) => ({
          scenario,
          scenarioFrom: options?.from ?? 'author',
          assumed: options?.assumed ?? [],
          stale: inputsStale(s),
          error: authorsErrorCleared(s.error, 'scenario'),
        })),
      patchScenario: (patch) =>
        set((s) => ({
          scenario: withPatch(s.scenario, patch),
          scenarioFrom: 'author',
          assumed: s.assumed.filter((k) => !edits(k, s.scenario, patch)),
          stale: inputsStale(s),
          error: authorsErrorCleared(s.error, 'scenario'),
        })),
      pinScenario: (scenario, keys, focus) =>
        set((s) => ({
          scenario,
          scenarioFrom: 'author',
          assumed: Array.from(new Set([...s.assumed, ...keys])),
          stale: inputsStale(s),
          error: authorsErrorCleared(s.error, 'scenario'),
          fieldFocus: { ...focus, seq: ++requestSeq },
          change: pinOver(s, scenario, s.assume),
        })),
      focusField: (focus) => set({ fieldFocus: { ...focus, seq: ++requestSeq } }),
      fieldFocused: (seq) => set((s) => (s.fieldFocus?.seq === seq ? { fieldFocus: undefined } : {})),
      focusProperty: (field) =>
        set((s) => ({
          propertyFocus: { field, seq: ++requestSeq },
          ui: {
            ...s.ui,
            prefs: { ...s.ui.prefs, panel: 'node', collapsed: { ...s.ui.prefs.collapsed, right: false } },
          },
        })),
      propertyFocused: (seq) => set((s) => (s.propertyFocus?.seq === seq ? { propertyFocus: undefined } : s)),
      setAssume: (assume) =>
        set((s) => ({ assume, stale: inputsStale(s), error: authorsErrorCleared(s.error, 'assume') })),
      pinAssume: (assume) =>
        set((s) => ({
          assume,
          stale: inputsStale(s),
          error: authorsErrorCleared(s.error, 'assume'),
          change: pinOver(s, s.scenario, assume),
        })),
      setDetail: (detail) => set((s) => ({ detail, stale: inputsStale(s) })),
      setFocus: (focus) => set({ focus }),
      // Returning `s` skips the update: a held selection keeps the tab the author picked. The author's own choice,
      // the selection already shown included, wins over the one an edit left waiting for its plan.
      select: (focus, sel) =>
        set((s) =>
          s.focus === focus && s.sel === sel
            ? s.edit.pendingSel
              ? { edit: { ...s.edit, pendingSel: undefined } }
              : s
            : {
                focus,
                sel,
                ui: withYamlFile(s.ui, undefined),
                ...(s.edit.pendingSel ? { edit: { ...s.edit, pendingSel: undefined } } : {}),
              },
        ),
      toggleExpanded: (job) => set((s) => ({ ui: { ...s.ui, expanded: toggled(s.ui.expanded, job) } })),
      setRepresentative: (job, leg) =>
        set((s) => ({ ui: { ...s.ui, representative: { ...s.ui.representative, [job]: leg } } })),
      toggleOpened: (scope) => set((s) => ({ ui: { ...s.ui, opened: toggled(s.ui.opened, scope) } })),
      graphReady: (graph) => set({ graph }),
      setView: (view) => set((s) => ({ ui: { ...s.ui, view } })),
      setHideUntriggered: (hideUntriggered) => set((s) => ({ ui: { ...s.ui, hideUntriggered } })),
      setPrefs: (patch) => set((s) => ({ ui: { ...s.ui, prefs: { ...s.ui.prefs, ...patch } } })),
      setPanel: (panel) => get().setPrefs({ panel }),
      togglePane: (pane) => {
        const { collapsed } = get().ui.prefs;
        get().setPrefs({ collapsed: { ...collapsed, [pane]: !collapsed[pane] } });
      },
      revealLine: ({ file, line }) =>
        set((s) => ({
          reveal: { file, line, seq: ++requestSeq },
          ui: {
            ...s.ui,
            yamlFile: file,
            prefs: { ...s.ui.prefs, collapsed: { ...s.ui.prefs.collapsed, yaml: false } },
          },
        })),
      setYamlFile: (yamlFile) => set((s) => ({ ui: withYamlFile(s.ui, yamlFile) })),
      openCase: () => set({ caseOpen: true }),
      closeCase: () => set({ caseOpen: false }),
      setChangesOpen: (changesOpen) => set({ changesOpen }),
      hoverUnknown: (hoveredUnknown) =>
        set((s) => (s.hoveredUnknown === hoveredUnknown ? s : { hoveredUnknown })),
      showUnknown: (id) =>
        set((s) => ({
          unknownFocus: { id, seq: ++requestSeq },
          ui: {
            ...s.ui,
            prefs: { ...s.ui.prefs, panel: 'unknowns', collapsed: { ...s.ui.prefs.collapsed, right: false } },
          },
        })),
      unknownFocused: (seq) => set((s) => (s.unknownFocus?.seq === seq ? { unknownFocus: undefined } : {})),
      transact: (input) => {
        // The step and what it says read one state: the input as it commits is worked out once for it.
        let memo: { s: SessionState; input: history.TxInput } | undefined;
        const tx = (s: SessionState): history.TxInput =>
          memo?.s === s ? memo.input : (memo = { s, input: carried(s, input) }).input;
        return commit(
          (s) => history.transact(s.edit, s.files.byPath, tx(s), contextOf(s)),
          (s) => {
            const { renames } = tx(s);
            return { label: input.label, ...(renames ? { renames } : {}) };
          },
          undefined,
          input.selectionAfter,
        );
      },
      grouped: (key, input) =>
        commit(
          (s) => history.grouped(s.edit, s.files.byPath, key, input, contextOf(s)),
          () => ({ label: input.label }),
          undefined,
          input.selectionAfter,
        ),
      typed: (path, splices, alone) =>
        commit(
          (s) => history.typed(s.edit, s.files.byPath, path, splices, contextOf(s), alone),
          () => ({ label: `Edited ${fileLabel(path)}`, quiet: true }),
        ),
      closeGroup: () => set((s) => (s.edit.group ? { edit: { ...s.edit, ...history.close(s.edit) } } : s)),
      offerRestore: (restore) => set((s) => ({ edit: { ...s.edit, restore } })),
      settleRestore: (path, keep) => {
        const conflict = get().edit.restore?.conflicts.find((c) => c.path === path);
        if (!conflict) return;
        if (keep === 'mine') {
          const input = restoreOf(get(), conflict);
          commit(
            (s) => history.transact(s.edit, s.files.byPath, input, contextOf(s)),
            () => ({ label: input.label }),
          );
        }
        set((s) => ({ edit: withoutConflict(s.edit, path) }));
      },
      setReplacing: (replacing) => set({ replacing }),
      saved: (epoch, texts) =>
        set((s) => (s.files.epoch === epoch ? { files: savedFiles(s.files, texts) } : s)),
      fromDisk: (epoch, label, disk, take, from) => {
        const s = get();
        if (s.files.epoch !== epoch) return { ok: false };
        const input = diskTx(s.files.byPath, label, disk, take, from);
        const lenient = lenientOf(s.files, disk, take);
        return commit(
          (now) => history.transact(now.edit, now.files.byPath, input, contextOf(now)),
          () => ({ label }),
          undefined,
          undefined,
          (files) => rebased(files, disk, new Set(take), lenient),
        );
      },
      setSaving: (saving) => set({ saving }),
      setSettling: (settling) => set({ settling }),
      setEdit: (on) =>
        set((s) =>
          s.edit.on === on
            ? s
            : {
                edit: {
                  ...history.close(s.edit),
                  restore: s.edit.restore,
                  on,
                  unlocked: s.edit.unlocked,
                  refused: on ? s.edit.refused : undefined,
                },
                // Entering edit mode opens the YAML pane, where the text is typed and every refusal's fallback is;
                // the author may close it again.
                ...(on && s.ui.prefs.collapsed.yaml
                  ? {
                      ui: {
                        ...s.ui,
                        prefs: { ...s.ui.prefs, collapsed: { ...s.ui.prefs.collapsed, yaml: false } },
                      },
                    }
                  : {}),
              },
        ),
      unlock: (path) =>
        set((s) =>
          s.edit.unlocked.includes(path) ? s : { edit: { ...s.edit, unlocked: [...s.edit.unlocked, path] } },
        ),
      undo: () =>
        revealed(
          commit(
            (s) => history.undo(s.edit, s.files.byPath),
            (s) => ({ label: `Undo ${history.undoLabel(s.edit)}`, ...stepRenames(s, 'undo') }),
            'undo',
          ),
          'undo',
        ),
      redo: () =>
        revealed(
          commit(
            (s) => history.redo(s.edit, s.files.byPath),
            (s) => ({ label: `Redo ${history.redoLabel(s.edit)}`, ...stepRenames(s, 'redo') }),
            'redo',
          ),
          'redo',
        ),
      refused: (refused) => {
        if (!refused) {
          set((s) => (s.edit.refused ? { edit: { ...s.edit, refused: undefined } } : s));
          return 0;
        }
        const seq = ++requestSeq;
        set((s) => ({ edit: { ...s.edit, refused: { ...refused, seq } } }));
        return seq;
      },
      projectLoading: () => set((s) => ({ project: { ...s.project, status: 'loading' } })),
      // A new project of the newest texts: whatever was held is released.
      projectReady: (version, outline, files) =>
        set((s) => ({
          project: { status: 'ready', version, outline, files },
          generated: markersOf(outline),
          error: replaceError(s.error, undefined),
        })),
      projectHeld: (held) =>
        set((s) => ({ project: { ...s.project, held }, generated: markersOf(held.outline) })),
      projectFailed: (error) =>
        set((s) => ({ project: { status: 'error' }, error: replaceError(s.error, error) })),
      engineReady: ({ version, models, events }) =>
        set((s) => ({
          engine: { ...s.engine, status: 'ready', version, models, ...(events ? { events } : {}) },
        })),
      engineFailed: (error) =>
        set((s) => ({ engine: { ...s.engine, status: 'failed', busy: false }, error })),
      engineRestarted: (restarts, project) =>
        set((s) => ({
          engine: { ...s.engine, restarts },
          project: project === undefined ? s.project : { ...s.project, version: project ?? undefined },
        })),
      engineBusy: (busy) => set((s) => ({ engine: { ...s.engine, busy } })),
      planReceived: (plan) =>
        set((s) => ({
          plan,
          // A plan of older texts (an input changed while an edit was loading) is still behind the edit.
          stale: plan.for.files < s.files.version ? 'edit' : false,
          error: replaceError(s.error, undefined),
          change: answered(s.change, plan),
          ...pendingSelection(s, plan),
        })),
      rejected: (error) => set((s) => ({ error: replaceError(s.error, error) })),
      clearError: () => set((s) => ({ error: replaceError(s.error, undefined) })),
      notify: (text, undo) => {
        const id = ++noticeId;
        set((s) => ({ notices: [...s.notices, undo ? { id, text, undo } : { id, text }] }));
        return id;
      },
      dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
    };
  });
}

type StepOutcome = history.Step | history.Refusal | undefined;

/** How an undo or a redo the hash guard stopped starts its notice. */
const STOPPED = { undo: 'Undo', redo: 'Redo' } as const;

/**
 * What a step of the history does to the store: its texts and its history in one patch, the source's buffers with
 * them. A refused step changes nothing, but an undo or a redo the hash guard stopped clears the history and says so:
 * none of its entries can be trusted any more.
 */
function committed(
  s: SessionState,
  outcome: StepOutcome,
  said: Said,
  stopped?: { verb: 'undo' | 'redo'; id: number },
  after?: history.SelectionRef,
): { patch: Partial<SessionState>; outcome: EditOutcome } {
  if (outcome === undefined) return { patch: s, outcome: { ok: false } };
  if ('refused' in outcome) {
    if (outcome.refused !== 'desync' || !stopped)
      return { patch: s, outcome: { ok: false, refusal: outcome } };
    const text = `${STOPPED[stopped.verb]} stopped: ${fileLabel(outcome.path)} changed outside the history`;
    return {
      patch: { edit: clearedHistory(s.edit), notices: [...s.notices, { id: stopped.id, text }] },
      outcome: { ok: false, refusal: outcome },
    };
  }
  const texts = withTexts(s, outcome.changes);
  // Nothing moved: no update, so no listener runs.
  if (!texts.files && outcome.history === s.edit) return { patch: s, outcome: { ok: false } };
  const patch: Partial<SessionState> = { ...texts, edit: { ...s.edit, ...outcome.history } };
  if (texts.files)
    texts.files.edited = {
      version: texts.files.version,
      revs: s.files.revs,
      edits: outcome.edits,
      eols: Object.fromEntries(Object.keys(outcome.edits).map((p) => [p, s.files.meta[p]?.eol ?? 'none'])),
    };
  if (!texts.files) return { patch, outcome: { ok: false } };
  // An edit that commits answers the last refusal; an op leaves the selection waiting for its plan.
  const edit = { ...patch.edit!, refused: undefined, ...pending(s, after, texts.files.version) };
  return { patch: { ...patch, edit, ...besideTexts(s, outcome, texts.files, said) }, outcome: { ok: true } };
}

/**
 * What a commit that changed the texts leaves besides them: the source's buffers that follow them, and the change it
 * opens or goes on with. Only a project file's text is in the plan, so an edit of a test file (C10) says nothing.
 */
function besideTexts(
  s: SessionState,
  step: history.Step,
  files: SessionState['files'],
  said: Said,
): Partial<SessionState> {
  const source = writtenThrough(s.source, step.changes, files.byPath);
  if (!Object.keys(step.changes).some(isProjectFile)) return { source };
  const change = editOver(s, files.version, said);
  return said.renames
    ? { source, ...renamedBeside(s, newestOutline(s), said.renames, change) }
    : { source, change };
}

/**
 * The renames an undo takes back or a redo makes again. An undo undoes the newest entry once open typing is closed
 * into one, which carries none; typing that changed nothing closes into none, and the entry under it is undone.
 */
function stepRenames(s: SessionState, verb: 'undo' | 'redo'): { renames?: Renames } {
  const tx = verb === 'undo' ? history.close(s.edit).past.at(-1) : s.edit.future.at(-1);
  if (!tx?.renames) return {};
  return { renames: verb === 'undo' ? inverse(tx.renames) : tx.renames };
}

/**
 * The selection to apply once the plan of `files` is in. One already shown needs no plan, and drops a selection an
 * earlier edit left waiting: the newest edit says where the author is. No selection keeps the one waiting.
 */
function pending(
  s: Pick<SessionState, 'focus' | 'sel' | 'edit'>,
  to: history.SelectionRef | undefined,
  files: number,
): { pendingSel?: PendingSel } {
  if (!to) return {};
  if (to.focus === s.focus && to.sel === s.sel) return s.edit.pendingSel ? { pendingSel: undefined } : {};
  return { pendingSel: { ...to, files } };
}

/** An undone entry's selection from before it, a redone one's from after it, for the plan of the texts now. */
function restoredSelection(s: SessionState, verb: 'undo' | 'redo'): Partial<SessionState> {
  const tx = verb === 'undo' ? s.edit.future.at(-1) : s.edit.past.at(-1);
  const to = verb === 'undo' ? tx?.selection.before : tx?.selection.after;
  const next = pending(s, to, s.files.version);
  return 'pendingSel' in next ? { edit: { ...s.edit, ...next } } : {};
}

/**
 * The selection an edit left waiting, applied by the first plan of its texts or newer ones: an older plan would
 * resolve its unit path against the old text, and so perhaps to another node (§ 4.10).
 */
function pendingSelection(s: SessionState, plan: PlanState): Partial<SessionState> {
  const waiting = s.edit.pendingSel;
  if (!waiting || plan.for.epoch !== s.files.epoch || plan.for.files < waiting.files) return {};
  return { focus: waiting.focus, sel: waiting.sel, edit: { ...s.edit, pendingSel: undefined } };
}

/**
 * The source after an edit (synthesis § 5.5). Pasted buffers follow their files' texts, so pasting another file,
 * removing one or reloading the page keeps the edit, and the buffer writer persists them. A sample becomes the
 * buffers of its edited copy: the sample itself never changes. A folder's edits are the crash snapshot's (A4).
 */
function writtenThrough(
  source: Source,
  changes: history.TextChanges,
  byPath: Record<string, string>,
): Source {
  if (source.kind === 'sample')
    return {
      kind: 'paste',
      name: `edited copy of the ${source.name} sample`,
      buffers: Object.entries(byPath).map(([path, text]) => ({ path, text })),
    };
  if (source.kind !== 'paste') return source;
  const buffers = source.buffers
    .filter((b) => changes[b.path] !== null)
    .map((b) => (Object.hasOwn(changes, b.path) ? { path: b.path, text: changes[b.path]! } : b));
  for (const [path, text] of Object.entries(changes))
    if (text !== null && !source.buffers.some((b) => b.path === path)) buffers.push({ path, text });
  return { ...source, buffers };
}

/**
 * When and where an entry is made. While an earlier edit's selection waits for its plan, that selection is where the
 * author is: the one shown is a unit path of an older text, which an undo would bring back onto another node.
 */
const contextOf = (s: SessionState): history.Context => {
  const at = s.edit.pendingSel ?? s;
  return {
    at: Date.now(),
    selection: {
      ...(at.focus === undefined ? {} : { focus: at.focus }),
      ...(at.sel === undefined ? {} : { sel: at.sel }),
    },
  };
};

/** The files with these paths opened again at their base (none: not there). */
function reopened(files: SessionState['files'], paths: readonly string[]): SessionState['files'] {
  if (paths.length === 0) return files;
  const opened = { ...files.opened };
  for (const path of paths)
    if (Object.hasOwn(files.base, path)) opened[path] = files.base[path]!;
    else delete opened[path];
  return { ...files, opened };
}

/**
 * The files of a new source: a new epoch, every file at the new version, its text as read and as opened, except
 * where `diff` gives the text its edits were made to (pasted buffers carry their edits across epochs).
 */
/** The files with these snapshots, or none. */
function withReadonly(
  files: SessionState['files'],
  readonly: Record<string, string> | undefined,
): SessionState['files'] {
  if (readonly && Object.keys(readonly).length > 0) return { ...files, readonly };
  const rest = { ...files };
  delete rest.readonly;
  return rest;
}

function sourceFiles(
  files: SessionState['files'],
  byPath: Record<string, string>,
  meta: Record<string, FileMeta>,
  diff?: BaseDiff,
): SessionState['files'] {
  const version = files.version + 1;
  const revs = Object.fromEntries(Object.keys(byPath).map((path) => [path, version]));
  const base = { ...byPath };
  for (const [path, text] of Object.entries(diff ?? {}))
    if (text === null) delete base[path];
    else base[path] = text;
  return { version, epoch: files.epoch + 1, byPath, meta, revs, base, opened: base };
}

/**
 * The texts changed within the epoch: the files version moves, and so does the rev of each file whose text changed;
 * the epoch, the base and the opened texts stay. A path new to the files gets the meta of a string, and `null`
 * removes a file (its meta stays, for the undo that brings it back). A file's `eol` follows its text, so a converted
 * file is no longer mixed, except that a text left with no line break keeps the ending it had, so its next lines get
 * it too; its BOM and its encoding stay what reading found. Nothing else of the store moves, the plan, the picture, the selection and the scenario
 * included: the plan is stale for the edit until the session brings the one of the new texts. Texts the files already
 * hold change nothing. This is what an edit of the store's texts reduces to; the history's steps commit through it.
 */
export function withTexts(
  s: SessionState,
  texts: Readonly<Record<string, string | null>>,
): Partial<Pick<SessionState, 'files' | 'stale'>> {
  const changed = Object.entries(texts).filter(([path, text]) =>
    text === null ? Object.hasOwn(s.files.byPath, path) : s.files.byPath[path] !== text,
  );
  if (changed.length === 0) return {};
  const version = s.files.version + 1;
  const files = {
    ...s.files,
    edited: undefined,
    version,
    byPath: { ...s.files.byPath },
    meta: { ...s.files.meta },
    revs: { ...s.files.revs },
  };
  for (const [path, text] of changed) {
    if (text === null) {
      delete files.byPath[path];
      delete files.revs[path];
      continue;
    }
    files.byPath[path] = text;
    const meta = files.meta[path];
    files.meta[path] = encodingOf(meta ? withEol(meta, text) : textMeta(text), files.lenient?.[path], text);
    files.revs[path] = version;
  }
  // Only a project file's text is in the plan; a test file (C10) leaves it current.
  const planned = changed.some(([path]) => isProjectFile(path));
  return { files, stale: s.plan === undefined ? false : planned ? 'edit' : s.stale };
}

/** A file's meta for its new text as to its encoding: not UTF-8 exactly while the text is one read from such bytes. */
function encodingOf(meta: FileMeta, lenient: readonly string[] | undefined, text: string): FileMeta {
  if (!lenient) return meta;
  const utf8 = !lenient.includes(text);
  return utf8 === meta.utf8 ? meta : { ...meta, utf8 };
}

/** A file's meta for its new text: its line endings as the text has them, the ones it had while it has no break. */
const withEol = (meta: FileMeta, text: string): FileMeta => {
  const eol = classifyEol(text);
  return eol === meta.eol || eol === 'none' ? meta : { ...meta, eol };
};

/** An input changed: the plan shown, if any, is stale for it. */
const inputsStale = (s: SessionState): SessionState['stale'] => (s.plan === undefined ? false : 'inputs');

/** The meta of each file: as the reader gave it, else that of a string. A path not in `byPath` is dropped. */
function metaOf(
  byPath: Record<string, string>,
  given: Record<string, FileMeta> = {},
): Record<string, FileMeta> {
  const meta: Record<string, FileMeta> = {};
  for (const [path, text] of Object.entries(byPath)) meta[path] = given[path] ?? textMeta(text);
  return meta;
}

/**
 * Whether a patch edits what an assumed mark is on: its key, or for `inputs.<name>` that one input, so an edit of
 * another input keeps the mark.
 */
function edits(mark: string, scenario: ScenarioInput, patch: Partial<ScenarioInput>): boolean {
  const [key = '', name] = mark.split(/\.(.*)/s);
  if (!(key in patch)) return false;
  if (name === undefined) return true;
  const before = (scenario as Record<string, unknown>)[key];
  const after = (patch as Record<string, unknown>)[key];
  return JSON.stringify(entryOf(before, name)) !== JSON.stringify(entryOf(after, name));
}

const entryOf = (record: unknown, name: string): unknown =>
  typeof record === 'object' && record !== null && Object.hasOwn(record, name)
    ? (record as Record<string, unknown>)[name]
    : undefined;

/** A patch value of `undefined` removes the key: the schema is strict and the URL carries only what is set. */
function withPatch(scenario: ScenarioInput, patch: Partial<ScenarioInput>): ScenarioInput {
  const next = { ...scenario } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as ScenarioInput;
}

function withYamlFile(ui: SessionState['ui'], yamlFile: string | undefined): SessionState['ui'] {
  const next = { ...ui };
  if (yamlFile === undefined) delete next.yamlFile;
  else next.yamlFile = yamlFile;
  return next;
}

const toggled = (list: readonly string[], item: string): string[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

/** The plan on screen as a change is made over it, if any. */
const beforeOf = (plan: PlanState | undefined): { before?: Before } =>
  plan ? { before: { plan: plan.plan, derived: plan.derived, for: plan.for } } : {};

/**
 * A pin over the store as it is: the plan it is made over and the inputs it leaves. Its `seq` comes from
 * `changeSeq`, so one change and the next always differ in parity, whatever cleared the change between them.
 */
const pinOver = (s: SessionState, scenario: ScenarioInput, assume: AssumeEntry[]): Change => ({
  seq: ++changeSeq,
  cause: 'pin',
  label: 'pinned',
  ...beforeOf(s.plan),
  waitFor: { scenario, assume },
});

/** What a commit of the history says it did, and whether it is only keys typed in the pane. */
interface Said {
  label: string;
  quiet?: true;
  /** The ids the commit renames (C11). */
  renames?: Renames;
}

/**
 * The change a commit that changed a project file leaves (§ 7.4). An unanswered edit goes on: it waits for the newest
 * files, takes the newest label and keeps the plan from before the burst's first edit. Anything else gives way, an
 * unanswered pin included, to a new edit over the plan on screen; with no plan there is nothing to compare.
 */
function editOver(s: SessionState, files: number, said: Said): Change | undefined {
  const open = s.change?.cause === 'edit' && !s.change.after ? s.change : undefined;
  const quiet = said.quiet && (!open || open.quiet) ? { quiet: said.quiet } : {};
  if (open) {
    const { quiet: _, ...rest } = open;
    return {
      ...rest,
      label: said.label,
      waitFor: { files },
      ...quiet,
      ...changeRenames(open.renames, said.renames),
    };
  }
  if (!s.plan) return undefined;
  return {
    seq: ++changeSeq,
    cause: 'edit',
    label: said.label,
    ...beforeOf(s.plan),
    waitFor: { files },
    ...quiet,
    ...changeRenames(undefined, said.renames),
  };
}

/**
 * The change with what the plan answering it changed; one already answered, or with no plan to compare, stays as it
 * is. A settled change drops the plan it was made over, which nothing reads once the rows are known, so the store
 * does not hold an old plan for as long as the change stays.
 */
function answered(change: Change | undefined, plan: PlanState): Change | undefined {
  if (!change?.before || change.after) return change;
  return change.cause === 'pin'
    ? pinAnswered(change, change.before, plan)
    : editAnswered(change, change.before, plan);
}

/**
 * A pin is answered by the plan simulated from the very inputs it left. A plan for other inputs (an older reply, an
 * edit after the pin) leaves it waiting.
 */
const pinAnswered = (pin: Change, before: Before, plan: PlanState): Change =>
  plan.for.scenario === pin.waitFor.scenario && plan.for.assume === pin.waitFor.assume
    ? settled(pin, before, plan)
    : pin;

/**
 * An edit is answered by the first plan of its newest files or newer ones, which `run()` labels honestly. A plan of
 * older files leaves it waiting; when that plan is for other inputs than the plan before (the scenario changed during
 * the burst), it becomes the plan before, so the answer is compared with a plan of its own scenario. An answer for
 * other inputs than the plan before can say nothing of the edit alone, and the change goes.
 */
function editAnswered(edit: Change, before: Before, plan: PlanState): Change | undefined {
  const same = sameInputs(before, plan);
  if (plan.for.files < (edit.waitFor.files ?? 0)) return same ? edit : { ...edit, ...beforeOf(plan) };
  return same ? settled(edit, before, plan) : undefined;
}

/** Whether two plans were simulated from the same scenario, assume entries and detail. */
const sameInputs = (a: Before, b: PlanState): boolean =>
  a.for.scenario === b.for.scenario && a.for.assume === b.for.assume && a.plan.detail === b.plan.detail;

/** The change settled by the plan that answers it: its rows and its sentence, the plan before let go. */
function settled(change: Change, before: Before, plan: PlanState): Change {
  const diff = diffOf(before.plan, plan.plan, change.renames);
  const rows = changeRows(diff, before, plan);
  const sentence =
    change.cause === 'pin'
      ? pinSentence(verdictChanges(before, plan, diff))
      : change.quiet && !rows.length
        ? undefined
        : changeSentence(rows, change.label);
  const { before: _, ...rest } = change;
  return { ...rest, after: { plan: plan.plan, rows, ...(sentence === undefined ? {} : { sentence }) } };
}

/** Why the pane may not edit a file, or that it may. */
export type Writable =
  | { ok: true }
  | { ok: false; reason: 'off' | 'missing' | 'encoding' | 'loading' | 'mixed' }
  | { ok: false; reason: 'generated'; marker: string };

/**
 * Whether the pane may edit a file (synthesis § 4.3): in edit mode, a file read as valid UTF-8, known not to be
 * generated (an Outline of the epoch has come) unless the author unlocked it in this epoch or has edited it already
 * (a marker typed into it does not lock it under the cursor), with one kind of line ending. Generated is said before
 * mixed, so a locked file never offers Convert. Invalid YAML stays writable: the pane is where it gets fixed.
 */
export function writable(s: Pick<SessionState, 'edit' | 'files' | 'generated'>, path: string): Writable {
  if (!s.edit.on) return { ok: false, reason: 'off' };
  const meta = s.files.meta[path];
  const text = s.files.byPath[path];
  if (text === undefined || !meta) return { ok: false, reason: 'missing' };
  if (!meta.utf8) return { ok: false, reason: 'encoding' };
  if (s.generated === undefined) return { ok: false, reason: 'loading' };
  const marker = s.generated[path];
  const kept = s.edit.unlocked.includes(path) || text !== s.files.base[path];
  if (marker !== undefined && !kept) return { ok: false, reason: 'generated', marker };
  if (meta.eol === 'mixed') return { ok: false, reason: 'mixed' };
  return { ok: true };
}

/** The Outline of the newest texts loaded: the held one while the hold is on, since its errors are what to fix. */
export const newestOutline = (s: Pick<SessionState, 'project'>): Outline | undefined =>
  s.project.held?.outline ?? s.project.outline;

/** The files version `newestOutline` is of. */
export const newestOutlined = (s: Pick<SessionState, 'project'>): number | undefined =>
  s.project.held?.files ?? s.project.files;

/** The errors only a reload clears: the engine never started, or it stopped and could not be restarted. */
export function isBlocking(error: SessionError | undefined): boolean {
  return error?.kind === 'boot' || error?.kind === 'stopped';
}

/** A blocking error stays until the page reloads; any other gives way to `next`. */
function replaceError(
  error: SessionError | undefined,
  next: SessionError | undefined,
): SessionError | undefined {
  return isBlocking(error) ? error : next;
}

/** An edit of the thing the worker rejected clears that rejection; other errors stay. */
function authorsErrorCleared(
  error: SessionError | undefined,
  kind: 'scenario' | 'assume',
): SessionError | undefined {
  return error?.kind === kind ? undefined : error;
}
