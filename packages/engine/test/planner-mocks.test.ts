import { MocksError, type RunPlan, type ScenarioInput, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const run = (
  yaml: string,
  scenario: ScenarioInput,
  assume: unknown[],
  extra: Record<string, string> = {},
): RunPlan =>
  simulate({ files: { '.github/workflows/ci.yml': yaml, ...extra }, scenario, assume: assume as never });

const jobs = (plan: RunPlan) =>
  Object.fromEntries(
    plan.workflows.flatMap((w) =>
      w.jobs.map((j) => [
        j.jobId,
        { runs: j.runs.verdict, result: j.result.known ? j.result.value : j.result },
      ]),
    ),
  );
const codes = (plan: RunPlan) => plan.diagnostics.map((d) => d.code);

const pipeline = `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: unit
        run: npm test
      - id: coverage
        if: always()
        run: echo "pct=90" >> "$GITHUB_OUTPUT"
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps: [{ run: echo deploy }]
  notify:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps: [{ run: echo notify }]
`;

describe('assume: step outcomes', () => {
  it('a failing step fails the job, skips dependents and is recorded as applied (lab 1, 4)', () => {
    const plan = run(pipeline, { event: 'push' }, [{ step: 'test.unit', outcome: 'failure' }]);
    expect(jobs(plan)).toEqual({
      test: { runs: 'yes', result: 'failure' },
      deploy: { runs: 'no', result: 'skipped' },
      notify: { runs: 'yes', result: 'success' },
    });
    const steps = plan.workflows[0]!.jobs[0]!.legs[0]!.steps!;
    expect(steps[0]!.outcome).toEqual({ known: true, value: 'failure' });
    expect(steps[1]!.runs.verdict).toBe('yes');
    expect(plan.mocks).toEqual([
      { ref: 'assume[0]', layer: 'case', at: steps[0]!.id, provides: ['outcome'] },
    ]);
    expect(codes(plan)).toEqual([]);
  });

  it('keeps outcome and conclusion apart under continue-on-error (lab 5)', () => {
    const plan = run(
      `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: f
        continue-on-error: true
        run: exit 1
      - if: failure()
        run: echo failed
      - if: success()
        run: echo ok
`,
      { event: 'push' },
      [{ step: 'a.f', outcome: 'failure' }],
    );
    const steps = plan.workflows[0]!.jobs[0]!.legs[0]!.steps!;
    expect(steps[0]!.outcome).toEqual({ known: true, value: 'failure' });
    expect(steps[0]!.conclusion).toEqual({ known: true, value: 'success' });
    expect(steps.map((s) => s.runs.verdict)).toEqual(['yes', 'no', 'yes']);
    expect(jobs(plan).a).toEqual({ runs: 'yes', result: 'success' });
  });

  it('addresses id-less steps by position, matrix legs by value, and cancels fail-fast siblings as a race (lab 6, 14)', () => {
    const plan = run(
      `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3]
    steps:
      - name: leg
        run: ./leg.sh
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  c:
    needs: a
    if: cancelled()
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`,
      { event: 'push' },
      [{ step: 'a[n=2].#1', outcome: 'failure' }],
    );
    const a = plan.workflows[0]!.jobs[0]!;
    expect(a.legs.map((l) => (l.result.known ? l.result.value : l.result.oneOf))).toEqual([
      ['success', 'cancelled'],
      'failure',
      ['success', 'cancelled'],
    ]);
    // A cancelled leg's step may have finished first: its conclusion is the leg's race.
    expect(a.legs.map((l) => l.steps![0]!.conclusion)).toEqual([
      {
        known: false,
        unknowns: ['race:fail-fast:.github/workflows/ci.yml#a[n=1]'],
        oneOf: ['success', 'cancelled'],
      },
      { known: true, value: 'failure' },
      {
        known: false,
        unknowns: ['race:fail-fast:.github/workflows/ci.yml#a[n=3]'],
        oneOf: ['success', 'cancelled'],
      },
    ]);
    expect(jobs(plan)).toMatchObject({ a: { result: 'failure' }, b: { runs: 'no' }, c: { runs: 'no' } });
    const race = plan.unknowns.find((u) => u.id.startsWith('race:fail-fast:'))!;
    expect(race.pin).toEqual({
      layer: 'assume',
      fragment: { job: 'a', matrix: { n: '1' }, outcome: 'cancelled' },
      at: ['assume'],
    });
  });

  it('applies a job-level outcome at the job boundary and says so (SC108)', () => {
    const plan = run(pipeline, { event: 'push' }, [{ job: 'test', outcome: 'failure' }]);
    expect(jobs(plan)).toMatchObject({
      test: { result: 'failure' },
      deploy: { runs: 'no' },
      notify: { runs: 'yes' },
    });
    expect(plan.workflows[0]!.jobs[0]!.legs[0]!.steps!.map((s) => s.outcome)).toEqual([
      { known: true, value: 'success' },
      { known: true, value: 'success' },
    ]);
    expect(plan.diagnostics).toEqual([expect.objectContaining({ code: 'SC108', severity: 'info' })]);
  });
});

describe('assume: jobs and their legs', () => {
  const legs = `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    outputs:
      v: \${{ steps.s.outputs.v }}
    strategy:
      matrix:
        n: [1, 2, 3]
    steps:
      - id: s
        run: ./leg.sh
  b:
    needs: a
    if: needs.a.outputs.v == 'x'
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;
  const legResults = (plan: RunPlan) =>
    plan.workflows[0]!.jobs[0]!.legs.map((l) => (l.result.known ? l.result.value : l.result.oneOf));

  it('applies a job entry naming a leg, by [k=v] or matrix:, to that leg alone, and says SC108 once', () => {
    for (const entry of [
      { job: 'a[n=2]', outcome: 'failure' },
      { job: 'a', matrix: { n: 2 }, outcome: 'failure' },
    ]) {
      const plan = run(legs, { event: 'push' }, [entry]);
      expect(legResults(plan)).toEqual([['success', 'cancelled'], 'failure', ['success', 'cancelled']]);
      expect(jobs(plan).a).toEqual({ runs: 'yes', result: 'failure' });
      expect(plan.mocks).toEqual([
        { ref: 'assume[0]', layer: 'case', at: '.github/workflows/ci.yml#a[n=2]', provides: ['outcome'] },
      ]);
      expect(codes(plan)).toEqual(['SC108']);
    }
    const all = run(legs, { event: 'push' }, [{ job: 'a', outcome: 'failure' }]);
    expect(legResults(all)).toEqual(['failure', 'failure', 'failure']);
    expect(codes(all)).toEqual(['SC108']);
  });

  it('decides a fail-fast race by its own pin, leaving the other leg’s race open', () => {
    const failed = { step: 'a[n=2].s', outcome: 'failure' };
    const race = run(legs, { event: 'push' }, [failed]).unknowns.find((u) => u.id.endsWith('#a[n=1]'))!;
    expect(race.pin?.fragment).toEqual({ job: 'a', matrix: { n: '1' }, outcome: 'cancelled' });
    const plan = run(legs, { event: 'push' }, [failed, race.pin!.fragment]);
    expect(legResults(plan)).toEqual(['cancelled', 'failure', ['success', 'cancelled']]);
    const races = plan.unknowns.filter((u) => u.kind === 'race').map((u) => u.id);
    expect(races).toEqual(['race:fail-fast:.github/workflows/ci.yml#a[n=3]']);
    expect(codes(plan)).toEqual(['SC108']);
  });

  it('overlays a job entry’s outputs on every leg it names, keeping the mock as their source, and says SC101 once', () => {
    const plan = run(legs, { event: 'push' }, [{ job: 'a', outputs: { v: 'x' } }]);
    expect(plan.workflows[0]!.jobs[0]!.outputs.v).toEqual({ known: true, value: 'x', by: 'assume[0]' });
    expect(jobs(plan).b!.runs).toBe('yes');
    expect(plan.mocks.map((m) => m.at)).toEqual(
      ['1', '2', '3'].map((n) => `.github/workflows/ci.yml#a[n=${n}]`),
    );
    // One leg's value: the others are unknown, and the last to finish wins.
    const one = run(legs, { event: 'push' }, [{ job: 'a', matrix: { n: 1 }, outputs: { v: 'x' } }]);
    expect(jobs(one).b!.runs).toBe('maybe');
    const undeclared = run(legs, { event: 'push' }, [{ job: 'a', outputs: { w: 'x' } }]);
    expect(codes(undeclared)).toEqual(['SC101']);
  });

  it('overlays a calling job’s outputs without touching the called workflow’s', () => {
    const plan = run(
      'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n',
      { event: 'push' },
      [{ job: 'call', outputs: { o: 'mocked' } }],
      {
        '.github/workflows/callee.yml':
          'on:\n  workflow_call:\n    outputs:\n      o:\n        value: from-callee\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
      },
    );
    const call = plan.workflows.find((w) => w.path === '.github/workflows/ci.yml')!.jobs[0]!;
    expect(call.outputs.o).toEqual({ known: true, value: 'mocked', by: 'assume[0]' });
    expect(call.legs[0]!.call!.outputs.o).toEqual({ known: true, value: 'from-callee' });
  });
});

describe('assume: outputs and env', () => {
  const gated = `
on: push
jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      changed: \${{ steps.d.outputs.changed }}
    steps:
      - id: d
        run: ./detect.sh
      - id: w
        run: echo "x=1" >> "$GITHUB_OUTPUT"
      - run: echo "$MODE"
        if: env.MODE == 'ci'
  build:
    needs: detect
    if: needs.detect.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;

  it('pins a script output, which decides the dependent job', () => {
    expect(jobs(run(gated, { event: 'push' }, [])).build!.runs).toBe('maybe');
    const plan = run(gated, { event: 'push' }, [{ step: 'detect.d', outputs: { changed: 'true' } }]);
    expect(jobs(plan).build).toEqual({ runs: 'yes', result: 'success' });
    expect(plan.workflows[0]!.jobs[0]!.outputs.changed).toEqual({ known: true, value: 'true' });
    expect(
      run(gated, { event: 'push' }, [{ step: 'detect.d', outputs: { changed: 'false' } }]).workflows[0]!
        .jobs[1]!.runs.verdict,
    ).toBe('no');
  });

  it('accepts any name on an open script, refuses one a closed interface lacks (SC101), and un-pins with unknown', () => {
    const open = run(gated, { event: 'push' }, [{ step: 'detect.d', outputs: { other: 'x' } }]);
    expect(codes(open)).toEqual([]);
    const closed = run(gated, { event: 'push' }, [{ step: 'detect.w', outputs: { y: '2' } }]);
    expect(closed.diagnostics[0]).toMatchObject({ code: 'SC101', severity: 'error' });
    expect(closed.diagnostics[0]!.message).toContain(
      "sets output 'y', which the script does not declare (it declares x)",
    );
    const unpinned = run(gated, { event: 'push' }, [{ step: 'detect.w', outputs: { x: { unknown: true } } }]);
    expect(unpinned.workflows[0]!.jobs[0]!.legs[0]!.steps![1]!.outputs.x).toEqual({
      known: false,
      unknowns: [`${unpinned.workflows[0]!.jobs[0]!.legs[0]!.steps![1]!.id}.outputs.x`],
    });
  });

  it('writes env for the steps after the mocked one', () => {
    const plan = run(gated, { event: 'push' }, [{ step: 'detect.d', env: { MODE: 'ci' } }]);
    const steps = plan.workflows[0]!.jobs[0]!.legs[0]!.steps!;
    expect(steps[2]!.runs.verdict).toBe('yes');
    expect(run(gated, { event: 'push' }, []).workflows[0]!.jobs[0]!.legs[0]!.steps![2]!.runs.verdict).toBe(
      'no',
    );
  });

  it('matches every step a uses: pattern names, within a job scope when given', () => {
    const plan = run(
      `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache@v4
        with: { path: ~/.npm, key: x }
      - if: steps.cache.outputs.cache-hit != 'true'
        run: npm ci
  other:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache/restore@v4
        with: { path: ~/.npm, key: x }
      - if: steps.cache.outputs.cache-hit != 'true'
        run: npm ci
`,
      { event: 'push' },
      [
        { uses: 'actions/cache', outputs: { 'cache-hit': 'true' } },
        { uses: 'actions/cache', job: 'other', outputs: { 'cache-hit': '' } },
      ],
    );
    const [build, other] = plan.workflows[0]!.jobs;
    expect(build!.legs[0]!.steps![1]!.runs.verdict).toBe('no');
    expect(other!.legs[0]!.steps![1]!.runs.verdict).toBe('yes');
    // The shipped actions/cache model is the layer under the author's entries: it values what they do not.
    expect(plan.mocks.map((m) => [m.ref, m.layer, m.provides])).toEqual([
      ['assume[0]', 'case', ['outputs.cache-hit']],
      ['model:actions/cache', 'shipped', ['outputs.cache-primary-key', 'outputs.cache-matched-key']],
      ['assume[1]', 'case', ['outputs.cache-hit']],
      ['model:actions/cache', 'shipped', ['outputs.cache-primary-key', 'outputs.cache-matched-key']],
    ]);
  });
});

describe('assume: uses: entries naming reusable workflow calls', () => {
  const calls = `
on: push
jobs:
  stage:
    uses: octo/ship/.github/workflows/deploy.yml@v1
  prod:
    uses: octo/ship/.github/workflows/deploy.yml@v2
  local:
    uses: ./.github/workflows/callee.yml
  smoke:
    needs: [stage, prod]
    if: needs.stage.outputs.url != '' && needs.prod.outputs.url != ''
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;
  const callee = {
    '.github/workflows/callee.yml':
      'on:\n  workflow_call:\n    outputs:\n      o:\n        value: from-callee\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
  };
  const plan = (assume: unknown[]) => run(calls, { event: 'push' }, assume, callee);
  const ci = (p: RunPlan) => p.workflows.find((w) => w.path === '.github/workflows/ci.yml')!;
  const job = (p: RunPlan, id: string) => ci(p).jobs.find((j) => j.jobId === id)!;
  const notUnsupported = (p: RunPlan) => codes(p).filter((c) => c !== 'unsupported');

  it('mocks every call to a remote workflow, any ref without @, that ref alone with it', () => {
    const every = plan([
      { uses: 'octo/ship/.github/workflows/deploy.yml', outcome: 'success', outputs: { url: 'https://x' } },
    ]);
    expect(job(every, 'stage').outputs.url).toEqual({ known: true, value: 'https://x', by: 'assume[0]' });
    expect(job(every, 'prod').outputs.url).toEqual({ known: true, value: 'https://x', by: 'assume[0]' });
    expect(job(every, 'smoke').runs.verdict).toBe('yes');
    expect(every.mocks.map((m) => m.at)).toEqual([
      '.github/workflows/ci.yml#stage',
      '.github/workflows/ci.yml#prod',
    ]);
    // Was SC102: a uses: entry matched steps only.
    expect(notUnsupported(every)).toEqual([]);

    const pinned = plan([
      {
        uses: 'octo/ship/.github/workflows/deploy.yml@v1',
        outcome: 'success',
        outputs: { url: 'https://x' },
      },
    ]);
    expect(job(pinned, 'stage').outputs.url).toMatchObject({ known: true, value: 'https://x' });
    // The other ref is unmocked, so smoke reads its output as unknown.
    expect(job(pinned, 'prod').outputs.url).toBeUndefined();
    expect(job(pinned, 'smoke').runs.verdict).toBe('maybe');
    expect(pinned.unknowns.map((u) => u.id)).toContain('.github/workflows/ci.yml#prod.outputs.url');
  });

  it('sets a remote call’s outcome, which drops its call unknown, and matches a local call by its path', () => {
    const failed = plan([{ uses: 'octo/ship/.github/workflows/deploy.yml@v2', outcome: 'failure' }]);
    expect(jobs(failed).prod).toEqual({ runs: 'yes', result: 'failure' });
    expect(jobs(failed).smoke!.runs).toBe('no');
    expect(failed.unknowns.map((u) => u.id)).not.toContain('.github/workflows/ci.yml#prod.call');
    expect(failed.unknowns.map((u) => u.id)).toContain('.github/workflows/ci.yml#stage.call');

    const local = plan([{ uses: './.github/workflows/callee.yml', outputs: { o: 'mocked' } }]);
    expect(job(local, 'local').outputs.o).toEqual({ known: true, value: 'mocked', by: 'assume[0]' });
    expect(job(local, 'local').legs[0]!.call!.outputs.o).toEqual({ known: true, value: 'from-callee' });
    expect(notUnsupported(local)).toEqual([]);
    // A loaded callee's interface is closed.
    expect(notUnsupported(plan([{ uses: './.github/workflows/callee.yml', outputs: { p: 'x' } }]))).toEqual([
      'SC101',
    ]);
  });

  it('ranks a job: entry over a uses: entry scoped to the job, and that over a bare uses: entry', () => {
    const p = plan([
      { uses: 'octo/ship/.github/workflows/deploy.yml', outcome: 'failure' },
      { uses: 'octo/ship/.github/workflows/deploy.yml', job: 'stage', outcome: 'success' },
      { job: 'prod', outcome: 'success' },
    ]);
    expect(jobs(p).stage).toEqual({ runs: 'yes', result: 'success' });
    expect(jobs(p).prod).toEqual({ runs: 'yes', result: 'success' });
    expect(p.mocks.map((m) => [m.ref, m.at])).toEqual([
      ['assume[1]', '.github/workflows/ci.yml#stage'],
      ['assume[2]', '.github/workflows/ci.yml#prod'],
    ]);
    expect(notUnsupported(p)).toEqual([]);
  });

  it('still reports a uses: entry that names no call or step (SC102)', () => {
    const p = plan([{ uses: 'octo/ship/.github/workflows/release.yml', outcome: 'failure' }]);
    expect(notUnsupported(p)).toEqual(['SC102']);
  });
});

describe('assume: validation', () => {
  it('reports entries that match nothing (SC102) and conflicts (SC103), and rejects malformed entries', () => {
    const plan = run(pipeline, { event: 'push' }, [
      { step: 'test.nope', outcome: 'failure' },
      { step: 'test.unit', outcome: 'failure' },
      { step: 'test.unit', outcome: 'success' },
    ]);
    expect(codes(plan).sort()).toEqual(['SC102', 'SC103']);
    expect(plan.workflows[0]!.jobs[0]!.legs[0]!.steps![0]!.outcome).toEqual({
      known: false,
      unknowns: [expect.stringMatching(/^conflict:.*\.outcome$/)],
    });
    expect(() => run(pipeline, { event: 'push' }, [{ step: 'test.unit', conclusion: 'failure' }])).toThrow(
      MocksError,
    );
    expect(() => run(pipeline, { event: 'push' }, [{ step: 'test.unit' }])).toThrow(MocksError);
  });

  it('reaches steps of reusable workflows and composite actions through nested paths', () => {
    const plan = run(
      `
on: push
jobs:
  call:
    uses: ./.github/workflows/callee.yml
  comp:
    runs-on: ubuntu-latest
    steps:
      - id: c
        uses: ./.github/actions/comp
      - if: steps.c.outcome == 'failure'
        run: echo inner failed
`,
      { event: 'push' },
      [
        { step: 'call/x.t', outcome: 'failure' },
        { step: 'comp.c/#1', outcome: 'failure' },
      ],
      {
        '.github/workflows/callee.yml':
          'on: workflow_call\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - id: t\n        run: npm test\n',
        '.github/actions/comp/action.yml':
          'name: c\nruns:\n  using: composite\n  steps:\n    - run: exit 1\n      shell: bash\n    - if: failure()\n      run: echo\n      shell: bash\n',
      },
    );
    const [call, comp] = plan.workflows.find((w) => w.path === '.github/workflows/ci.yml')!.jobs;
    expect(call!.result).toEqual({ known: true, value: 'failure' });
    expect(call!.legs[0]!.call!.jobs[0]!.result).toEqual({ known: true, value: 'failure' });
    const c = comp!.legs[0]!.steps![0]!;
    expect(c.composite!.steps.map((s) => [s.runs.verdict, s.outcome])).toEqual([
      ['yes', { known: true, value: 'failure' }],
      ['yes', { known: true, value: 'success' }],
    ]);
    expect(c.outcome).toEqual({ known: true, value: 'failure' });
    expect(comp!.legs[0]!.steps![1]!.runs.verdict).toBe('no');
    expect(codes(plan)).toEqual([]);
  });
});

describe('folded script writes', () => {
  it('knows literal outputs and env, last write winning, and a conditional one as candidates (lab 8, 11)', () => {
    const plan = run(
      `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    outputs:
      k: \${{ steps.w.outputs.k }}
      m: \${{ steps.w.outputs.m }}
    steps:
      - id: w
        run: |
          echo "k=first" >> "$GITHUB_OUTPUT"
          echo "k=second" >> "$GITHUB_OUTPUT"
          {
            echo "m<<EOF"
            echo "line one"
            echo "line two"
            echo "EOF"
          } >> "$GITHUB_OUTPUT"
          echo "MODE=ci" >> "$GITHUB_ENV"
      - if: env.MODE == 'ci' && steps.w.outputs.k == 'second'
        run: echo gated
  b:
    needs: a
    if: needs.a.outputs.k == 'second' && contains(needs.a.outputs.m, 'two')
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - id: v
        run: |
          if [ "\${{ matrix.n }}" = "2" ]; then
            echo "v=" >> "$GITHUB_OUTPUT"
          else
            echo "v=\${{ matrix.n }}" >> "$GITHUB_OUTPUT"
          fi
          echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - if: steps.v.outputs.v == ''
        run: echo empty
`,
      { event: 'push' },
      [],
    );
    const [a, b] = plan.workflows[0]!.jobs;
    expect(a!.outputs).toEqual({
      k: { known: true, value: 'second' },
      m: { known: true, value: 'line one\nline two' },
    });
    expect(a!.legs[0]!.steps![1]!.runs.verdict).toBe('yes');
    expect(b!.runs.verdict).toBe('yes');
    const [leg1, leg2] = b!.legs;
    expect(leg1!.steps![0]!.outputs.v).toEqual({
      known: false,
      unknowns: [`${leg1!.steps![0]!.id}.outputs.v`],
      oneOf: ['', '1'],
    });
    expect(leg2!.steps![0]!.outputs.v).toEqual({
      known: false,
      unknowns: [`${leg2!.steps![0]!.id}.outputs.v`],
      oneOf: ['', '2'],
    });
    expect(leg1!.steps![0]!.outputs.sha).toEqual({
      known: false,
      unknowns: [`${leg1!.steps![0]!.id}.outputs.sha`],
    });
    expect(leg1!.steps![1]!.runs.verdict).toBe('maybe');
    expect(
      run(
        `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: v
        run: echo "v=\${{ github.event_name }}" >> "$GITHUB_OUTPUT"
      - if: steps.v.outputs.v == 'push'
        run: echo
`,
        { event: 'push' },
        [],
      ).workflows[0]!.jobs[0]!.legs[0]!.steps![1]!.runs.verdict,
    ).toBe('yes');
  });
});
