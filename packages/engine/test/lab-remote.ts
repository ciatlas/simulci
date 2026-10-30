import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadFiles,
  type NeededRemote,
  remotesNeeded,
  type RemoteSourceInput,
  simulate,
} from '@simulci/engine';
import {
  type Accuracy,
  gradeRun,
  gradeTri,
  lab,
  labFiles,
  type LabRun,
  type LabTree,
  labTree,
  Tally,
  walk,
} from './lab';

/**
 * The routes lab's remote cases (fixtures/routes-lab/cases.md, R1-R10): `case-remote-*.yml` in the lab calling
 * reusable workflows and actions of the public ciatlas/simulci-lab-remote, graded as lab.ts grades the status cases.
 * The remote files are fed in as a host reads them (`remotesNeeded`, then each ref at its pin, else at the commit it
 * pointed to when the run started), and every commit GitHub recorded for a run must be the one fed in.
 */

/** A remote run (expected-remote.json): a lab run plus the commit each called workflow and action resolved to. */
interface RemoteRun extends LabRun {
  /** Each called workflow, `owner/repo/path@<as written, or the commit for a ./>`, with the ref it was read under. */
  referenced: { path: string; ref: string | null; sha: string }[];
  jobs: (LabRun['jobs'][number] & { actions: Record<string, string> })[];
}

/** A dispatch GitHub refused (refused.json): no run, so the workflow did not trigger. */
interface Refusal {
  workflow: string;
  ref: string;
  sha: string;
  message: string;
}

export const remoteRuns = (
  JSON.parse(readFileSync(join(lab, 'expected-remote.json'), 'utf8')) as { runs: RemoteRun[] }
).runs;
export const refusals = (
  JSON.parse(readFileSync(join(lab, 'refused.json'), 'utf8')) as { refused: Refusal[] }
).refused;

/** What the lab's repository had besides its files: the secret R6 reports on (README "Running the remote cases"). */
const GIVEN = { secrets: ['LAB_SECRET'] };

/** Observed values no plan can be compared with, each with the reason; they are left out of the figure. */
export const NOT_COMPARED: { workflow: string; job: string; probe: string; reason: string }[] = [
  {
    workflow: '.github/workflows/case-remote-node-undeclared-output.yml',
    job: 'a',
    probe: 'r4-node',
    reason: 'echoed by the node action’s own script (r4-node/index.js), which a plan never runs',
  },
];

/** The run without the values NOT_COMPARED lists. */
function comparable(run: RemoteRun): RemoteRun {
  const jobs = run.jobs.map((job) => {
    const skip = new Set(
      NOT_COMPARED.filter((n) => n.workflow === run.workflow && n.job === job.name).map((n) => n.probe),
    );
    return {
      ...job,
      probes: Object.fromEntries(Object.entries(job.probes).filter(([k]) => !skip.has(k))),
    };
  });
  return { ...run, jobs };
}

// --- The remote at each round -------------------------------------------------------------------------------------

/** Commit `a` of the remote, which `remote/` holds, and `b`, where `main` and `v1` moved before round 2. */
const REMOTE_A = 'd19def8c3562ef6c1be3f12443345575530f1ac4';
const REMOTE_B = '38a93ff01695fd104bfe8bc8b79ceeae91206ddc';
/** The lab's `main` in round 1, which a same-repository full ref `@main` read (R10). */
const LAB_ROUND_1 = '203597779b990c61f6150bb92b814055eb0241f8';
/** The lab commit round 2 was dispatched on; nothing ran on it before the move but refused dispatches. */
const LAB_ROUND_2 = '40610550821392d10214c8dd5a72dc780ec106d5';

const LAB = 'ciatlas/simulci-lab';
/** The remote under its two owners (R6 calls one commit under both). */
const REMOTES = new Set(['ciatlas/simulci-lab-remote', 'rumankazi/simulci-lab-remote']);

const treeA = walk(join(lab, 'remote'));

/** `b` is `a` with five probe lines changed (fixtures/routes-lab/README.md, "The remote repository"). */
const B_CHANGES: [file: string, from: string, to: string, times: number][] = [
  ['.github/workflows/callee-r2-inner.yml', 'remote-a', 'remote-b', 2],
  ['.github/workflows/callee-r2-outer.yml', 'remote-a', 'remote-b', 1],
  ['.github/actions/r2-self/action.yml', 'remote-a', 'remote-b', 1],
  ['.github/workflows/callee-r5-version.yml', 'r5-version=a', 'r5-version=b', 1],
  ['.github/actions/r9-action/action.yml', 'r9-action=a', 'r9-action=b', 1],
];

function treeAtB(): Record<string, string> {
  const out = { ...treeA };
  for (const [file, from, to, times] of B_CHANGES) {
    const parts = out[file]!.split(from);
    if (parts.length !== times + 1)
      throw new Error(`${file}: ${from} ${parts.length - 1} times, not ${times}`);
    out[file] = parts.join(to);
  }
  return out;
}
const treeB = treeAtB();

/** The lab's files on a run's branch: `probe/r10` differs from `main` only in `callee-r10.yml` (R10). */
function labFilesOn(ref: string): Record<string, string> {
  if (ref !== 'refs/heads/probe/r10') return labFiles;
  const file = '.github/workflows/callee-r10.yml';
  return { ...labFiles, [file]: labFiles[file]!.replace('r10-copy=main', 'r10-copy=branch') };
}

/** `owner/repo`, the path in it and the ref of a remote ref `owner/repo[/path]@ref`. */
function splitRef(ref: string): { repo: string; path: string; at: string } {
  const m = /^([^/]+\/[^/@]+)(?:\/([^@]+))?@(.+)$/.exec(ref);
  if (!m) throw new Error(`${ref}: not a remote ref`);
  return { repo: m[1]!.toLowerCase(), path: m[2] ?? '', at: m[3]! };
}

/** Where a ref that names no commit pointed when the run started: `main` and `v1` moved to `b` before round 2. */
function liveCommit(repo: string, moved: boolean): string {
  if (repo === LAB) return LAB_ROUND_1;
  return moved ? REMOTE_B : REMOTE_A;
}

function textAt(repo: string, file: string, sha: string): string {
  const tree = repo === LAB ? labFiles : sha === REMOTE_B ? treeB : sha === REMOTE_A ? treeA : undefined;
  const text = tree?.[file];
  if (text === undefined) throw new Error(`${repo}/${file}@${sha}: not in the lab's copies`);
  return text;
}

const inLab = (ref: string) => {
  const { repo } = splitRef(ref);
  return repo === LAB || REMOTES.has(repo);
};

/** A needed remote as the host reads it: at its pin, a commit it names, or where it pointed when the run started. */
function readAs(n: NeededRemote, moved: boolean): RemoteSourceInput {
  const { repo, path, at } = splitRef(n.ref);
  const sha = n.pin?.sha ?? (/^[0-9a-f]{40}$/.test(at) ? at : liveCommit(repo, moved));
  const file = n.kind === 'workflow' ? path : `${path ? `${path}/` : ''}action.yml`;
  return {
    ref: n.ref,
    kind: n.kind,
    sha,
    text: textAt(repo, file, sha),
    pinned: n.pin?.pinned ?? 'resolved',
  };
}

/**
 * The remote files a host reads for the lab's files: each ref in the lab's repositories that `remotesNeeded` names
 * next, until nothing more is needed. Others (`actions/checkout`) stay unread, as the status cases plan them.
 */
function hostRead(files: Record<string, string>, moved: boolean): RemoteSourceInput[] {
  const sources: RemoteSourceInput[] = [];
  for (;;) {
    const project = loadFiles(files, { repository: LAB, remotes: { sources }, mode: 'fetch' });
    const next = remotesNeeded(project, 'fetch').filter((n) => inLab(n.ref));
    if (!next.length) return sources;
    sources.push(...next.map((n) => readAs(n, moved)));
  }
}

/** The lab as a run saw it: its branch's files and the remotes read at the run's round, built once per pair. */
const trees = new Map<string, { tree: LabTree; sources: RemoteSourceInput[] }>();
function treeFor(ref: string, moved: boolean) {
  const key = `${ref} ${moved}`;
  let entry = trees.get(key);
  if (!entry) {
    const files = labFilesOn(ref);
    const sources = hostRead(files, moved);
    entry = { tree: labTree(files, { repository: LAB, remotes: { sources }, mode: 'fetch' }), sources };
    trees.set(key, entry);
  }
  return entry;
}

/** Round 2 ran on LAB_ROUND_2 after the move; every run before it saw `main` and `v1` at `a`. */
const movedFor = (run: RemoteRun) => run.sha === LAB_ROUND_2;

/** Where a called workflow GitHub recorded (`referenced`) was not fed in at its commit; one at the run's commit is local. */
function workflowIssues(run: RemoteRun, sources: readonly RemoteSourceInput[]): string[] {
  return run.referenced.flatMap((r) => {
    const source = sources.find((s) => s.ref === r.path);
    if (!source) return splitRef(r.path).repo === LAB && r.sha === run.sha ? [] : [`${r.path}: not fed`];
    return source.sha === r.sha ? [] : [`${r.path}: fed ${source.sha}, GitHub read ${r.sha}`];
  });
}

/** Where an action of the lab's remotes a job downloaded (`actions`, by `owner/repo@ref`) was fed at another commit. */
function actionIssues(job: RemoteRun['jobs'][number], sources: readonly RemoteSourceInput[]): string[] {
  return Object.entries(job.actions).flatMap(([action, sha]) => {
    const { repo, at } = splitRef(action);
    if (!REMOTES.has(repo)) return [];
    const fed = sources.filter(
      (s) => s.kind === 'action' && `${splitRef(s.ref).repo}@${splitRef(s.ref).at}` === `${repo}@${at}`,
    );
    if (!fed.length) return [`${action}: not fed`];
    return fed
      .filter((s) => s.sha !== sha)
      .map((s) => `${s.ref}: fed ${s.sha}, ${job.name} downloaded ${sha}`);
  });
}

/** Where a commit GitHub recorded for the run is not the one fed in. */
const inputIssues = (run: RemoteRun, sources: readonly RemoteSourceInput[]): string[] => [
  ...workflowIssues(run, sources),
  ...run.jobs.flatMap((job) => actionIssues(job, sources)),
];

// --- Grading --------------------------------------------------------------------------------------------------------

/** A refused dispatch: the workflow is graded as not triggered, the refusal being GitHub's answer. */
function gradeRefusal(t: Tally, r: Refusal) {
  const { tree } = treeFor(r.ref, false);
  const plan = simulate({
    project: tree.project,
    scenario: { event: 'workflow_dispatch', ref: r.ref, sha: r.sha, repository: LAB },
  });
  const wf = plan.workflows.find((w) => w.path === r.workflow);
  if (!wf) throw new Error(`${r.workflow}: not in the lab's files (repo/)`);
  const where = `${r.workflow} [refused ${r.ref} ${r.sha.slice(0, 7)}]`;
  t.add(
    'triggers',
    gradeTri(wf.triggered.verdict, false),
    where,
    () => `predicted ${wf.triggered.verdict}, refused`,
  );
}

/** accuracy.json's `remote` block: the remote runs and refused dispatches, graded apart from the status cases. */
export type RemoteAccuracy = Omit<Accuracy, 'capture'> & { refused: number };

/**
 * Grades every remote run and every refused dispatch. `wrong` lists each wrong prediction, and `inputs` each commit
 * GitHub recorded that a host following `remotesNeeded` does not read (a run is graded on what the host reads).
 */
export function measureRemote(): { accuracy: RemoteAccuracy; wrong: string[]; inputs: string[] } {
  const t = new Tally();
  const inputs: string[] = [];
  for (const run of remoteRuns) {
    const { tree, sources } = treeFor(run.ref, movedFor(run));
    for (const issue of inputIssues(run, sources))
      inputs.push(`${run.workflow} [${run.ref} ${run.sha.slice(0, 7)}] ${issue}`);
    gradeRun(t, comparable(run), tree, GIVEN);
  }
  for (const r of refusals) gradeRefusal(t, r);
  return {
    accuracy: { runs: remoteRuns.length, refused: refusals.length, compared: t.compared, ...t.grades },
    wrong: t.wrong,
    inputs,
  };
}
