import {
  type RunPlan,
  type ScenarioInput,
  SelectionError,
  selectNodes,
  simulate,
  unitPathOfId,
  unitPaths,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const files = {
  '.github/workflows/ci.yml': `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - id: unit
        run: npm test
      - run: echo done
  call:
    uses: ./.github/workflows/callee.yml
    with:
      flag: true
  use:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: u
        uses: ./.github/actions/comp
  gated:
    if: false
    runs-on: ubuntu-latest
    steps:
      - id: g
        run: echo gated
`,
  '.github/workflows/callee.yml': `
on:
  workflow_call:
    inputs:
      flag:
        type: boolean
        default: false
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - id: v
        run: echo "version=1" >> "$GITHUB_OUTPUT"
`,
  '.github/actions/comp/action.yml': `
name: comp
runs:
  using: composite
  steps:
    - id: inner
      run: echo inner
      shell: bash
    - run: echo second
      shell: bash
`,
};

const plan = (scenario: ScenarioInput = { event: 'push' }): RunPlan => simulate({ files, scenario });
const paths = (p: RunPlan, path: string) => selectNodes(p, path, 'ci.yml').nodes.map((n) => [n.kind, n.path]);
const fails = (p: RunPlan, path: string): string => {
  try {
    selectNodes(p, path, 'ci.yml');
  } catch (e) {
    if (e instanceof SelectionError) return `${e.code} ${e.message}`;
    throw e;
  }
  return 'selected';
};

describe('selectNodes', () => {
  const p = plan();

  it('names jobs, legs and steps, one step per selected leg, with canonical paths', () => {
    expect(paths(p, 'test')).toEqual([['job', 'test']]);
    expect(paths(p, 'test[os=windows-latest]')).toEqual([['leg', 'test[os=windows-latest]']]);
    expect(paths(p, 'test.unit')).toEqual([
      ['step', 'test[os=ubuntu-latest].unit'],
      ['step', 'test[os=windows-latest].unit'],
    ]);
    expect(paths(p, 'test[OS=ubuntu-latest].#2')).toEqual([['step', 'test[os=ubuntu-latest].#2']]);
    expect(paths(p, 'ci:use')).toEqual([['job', 'use']]);
    expect(paths(p, 'use.#1')).toEqual([['step', 'use.#1']]);
    expect(selectNodes(p, 'test.unit', 'ci').nodes[0]!.step!.stepId).toBe('unit');
  });

  it('descends into a called workflow with / and into a composite action after a step', () => {
    expect(paths(p, 'call/x')).toEqual([['job', 'call/x']]);
    expect(paths(p, 'call/x.v')).toEqual([['step', 'call/x.v']]);
    expect(paths(p, 'use.u/inner')).toEqual([['step', 'use.u/inner']]);
    expect(paths(p, 'use.u/#2')).toEqual([['step', 'use.u/#2']]);
    const inner = selectNodes(p, 'use.u/inner', 'ci.yml').nodes[0]!;
    expect(inner.composite?.path).toBe('.github/actions/comp');
    expect(inner.step?.stepId).toBe('inner');
  });

  it('reports a unit under a skipped job or an untriggered workflow as unexpanded, not missing', () => {
    const skipped = selectNodes(p, 'gated.g', 'ci.yml');
    expect(skipped.nodes).toEqual([]);
    expect(skipped.unexpanded).toMatchObject({ reason: 'skipped', verdict: 'no', path: 'gated' });
    const untriggered = selectNodes(plan({ event: 'pull_request' }), 'test.unit', 'ci.yml');
    expect(untriggered.unexpanded).toMatchObject({ reason: 'untriggered', verdict: 'no' });
    expect(
      selectNodes(simulate({ files, scenario: { event: 'push' }, detail: 'legs' }), 'test.unit', 'ci.yml')
        .unexpanded,
    ).toMatchObject({ reason: 'no-steps' });
  });

  it('rejects names that do not exist where their parent is planned (T204), with the alternatives', () => {
    expect(fails(p, 'tst')).toBe(
      "T204 no job 'tst' in ci.yml (jobs: test, call, use, gated); did you mean 'test'?",
    );
    expect(fails(p, 'test[arch=x64]')).toBe("T204 no matrix key 'arch' in 'test' (keys: os)");
    expect(fails(p, 'test[os=macos-latest]')).toBe(
      "T204 no leg of 'test' matches [os=macos-latest] (legs: [os=ubuntu-latest], [os=windows-latest])",
    );
    expect(fails(p, 'use[os=x]')).toBe("T204 'use' has no matrix; drop the [os=x]");
    expect(fails(p, 'test.lint')).toBe("T204 no step 'lint' in 'test[os=ubuntu-latest]' (steps: unit, #2)");
    expect(fails(p, 'use.#5')).toBe("T204 no step #5 in 'use' (steps: #1, u)");
    expect(fails(p, 'test/x')).toBe(
      "T204 'test' does not call a reusable workflow; / descends into a called workflow (write test.x for a step)",
    );
    expect(fails(p, 'call.v')).toBe(
      "T204 'call' calls a reusable workflow and has no steps; / descends into its jobs (x)",
    );
    expect(fails(p, 'call/y')).toBe("T204 no job 'y' under 'call' (jobs: x); did you mean 'x'?");
    expect(fails(p, 'test.unit/x')).toBe(
      "T204 'test[os=ubuntu-latest].unit' is a run step; / descends into a composite action's steps",
    );
    expect(fails(p, 'use.#1/x')).toBe(
      "T204 'use.#1' uses actions/checkout@v4, which is not a composite action in the project; its steps are not in the plan",
    );
    expect(fails(p, 'use.u/nope')).toBe("T204 no step 'nope' in 'use.u' (steps: inner, #2)");
    expect(fails(p, 'release.yml:test')).toBe(
      "T201 no workflow 'release.yml' in the plan (workflows: callee.yml, ci.yml)",
    );
  });

  it('maps node and unknown ids back to unit paths', () => {
    const wf = p.workflows.find((w) => w.path.endsWith('ci.yml'))!;
    const map = unitPaths(wf);
    const leg = wf.jobs[0]!.legs[0]!;
    expect(map.get(leg.id)).toBe('test[os=ubuntu-latest]');
    expect(map.get(wf.jobs[2]!.id)).toBe('use');
    expect(map.get(wf.jobs[2]!.legs[0]!.id)).toBe('use');
    expect(unitPathOfId(`${leg.steps![0]!.id}.outputs.x`, map)).toBe('test[os=ubuntu-latest].unit.outputs.x');
    expect(unitPathOfId(`${leg.steps![1]!.id}.outcome`, map)).toBe('test[os=ubuntu-latest].#2.outcome');
    expect(unitPathOfId(`race:fail-fast:${leg.id}`, map)).toBe('race:fail-fast:test[os=ubuntu-latest]');
    const callee = wf.jobs[1]!.legs[0]!.call!;
    expect(unitPathOfId(`${callee.jobs[0]!.legs[0]!.steps![0]!.id}.outputs.version`, map)).toBe(
      'call/x.v.outputs.version',
    );
    const inner = wf.jobs[2]!.legs[0]!.steps![1]!.composite!.steps[1]!;
    expect(unitPathOfId(`${inner.id}.outcome`, map)).toBe('use.u/#2.outcome');
    expect(unitPathOfId('vars.DEPLOY', map)).toBe('vars.DEPLOY');
  });
});
