import {
  type AssumeEntry,
  diffPlans,
  type RemoteSourceInput,
  type RunPlan,
  restrictPlan,
  selectNodes,
  simulate,
  unitPathOfId,
  unitPaths,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

/** Node ids of remote callees hold `/`, `@`, `.` and `owner/repo`: everything that reads an id must keep them whole. */

const CI = '.github/workflows/ci.yml';
const REF = 'Octo/ship.io/.github/workflows/deploy.v2.yml@release/v1.2';
const CALLEE = `${CI}#call>${REF}`;
const STEP = `${CALLEE}#ship[os=linux]/steps.go`;

const body = `
on:
  workflow_call:
    outputs:
      out:
        value: \${{ jobs.ship.outputs.out }}
jobs:
  ship:
    strategy:
      matrix:
        os: [linux]
    runs-on: ubuntu-latest
    outputs:
      out: \${{ steps.go.outputs.out }}
    steps:
      - id: go
        uses: octo/tool@v1
      - if: steps.go.outputs.out == 'x'
        run: echo
`;

const files = (job = 'call') => ({
  [CI]: `on: push\njobs:\n  ${job}:\n    uses: ${REF}\n  after:\n    needs: ${job}\n    if: needs.${job}.outputs.out == 'x'\n    runs-on: x\n    steps: [{ run: echo }]\n`,
});
const sources: RemoteSourceInput[] = [
  { ref: REF, kind: 'workflow', sha: 'c'.repeat(40), text: body, pinned: 'lockfile' },
];

const plan = (assume: AssumeEntry[] = [], job = 'call'): RunPlan =>
  simulate({ files: files(job), scenario: { event: 'push' }, remotes: { sources }, assume });

describe('ids of remote callees', () => {
  it('are the leg, > and the ref as written', () => {
    const p = plan();
    const callee = p.workflows[0]!.jobs[0]!.legs[0]!.call!;
    expect(callee.id).toBe(CALLEE);
    expect(callee.jobs[0]!.legs[0]!.steps![0]!.id).toBe(STEP);
    expect(p.unknowns.map((u) => u.id)).toContain(`${STEP}.outputs.out`);
  });

  it('give assume pins that name the unit by path, and each decides its unknown', () => {
    const p = plan();
    const u = p.unknowns.find((x) => x.id === `${STEP}.outputs.out`)!;
    expect(u.producer).toBe(STEP);
    expect(u.pin?.fragment).toEqual({ step: 'call/ship.go', matrix: { os: 'linux' }, outputs: { out: '' } });
    const after = plan([u.pin!.fragment as AssumeEntry]);
    expect(after.unknowns.map((x) => x.id)).not.toContain(u.id);
    expect(after.diagnostics).toEqual([]);
  });

  it('select by unit path across the call, and map back from ids', () => {
    const p = plan();
    const [node] = selectNodes(p, 'call/ship[os=linux].go', CI).nodes;
    expect(node?.step?.id).toBe(STEP);
    const paths = unitPaths(p.workflows[0]!);
    expect(paths.get(CALLEE.replace(`>${REF}`, ''))).toBe('call');
    expect(unitPathOfId(`${STEP}.outputs.out`, paths)).toBe('call/ship[os=linux].go.outputs.out');
    expect(unitPathOfId(`race:fail-fast:${CALLEE}#ship[os=linux]`, paths)).toBe(
      'race:fail-fast:call/ship[os=linux]',
    );
  });

  it('stay under their workflow when the plan is restricted to it', () => {
    const p = plan();
    const other = { ...p, workflows: [...p.workflows, { ...p.workflows[0]!, id: 'x.yml', path: 'x.yml' }] };
    const r = restrictPlan(other, CI);
    expect(r.unknowns.map((u) => u.id)).toEqual(p.unknowns.map((u) => u.id));
    expect(r.remotes).toEqual(p.remotes);
    expect(restrictPlan(other, 'x.yml').unknowns).toEqual([]);
  });

  it('diff across a rename of the calling job at its boundary only, and name an added callee once', () => {
    const before = plan();
    const after = plan([], 'deploy');
    const diff = diffPlans(before, after, { renames: { [`${CI}#call`]: `${CI}#deploy` } });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    const unread = simulate({ files: files(), scenario: { event: 'push' } });
    expect(diffPlans(unread, before).added.map((n) => n.id)).toEqual([CALLEE]);
  });
});
