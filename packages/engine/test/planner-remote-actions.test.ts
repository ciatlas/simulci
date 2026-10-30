import {
  type ActionModel,
  type AssumeEntry,
  type ModelContext,
  type RemoteInputs,
  type RemoteSourceInput,
  type RunPlan,
  SHIPPED_MODELS,
  simulate,
  type StepPlan,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const CI = '.github/workflows/ci.yml';
const SHA = 'a'.repeat(40);
const COMPOSITE = 'octo/kit/setup@v2';
const NODE = 'octo/kit/build@v2';

const composite = `
outputs:
  version:
    value: \${{ steps.v.outputs.version }}
runs:
  using: composite
  steps:
    - id: v
      run: echo "version=1.2" >> "$GITHUB_OUTPUT"
      shell: bash
`;
const node = `
outputs:
  artifact: { description: the path }
runs:
  using: node24
  main: index.js
`;

const action = (ref: string, text: string): RemoteSourceInput => ({
  ref,
  kind: 'action',
  sha: SHA,
  text,
  pinned: 'lockfile',
});

/** A job that uses `uses` as step `a`, then reads its output `name` in an `if:`. */
const reading = (uses: string, name: string) => `
on: push
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - id: a
        uses: ${uses}
      - id: b
        if: steps.a.outputs.${name} == '1.2'
        run: echo
`;

const plan = (
  yaml: string,
  remotes: RemoteInputs,
  assume: AssumeEntry[] = [],
  models = SHIPPED_MODELS,
): RunPlan => simulate({ files: { [CI]: yaml }, scenario: { event: 'push' }, remotes, assume, models });

const steps = (p: RunPlan): StepPlan[] => p.workflows[0]!.jobs[0]!.legs[0]!.steps!;
const codes = (p: RunPlan) => p.diagnostics.map((d) => d.code);

describe('a remote composite action a host read', () => {
  const remotes = { sources: [action(COMPOSITE, composite)] };

  it('is planned from its steps, under the step, by the ref as written', () => {
    const [a, b] = steps(plan(reading(COMPOSITE, 'version'), remotes));
    expect(a!.composite).toMatchObject({
      id: `${CI}#x/steps.a>${COMPOSITE}`,
      path: COMPOSITE,
      outputs: { version: { known: true, value: '1.2' } },
    });
    expect(a!.composite!.steps[0]!.id).toBe(`${CI}#x/steps.a>${COMPOSITE}/steps.v`);
    expect(b!.runs.verdict).toBe('yes');
  });

  it('exposes only its declared outputs, and refuses a mock that sets another (lab R8)', () => {
    const p = plan(reading(COMPOSITE, 'extra'), remotes);
    expect(steps(p)[1]!.runs.verdict).toBe('no');
    const mocked = plan(reading(COMPOSITE, 'version'), remotes, [
      { uses: COMPOSITE, outputs: { extra: 'x' } },
    ]);
    expect(mocked.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SC101',
        message: `assume[0] sets output 'extra', which action ${COMPOSITE} does not declare (it declares version)`,
      }),
    ]);
  });

  it('reads its own $/ at its commit and its ./ in the job’s workspace', () => {
    const outer = `
runs:
  using: composite
  steps:
    - uses: $/inner
    - uses: ./local
`;
    const inner = 'runs:\n  using: composite\n  steps: [{ run: echo inner, shell: bash }]\n';
    const p = plan(reading(COMPOSITE, 'x'), {
      sources: [action(COMPOSITE, outer), { ...action(`octo/kit/inner@${SHA}`, inner), pinned: 'parent' }],
    });
    const [self, local] = steps(p)[0]!.composite!.steps;
    expect(self!.composite?.path).toBe('octo/kit/inner@v2');
    expect(local!.composite).toBeUndefined();
    expect(p.remotes!.map((r) => [r.ref, r.pinned])).toEqual([
      ['octo/kit/inner@v2', 'parent'],
      [COMPOSITE, 'lockfile'],
    ]);
  });

  it('stops at a composite that uses itself, with a warning, local or remote', () => {
    const self = 'runs:\n  using: composite\n  steps: [{ uses: $/setup }]\n';
    const p = plan(reading(COMPOSITE, 'x'), {
      sources: [action(COMPOSITE, self), { ...action(`octo/kit/setup@${SHA}`, self), pinned: 'parent' }],
    });
    expect(codes(p)).toEqual(['unsupported']);
    const local = simulate({
      files: {
        [CI]: reading('./.github/actions/a', 'x'),
        '.github/actions/a/action.yml':
          'runs:\n  using: composite\n  steps: [{ uses: ./.github/actions/a }]\n',
      },
      scenario: { event: 'push' },
    });
    expect(local.diagnostics.map((d) => d.message)).toEqual([
      '.github/actions/a: a composite action that uses itself is not planned',
    ]);
    expect(steps(local)[0]!.composite!.steps[0]!.composite).toBeUndefined();
  });
});

describe('a remote node or docker action a host read', () => {
  const remotes = { sources: [action(NODE, node)] };

  it('may set outputs it does not declare: they read as unknown, and a mock may set them (lab R4)', () => {
    const p = plan(reading(NODE, 'undeclared'), remotes);
    const [a, b] = steps(p);
    expect(a!.outputs).toEqual({
      artifact: { known: false, unknowns: [`${CI}#x/steps.a.outputs.artifact`] },
    });
    expect(b!.runs.verdict).toBe('maybe');
    expect(p.unknowns.map((u) => u.id)).toContain(`${CI}#x/steps.a.outputs.undeclared`);
    const mocked = plan(reading(NODE, 'undeclared'), remotes, [
      { uses: NODE, outputs: { undeclared: '1.2' } },
    ]);
    expect(mocked.diagnostics).toEqual([]);
    expect(steps(mocked)[1]!.runs.verdict).toBe('yes');
  });

  it('names its model’s outputs too, and gives the model the commit it was read at', () => {
    const seen: ModelContext[] = [];
    const model: ActionModel = {
      id: 'kit-build',
      version: '1',
      matches: (uses) => uses.startsWith('octo/kit/build@'),
      presets: [],
      preset: () => undefined,
      interface: (ctx) => {
        seen.push(ctx);
        return { names: ['digest'], open: false };
      },
      produce: () => ({ outputs: {} }),
    };
    const p = plan(reading(NODE, 'undeclared'), remotes, [], [model]);
    expect(Object.keys(steps(p)[0]!.outputs)).toEqual(['artifact', 'digest']);
    expect(steps(p)[1]!.runs.verdict).toBe('no');
    expect(seen[0]).toMatchObject({ ref: 'v2', sha: SHA });
    const unread = plan(reading(NODE, 'undeclared'), { sources: [] }, [], [model]);
    expect(Object.keys(steps(unread)[0]!.outputs)).toEqual(['digest']);
    expect(seen.at(-1)).not.toHaveProperty('sha');
  });
});

describe('a remote action the host could not read', () => {
  it('is planned as before remotes, with the reason once, and listed', () => {
    const yaml = reading(NODE, 'artifact').replace('      - id: b', `      - uses: ${NODE}\n      - id: b`);
    const failed = plan(yaml, {
      sources: [],
      failed: [{ ref: NODE, kind: 'action', failure: 'not-found', message: 'HTTP 404' }],
    });
    expect(failed.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'remote-fetch-failed',
        message: `${NODE}: not read (not-found): HTTP 404`,
        node: `${CI}#x/steps.a`,
      },
    ]);
    expect(failed.remotes).toEqual([
      {
        ref: NODE,
        kind: 'action',
        state: 'failed',
        at: [`${CI}#x/steps.a`, `${CI}#x/~octo-kit-build`],
        failure: 'not-found',
      },
    ]);
    expect(steps(failed)[2]!.runs.verdict).toBe('maybe');
    const unread = plan(yaml, { sources: [] });
    expect(unread.remotes).toBeUndefined();
    expect(unread.diagnostics).toEqual([]);
  });
});
