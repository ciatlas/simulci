import { type AssumeEntry, type Json, type RunPlan, type ScenarioInput, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { assumePins, type UnitSite } from '../src/plan/pins';

const CI = '.github/workflows/ci.yml';
const push: ScenarioInput = { event: 'push', branch: 'main' };

const plan = (
  files: Record<string, string>,
  assume: AssumeEntry[] = [],
  detail?: 'legs' | 'steps',
): RunPlan => simulate({ files, scenario: push, assume, ...(detail ? { detail } : {}) });

const unknownOf = (p: RunPlan, id: string) => {
  const u = p.unknowns.find((x) => x.id === id);
  if (!u) throw new Error(`no unknown ${id} in ${p.unknowns.map((x) => x.id).join(', ')}`);
  return u;
};

/** The pin's entry with a value where it holds the prefilled one. */
function filled(fragment: Json): AssumeEntry {
  const entry = structuredClone(fragment) as AssumeEntry;
  for (const field of ['outputs', 'env'] as const)
    for (const name of Object.keys(entry[field] ?? {})) entry[field]![name] = 'x';
  return entry;
}

/** Each assume pin of the plan, applied alone, names its unit (no SC102) and decides its unknown. */
function expectEveryPinApplies(files: Record<string, string>): void {
  const pinned = plan(files).unknowns.filter((u) => u.pin?.layer === 'assume');
  expect(pinned.length).toBeGreaterThan(0);
  for (const u of pinned) {
    const after = plan(files, [filled(u.pin!.fragment)]);
    expect(after.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(after.unknowns.map((x) => x.id)).not.toContain(u.id);
  }
}

const matrix = {
  [CI]: `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['lts/*', 22]
    steps:
      - id: v
        run: ./version.sh
      - if: steps.v.outputs.ok == 'yes'
        run: echo ok
  stamp:
    runs-on: ubuntu-latest
    steps:
      - id: w
        run: echo "STAMP=$(date)" >> "$GITHUB_ENV"
      - if: env.STAMP != ''
        run: echo stamped
`,
};

const nested = {
  [CI]: `
on: push
jobs:
  call:
    strategy:
      matrix:
        target: [a, 'b/c']
    uses: ./.github/workflows/callee.yml
  comp:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux]
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/comp
`,
  '.github/workflows/callee.yml': `
on: workflow_call
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - id: d
        run: ./detect.sh
      - if: steps.d.outputs.go == 'y'
        run: echo go
`,
  '.github/actions/comp/action.yml': `
name: comp
runs:
  using: composite
  steps:
    - id: probe
      run: ./probe.sh
      shell: bash
    - if: steps.probe.outputs.hit == 'true'
      run: echo hit
      shell: bash
`,
};

describe('assume pins for step and job unknowns', () => {
  it('pins a leg’s step output with the leg in matrix:, a value with a / included, and names its producer', () => {
    const p = plan(matrix);
    for (const node of ['lts/*', '22']) {
      const step = `${CI}#test[node=${node}]/steps.v`;
      const u = unknownOf(p, `${step}.outputs.ok`);
      expect(u).toMatchObject({
        kind: 'step-output',
        producer: step,
        affects: [`${CI}#test[node=${node}]/~echo-ok`],
      });
      expect(u.pin).toEqual({
        layer: 'assume',
        fragment: { step: 'test.v', matrix: { node }, outputs: { ok: '' } },
        at: ['assume'],
      });
    }
    expectEveryPinApplies(matrix);
  });

  it('pins a $GITHUB_ENV write as kind env, and drops it from the unknowns once pinned', () => {
    const p = plan(matrix);
    const u = unknownOf(p, `${CI}#stamp/steps.w.env.STAMP`);
    expect(u).toMatchObject({ kind: 'env', producer: `${CI}#stamp/steps.w` });
    expect(u.pin?.fragment).toEqual({ step: 'stamp.w', env: { STAMP: '' } });
    const pinned = plan(matrix, [{ step: 'stamp.w', env: { STAMP: 'now' } }]);
    expect(pinned.unknowns.map((x) => x.id)).not.toContain(u.id);
  });

  it('keeps a calling leg and a composite action step’s leg in the path, and pins none it cannot write', () => {
    const p = plan(nested);
    const called = unknownOf(p, `${CI}#call[target=a]>.github/workflows/callee.yml#x/steps.d.outputs.go`);
    expect(called.pin?.fragment).toEqual({ step: 'call[target=a]/x.d', outputs: { go: '' } });
    // `[target=b/c]` cannot be read back from a path, and matrix: reaches only the last segment's leg.
    const slashed = unknownOf(p, `${CI}#call[target=b/c]>.github/workflows/callee.yml#x/steps.d.outputs.go`);
    expect(slashed.producer).toBe(`${CI}#call[target=b/c]>.github/workflows/callee.yml#x/steps.d`);
    expect(slashed.pin).toBeUndefined();
    const inner = p.unknowns.find((u) => u.id.endsWith('/steps.probe.outputs.hit'))!;
    expect(inner.pin?.fragment).toEqual({ step: 'comp[os=linux].#2/probe', outputs: { hit: '' } });
    expectEveryPinApplies(nested);
  });

  it('writes workflow: only when another triggered workflow has a job of the same id', () => {
    const files = {
      [CI]: 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - id: d\n        run: echo "v=$(date)" >> "$GITHUB_OUTPUT"\n      - if: steps.d.outputs.v\n        run: echo\n',
      '.github/workflows/other.yml':
        'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
    };
    expect(unknownOf(plan(files), `${CI}#build/steps.d.outputs.v`).pin?.fragment).toEqual({
      workflow: CI,
      step: 'build.d',
      outputs: { v: '' },
    });
    expectEveryPinApplies(files);
    const alone = {
      ...files,
      '.github/workflows/other.yml': files['.github/workflows/other.yml'].replace(
        'on: push',
        'on: pull_request',
      ),
    };
    expect(unknownOf(plan(alone), `${CI}#build/steps.d.outputs.v`).pin?.fragment).toEqual({
      step: 'build.d',
      outputs: { v: '' },
    });
  });

  it('pins a job output a mock holds unknown, per leg, and the fail-fast race in a called workflow', () => {
    const files = {
      [CI]: 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n',
      '.github/workflows/callee.yml': `
on: workflow_call
jobs:
  t:
    runs-on: ubuntu-latest
    outputs:
      v: \${{ steps.s.outputs.v }}
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - id: s
        run: echo "v=1" >> "$GITHUB_OUTPUT"
`,
    };
    const leg = `${CI}#call>.github/workflows/callee.yml#t[n=2]`;
    const held = plan(files, [{ job: 'call/t', matrix: { n: 2 }, outputs: { v: { unknown: true } } }]);
    expect(unknownOf(held, `${leg}.outputs.v`)).toMatchObject({
      kind: 'step-output',
      producer: leg,
      pin: { fragment: { job: 'call/t', matrix: { n: '2' }, outputs: { v: '' } } },
    });
    const failed: AssumeEntry = { step: 'call/t[n=1].s', outcome: 'failure' };
    const race = unknownOf(plan(files, [failed]), `race:fail-fast:${leg}`);
    expect(race).toMatchObject({ kind: 'race', producer: leg });
    expect(race.pin?.fragment).toEqual({ job: 'call/t', matrix: { n: '2' }, outcome: 'cancelled' });
    const decided = plan(files, [failed, race.pin!.fragment as AssumeEntry]);
    expect(decided.unknowns.map((u) => u.id)).not.toContain(race.id);
    expect(decided.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('pins step unknowns of a plan without steps too', () => {
    const u = unknownOf(plan(matrix, [], 'legs'), `${CI}#test[node=22]/steps.v.outputs.ok`);
    expect(u.pin?.fragment).toEqual({ step: 'test.v', matrix: { node: '22' }, outputs: { ok: '' } });
  });
});

describe('assumePins over a plan', () => {
  const site = (chain: UnitSite['location']['chain'], kind: UnitSite['kind']): UnitSite => ({
    location: { workflow: 'w.yml', chain },
    kind,
  });
  const units = new Map<string, UnitSite>([
    [
      'w.yml#j/steps.s',
      site(
        [
          { kind: 'job', id: 'j' },
          { kind: 'step', id: 's', index: 1 },
        ],
        'step',
      ),
    ],
    [
      'w.yml#j/~odd',
      site(
        [
          { kind: 'job', id: 'j' },
          { kind: 'step', id: '1st', index: 2 },
        ],
        'step',
      ),
    ],
    ['w.yml#j', site([{ kind: 'job', id: 'j' }], 'job')],
  ]);
  const pinsOf = (...ids: string[]) => {
    const p = {
      workflows: [],
      unknowns: ids.map((id) => ({ id, kind: 'unsupported', reads: [], affects: [] })),
    };
    assumePins(p as unknown as RunPlan, units);
    return p.unknowns.map((u) => [
      (u as { producer?: string }).producer,
      (u as { pin?: { fragment: Json } }).pin?.fragment,
    ]);
  };

  it('pins an outcome as failure, an id a path cannot hold by position, and no env write on a job', () => {
    expect(
      pinsOf('w.yml#j/steps.s.outcome', 'w.yml#j/~odd.outputs.o', 'w.yml#j.outcome', 'w.yml#j.env.X'),
    ).toEqual([
      ['w.yml#j/steps.s', { step: 'j.s', outcome: 'failure' }],
      ['w.yml#j/~odd', { step: 'j.#2', outputs: { o: '' } }],
      ['w.yml#j', { job: 'j', outcome: 'failure' }],
      ['w.yml#j', undefined],
    ]);
  });

  it('leaves a conflict, another race, a field it does not know and a node it did not plan alone', () => {
    expect(
      pinsOf(
        'conflict:w.yml#j/steps.s.outputs.o',
        'race:matrix-outputs:w.yml#j.o',
        'w.yml#j/steps.s.conclusion',
        'w.yml#k.outputs.o',
      ),
    ).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});
