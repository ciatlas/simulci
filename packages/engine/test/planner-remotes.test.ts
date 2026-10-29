import { type AssumeEntry, type RunPlan, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const CI = '.github/workflows/ci.yml';
const CALL = `${CI}#call`;

const run = (yaml: string, assume: AssumeEntry[] = []): RunPlan =>
  simulate({ files: { [CI]: yaml }, scenario: { event: 'push', branch: 'main' }, assume });

const job = (plan: RunPlan, id: string) => plan.workflows[0]!.jobs.find((j) => j.jobId === id)!;
const codes = (plan: RunPlan) => plan.diagnostics.map((d) => d.code);
const unknownOf = (plan: RunPlan, id: string) => plan.unknowns.find((u) => u.id === id);

/** A remote reusable workflow the engine does not load, and a job gated on one of its outputs. */
const gated = `
on: push
jobs:
  call:
    uses: octo/ship/.github/workflows/deploy.yml@v1
  after:
    needs: call
    if: needs.call.outputs.released == 'yes'
    runs-on: ubuntu-latest
    steps:
      - run: echo released
      - if: needs.call.outputs.channel != ''
        run: echo "\${{ needs.call.outputs.channel }}"
`;

describe('an unloaded remote reusable workflow', () => {
  it('keeps its warning and its unknown result, pinned by an outcome', () => {
    const plan = run(gated);
    expect(plan.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'unsupported',
        message: 'octo/ship/.github/workflows/deploy.yml@v1: a remote reusable workflow is not loaded',
        node: CALL,
      },
    ]);
    expect(job(plan, 'call').result.known).toBe(false);
    expect(unknownOf(plan, `${CALL}.call`)).toMatchObject({
      kind: 'unsupported',
      pin: { layer: 'assume', fragment: { job: 'call', outcome: 'failure' }, at: ['assume'] },
    });
  });

  it('reads an output it may set as unknown, so a job gated on it may run (bug 1)', () => {
    const plan = run(gated);
    expect(job(plan, 'after').runs.verdict).toBe('maybe');
    expect(unknownOf(plan, `${CALL}.outputs.released`)).toMatchObject({
      kind: 'step-output',
      pin: { layer: 'assume', fragment: { job: 'call', outputs: { released: '' } }, at: ['assume'] },
    });
  });

  it('takes a job mock’s outputs without SC101, and reads the outputs it does not set as unknown (bug 2)', () => {
    const plan = run(gated, [{ job: 'call', outcome: 'success', outputs: { released: 'yes' } }]);
    expect(codes(plan)).toEqual(['unsupported']);
    expect(job(plan, 'call').outputs.released).toEqual({ known: true, value: 'yes', by: 'assume[0]' });
    expect(job(plan, 'after').runs.verdict).toBe('yes');
    expect(unknownOf(plan, `${CALL}.outputs.channel`)).toBeDefined();
    expect(
      run(gated, [{ job: 'call', outputs: { released: 'no' } }]).workflows[0]!.jobs[1]!.runs.verdict,
    ).toBe('no');
  });

  it('offers pins that each decide their unknown alone', () => {
    const pinned = run(gated).unknowns.filter((u) => u.pin?.layer === 'assume');
    expect(pinned.map((u) => u.id).toSorted()).toEqual(
      ['call', 'outputs.channel', 'outputs.released'].map((x) => `${CALL}.${x}`),
    );
    for (const u of pinned) {
      const after = run(gated, [u.pin!.fragment as AssumeEntry]);
      expect(codes(after)).toEqual(['unsupported']);
      expect(after.unknowns.map((x) => x.id)).not.toContain(u.id);
    }
  });

  it('reads every output of a call that is skipped as empty', () => {
    const plan = run(gated.replace('uses: octo', "if: github.event_name == 'pull_request'\n    uses: octo"));
    expect(job(plan, 'call').result).toEqual({ known: true, value: 'skipped' });
    expect(job(plan, 'after').runs.verdict).toBe('no');
    expect(plan.unknowns.map((u) => u.id)).toEqual([]);
  });

  it('names each leg of a matrix call in the unknown its outputs read', () => {
    const plan = run(
      gated.replace('uses: octo', 'strategy:\n      matrix:\n        region: [eu, us]\n    uses: octo'),
      [{ job: 'call', matrix: { region: 'eu' }, outputs: { released: 'yes' } }],
    );
    expect(job(plan, 'after').runs.verdict).toBe('maybe');
    expect(unknownOf(plan, `${CALL}[region=us].outputs.released`)?.pin?.fragment).toEqual({
      job: 'call',
      matrix: { region: 'us' },
      outputs: { released: '' },
    });
    expect(unknownOf(plan, `${CALL}[region=eu].outputs.released`)).toBeUndefined();
  });
});

describe('a loaded reusable workflow', () => {
  it('reads an output it maps from an unloaded call of its own as unknown', () => {
    const files = {
      [CI]: gated.replace('octo/ship/.github/workflows/deploy.yml@v1', './.github/workflows/deploy.yml'),
      '.github/workflows/deploy.yml': `
on:
  workflow_call:
    outputs:
      released:
        value: \${{ jobs.ship.outputs.released }}
jobs:
  ship:
    uses: octo/ship/.github/workflows/deploy.yml@v1
`,
    };
    const plan = simulate({ files, scenario: { event: 'push', branch: 'main' } });
    expect(job(plan, 'after').runs.verdict).toBe('maybe');
    expect(plan.unknowns.map((u) => u.id)).toContain(
      `${CI}#call>.github/workflows/deploy.yml#ship.outputs.released`,
    );
  });

  it('still reads an output it does not declare as empty, and a job mock setting one gets SC101', () => {
    const files = {
      [CI]: gated.replace('octo/ship/.github/workflows/deploy.yml@v1', './.github/workflows/deploy.yml'),
      '.github/workflows/deploy.yml': `
on: workflow_call
jobs:
  ship:
    runs-on: ubuntu-latest
    steps: [{ run: echo ship }]
`,
    };
    const scenario = { event: 'push', branch: 'main' } as const;
    const plan = simulate({ files, scenario });
    expect(job(plan, 'after').runs.verdict).toBe('no');
    const mocked = simulate({ files, scenario, assume: [{ job: 'call', outputs: { released: 'yes' } }] });
    expect(codes(mocked)).toEqual(['SC101']);
  });
});
