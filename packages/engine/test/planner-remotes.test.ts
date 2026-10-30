import {
  type AssumeEntry,
  canonicalize,
  decidingReason,
  loadFiles,
  type RemoteInputs,
  type RemoteSourceInput,
  type RunPlan,
  remotesNeeded,
  renderText,
  restrictPlan,
  runTests,
  selectNodes,
  simulate,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const CI = '.github/workflows/ci.yml';
const CALL = `${CI}#call`;

const run = (yaml: string, assume: AssumeEntry[] = []): RunPlan =>
  simulate({ files: { [CI]: yaml }, scenario: { event: 'push', branch: 'main' }, assume });

const job = (plan: RunPlan, id: string) =>
  plan.workflows.find((w) => w.path === CI)!.jobs.find((j) => j.jobId === id)!;
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

// --- remotes a host read ------------------------------------------------------------------------------------------

const DEPLOY = 'octo/ship/.github/workflows/deploy.yml@v1';
const SHA = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const deploy = `
on:
  workflow_call:
    inputs:
      env: { type: string, required: true }
    outputs:
      released:
        value: \${{ jobs.ship.outputs.released }}
jobs:
  ship:
    runs-on: ubuntu-latest
    outputs:
      released: \${{ steps.go.outputs.released }}
    steps:
      - id: go
        run: echo "released=yes" >> "$GITHUB_OUTPUT"
`;

const caller = `
on: push
jobs:
  call:
    uses: ${DEPLOY}
    with: { env: prod }
  after:
    needs: call
    if: needs.call.outputs.released == 'yes'
    runs-on: ubuntu-latest
    steps: [{ run: echo released }]
`;

const source = (
  ref: string,
  text: string,
  sha = SHA,
  kind: 'workflow' | 'action' = 'workflow',
): RemoteSourceInput => ({
  ref,
  kind,
  sha,
  text,
  pinned: 'lockfile',
});

const SCENARIO = { event: 'push', branch: 'main' } as const;

const planWith = (
  remotes: RemoteInputs,
  files: Record<string, string> = { [CI]: caller },
  repository?: string,
) => simulate({ files, scenario: SCENARIO, remotes, ...(repository ? { repository } : {}) });

const callee = (plan: RunPlan, jobId = 'call') => job(plan, jobId).legs[0]!.call;

describe('a remote reusable workflow a host read', () => {
  it('is planned end to end, as a local one', () => {
    const p = planWith({ sources: [source(DEPLOY, deploy)] });
    const call = job(p, 'call');
    expect(callee(p)).toMatchObject({
      id: `${CI}#call>${DEPLOY}`,
      path: DEPLOY,
      remote: { ref: DEPLOY, sha: SHA },
      caller: CALL,
      depth: 1,
      inputs: { env: { known: true, value: 'prod' } },
      outputs: { released: { known: true, value: 'yes' } },
    });
    expect(callee(p)!.jobs[0]!.id).toBe(`${CALL}>${DEPLOY}#ship`);
    expect(callee(p)!.jobs[0]!.legs[0]!.check).toEqual({ name: 'call / ship', certain: true });
    expect(call.result).toEqual({ known: true, value: 'success' });
    expect(job(p, 'after').runs.verdict).toBe('yes');
    expect(p.diagnostics).toEqual([]);
    expect(p.remotes).toEqual([
      { ref: DEPLOY, kind: 'workflow', state: 'simulated', at: [CALL], sha: SHA, pinned: 'lockfile' },
    ]);
  });

  it('keeps the commit, the pin and the host out of the snapshot profile', () => {
    const p = planWith({ sources: [{ ...source(DEPLOY, deploy), host: 'github.com' }] });
    const snap = canonicalize(p, 'snapshot') as { remotes: unknown };
    expect(snap.remotes).toEqual([{ at: [CALL], kind: 'workflow', ref: DEPLOY, state: 'simulated' }]);
    expect(JSON.stringify(snap)).not.toContain(SHA);
    const hash = JSON.stringify(canonicalize(p, 'hash'));
    expect(hash).toContain(SHA);
    expect(hash).toContain('github.com');
    const moved = planWith({ sources: [{ ...source(DEPLOY, deploy, SHA_B), pinned: 'resolved' }] });
    expect(canonicalize(moved, 'snapshot')).toEqual(
      canonicalize(planWith({ sources: [source(DEPLOY, deploy)] }), 'snapshot'),
    );
  });

  it('takes a uses: mock on the call with the callee’s closed interface', () => {
    const remotes = { sources: [source(DEPLOY, deploy)] };
    const files = { [CI]: caller };
    const off = simulate({
      files,
      scenario: SCENARIO,
      remotes,
      assume: [{ uses: DEPLOY, outputs: { released: 'no' } }],
    });
    expect(job(off, 'after').runs.verdict).toBe('no');
    expect(codes(off)).toEqual([]);
    const extra = simulate({
      files,
      scenario: SCENARIO,
      remotes,
      assume: [{ uses: DEPLOY, outputs: { nope: 'x' } }],
    });
    expect(codes(extra)).toEqual(['SC101']);
  });

  it('gives the same plan whatever order the host read its sources in', () => {
    const build = 'octo/ship/.github/workflows/build.yml@v1';
    const lint = 'octo/lint/.github/workflows/lint.yml@v3';
    const sources = [
      source(DEPLOY, deploy),
      source(build, deploy.replace('released=yes', 'released=built')),
      source(lint, deploy.replace('released=yes', 'released=linted')),
    ];
    const files = {
      [CI]: `${caller}  build:\n    uses: ${build}\n    with: { env: x }\n  lint:\n    uses: ${lint}\n    with: { env: x }\n`,
    };
    const want = JSON.stringify(planWith({ sources }, files));
    for (const order of [
      [2, 1, 0],
      [1, 2, 0],
      [0, 2, 1],
    ]) {
      const shuffled = order.map((i) => sources[i]!);
      expect(JSON.stringify(planWith({ sources: shuffled }, files))).toBe(want);
      const loaded = loadFiles(files, { remotes: { sources: shuffled } });
      const ids = (l: typeof loaded) =>
        [...l.index.project.external!.values()].map((u) => u.sites.map((x) => x.id));
      expect(ids(loaded)).toEqual(ids(loadFiles(files, { remotes: { sources } })));
    }
  });

  it('reads a workflow’s ./ and $/ calls at its own commit, never the caller’s files (lab R2)', () => {
    const outer = `
on: workflow_call
jobs:
  inner:
    uses: ./.github/workflows/build.yml
  self:
    uses: $/.github/workflows/build.yml
`;
    const inner =
      'on: workflow_call\njobs:\n  remote-build:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n';
    const files = {
      [CI]: `on: push\njobs:\n  call:\n    uses: ${DEPLOY}\n`,
      '.github/workflows/build.yml':
        'on: workflow_call\njobs:\n  local-build:\n    runs-on: x\n    steps: [{ run: echo }]\n',
    };
    const atParent = `octo/ship/.github/workflows/build.yml@${SHA}`;
    const p = planWith(
      { sources: [source(DEPLOY, outer), { ...source(atParent, inner), pinned: 'parent' }] },
      files,
    );
    const shown = 'octo/ship/.github/workflows/build.yml@v1';
    for (const id of ['inner', 'self']) {
      const nested = callee(p)!.jobs.find((j) => j.jobId === id)!.legs[0]!.call!;
      expect(nested.id).toBe(`${CALL}>${DEPLOY}#${id}>${shown}`);
      expect(nested.remote).toEqual({ ref: shown, sha: SHA });
      expect(nested.jobs.map((j) => j.jobId)).toEqual(['remote-build']);
      expect(nested.jobs[0]!.legs[0]!.check?.name).toBe(`call / ${id} / remote-build`);
    }
    expect(p.remotes!.map((r) => [r.ref, r.state, r.pinned, r.at])).toEqual([
      [shown, 'simulated', 'parent', [`${CALL}>${DEPLOY}#inner`, `${CALL}>${DEPLOY}#self`]],
      [DEPLOY, 'simulated', 'lockfile', [CALL]],
    ]);
  });

  it('leaves a ./ inside a remote not fetched at its parent’s commit, not at the caller’s file', () => {
    const outer = 'on: workflow_call\njobs:\n  inner:\n    uses: ./.github/workflows/build.yml\n';
    const files = {
      [CI]: `on: push\njobs:\n  call:\n    uses: ${DEPLOY}\n`,
      '.github/workflows/build.yml':
        'on: workflow_call\njobs:\n  local:\n    runs-on: x\n    steps: [{ run: echo }]\n',
    };
    const p = planWith({ sources: [source(DEPLOY, outer)] }, files);
    const inner = callee(p)!.jobs[0]!;
    expect(inner.legs[0]!.call).toBeUndefined();
    expect(inner.result.known).toBe(false);
    expect(p.diagnostics.map((d) => d.message)).toEqual([
      'octo/ship/.github/workflows/build.yml@v1: a remote reusable workflow is not loaded',
    ]);
    const loaded = loadFiles(files, { remotes: { sources: [source(DEPLOY, outer)] } });
    expect(remotesNeeded(loaded, 'lock')).toEqual([
      {
        ref: `octo/ship/.github/workflows/build.yml@${SHA}`,
        kind: 'workflow',
        depth: 2,
        pin: { sha: SHA, pinned: 'parent' },
      },
    ]);
  });

  it('plans a remote step’s ./ as the job’s workspace, opaque and open (lab R3)', () => {
    const outer = `
on: workflow_call
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - id: a
        uses: ./.github/actions/a
      - if: steps.a.outputs.anything == 'y'
        run: echo
`;
    const files = {
      [CI]: `on: push\njobs:\n  call:\n    uses: ${DEPLOY}\n`,
      '.github/actions/a/action.yml': 'runs:\n  using: composite\n  steps: [{ run: echo, shell: bash }]\n',
    };
    const p = planWith({ sources: [source(DEPLOY, outer)] }, files);
    const steps = callee(p)!.jobs[0]!.legs[0]!.steps!;
    expect(steps[0]!.composite).toBeUndefined();
    expect(steps[1]!.runs.verdict).toBe('maybe');
    expect(p.remotes!.map((r) => r.ref)).toEqual([DEPLOY]);
  });

  it('runs a full ref to this repository at its ref, never the working copy (lab R10)', () => {
    const own = 'me/app/.github/workflows/x.yml@main';
    const files = {
      [CI]: `on: push\njobs:\n  call:\n    uses: ${own}\n`,
      '.github/workflows/x.yml':
        'on: workflow_call\njobs:\n  working-copy:\n    runs-on: x\n    steps: [{ run: echo }]\n',
    };
    const notRead = planWith({ sources: [] }, files, 'me/app');
    expect(callee(notRead)).toBeUndefined();
    expect(codes(notRead)).toEqual(['unsupported']);
    expect(notRead.remotes).toEqual([{ ref: own, kind: 'workflow', state: 'not-fetched', at: [CALL] }]);
    const read = planWith(
      {
        sources: [
          source(own, 'on: workflow_call\njobs:\n  at-main:\n    runs-on: x\n    steps: [{ run: echo }]\n'),
        ],
      },
      files,
      'me/app',
    );
    expect(callee(read)!.jobs.map((j) => j.jobId)).toEqual(['at-main']);
    expect(remotesNeeded(loadFiles(files, 'me/app'), 'fetch').map((r) => r.ref)).toEqual([own]);
  });

  it('resolves a same-repository full ref inside a remote to the remote, not to this repository’s action', () => {
    const outer = `
on: workflow_call
jobs:
  x:
    runs-on: ubuntu-latest
    steps: [{ uses: octo/ship/.github/actions/a@v2 }]
`;
    const files = {
      [CI]: `on: push\njobs:\n  call:\n    uses: ${DEPLOY}\n`,
      '.github/actions/a/action.yml': 'runs:\n  using: composite\n  steps: [{ run: echo, shell: bash }]\n',
    };
    const p = planWith({ sources: [source(DEPLOY, outer)] }, files, 'octo/ship');
    expect(callee(p)!.jobs[0]!.legs[0]!.steps![0]!.composite).toBeUndefined();
    const loaded = loadFiles(files, {
      repository: 'octo/ship',
      remotes: { sources: [source(DEPLOY, outer)] },
    });
    expect(remotesNeeded(loaded, 'fetch').map((r) => [r.ref, r.depth])).toEqual([
      ['octo/ship/.github/actions/a@v2', 2],
    ]);
  });

  it('passes inherited secrets to the same owner’s workflow, and none but GITHUB_TOKEN to another’s (lab R6)', () => {
    const reads = `
on: workflow_call
jobs:
  x:
    runs-on: ubuntu-latest
    env:
      KEY: \${{ secrets.DEPLOY_KEY }}
    steps:
      - if: env.KEY != ''
        run: echo
`;
    const yaml = (ref: string) => `on: push\njobs:\n  call:\n    uses: ${ref}\n    secrets: inherit\n`;
    const verdict = (ref: string, repository: string) =>
      callee(
        simulate({
          files: { [CI]: yaml(ref) },
          scenario: { ...SCENARIO, secrets: ['DEPLOY_KEY'] },
          repository,
          remotes: { sources: [source(ref, reads)] },
        }),
      )!.jobs[0]!.legs[0]!.steps![0]!.runs.verdict;
    expect(verdict(DEPLOY, 'octo/app')).toBe('maybe');
    expect(verdict(DEPLOY, 'Octo/app')).toBe('maybe');
    expect(verdict(DEPLOY, 'other/app')).toBe('no');
  });
});

describe('a remote reusable workflow the plan cannot simulate', () => {
  const at = (remotes: RemoteInputs) => planWith(remotes);

  it('says why: not fetched, not read, past a cap, or its file does not parse', () => {
    expect(at({ sources: [] }).remotes).toEqual([
      { ref: DEPLOY, kind: 'workflow', state: 'not-fetched', at: [CALL] },
    ]);
    const failed = at({
      sources: [],
      failed: [{ ref: DEPLOY, kind: 'workflow', failure: 'access', message: 'HTTP 404' }],
    });
    expect(failed.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'remote-fetch-failed',
        message: `${DEPLOY}: not read (access): HTTP 404`,
        node: CALL,
      },
    ]);
    expect(failed.remotes).toEqual([
      { ref: DEPLOY, kind: 'workflow', state: 'failed', at: [CALL], failure: 'access' },
    ]);
    const limited = at({ sources: [], limited: [DEPLOY] });
    expect(codes(limited)).toEqual(['remote-limit']);
    expect(limited.remotes![0]!.state).toBe('limit');
    for (const p of [failed, limited]) {
      expect(job(p, 'after').runs.verdict).toBe('maybe');
      expect(unknownOf(p, `${CALL}.call`)?.pin?.fragment).toEqual({ job: 'call', outcome: 'failure' });
    }
  });

  it('reports a remote’s alias bomb as that remote’s parse error, and leaves the call open', () => {
    const bomb = [
      'on: workflow_call',
      'x0: &a0 [x, x, x, x, x, x, x, x, x, x]',
      ...Array.from(
        { length: 6 },
        (_, i) => `x${i + 1}: &a${i + 1} [${Array(10).fill(`*a${i}`).join(', ')}]`,
      ),
      'jobs:',
      '  x:',
      '    runs-on: ubuntu-latest',
      '    steps: [{ run: echo }]',
    ].join('\n');
    const p = at({ sources: [source(DEPLOY, bomb)] });
    expect(callee(p)).toBeUndefined();
    expect(p.remotes).toEqual([
      { ref: DEPLOY, kind: 'workflow', state: 'invalid', at: [CALL], sha: SHA, pinned: 'lockfile' },
    ]);
    const parse = p.diagnostics.filter((d) => d.code === 'parse');
    expect(parse).toHaveLength(1);
    expect(parse[0]!.message).toMatch(/^octo\/ship\/\.github\/workflows\/deploy\.yml@v1: .*alias bomb/);
    expect(parse[0]!.loc?.file).toBe(DEPLOY);
    expect(job(p, 'after').runs.verdict).toBe('maybe');
  });

  it('names the state in a test’s unexpanded boundary', () => {
    const failed = at({
      sources: [],
      failed: [{ ref: DEPLOY, kind: 'workflow', failure: 'rate-limit', message: '' }],
    });
    expect(selectNodes(failed, 'call/ship', CI).unexpanded).toMatchObject({
      at: CALL,
      reason: 'fetch-failed',
      remote: { ref: DEPLOY, failure: 'rate-limit' },
    });
    expect(selectNodes(at({ sources: [] }), 'call/ship', CI).unexpanded?.reason).toBe('not-fetched');
    expect(selectNodes(at({ sources: [], limited: [DEPLOY] }), 'call/ship', CI).unexpanded?.reason).toBe(
      'limit',
    );
  });
});

describe('a route test across a remote call', () => {
  const headlines = (remotes: RemoteInputs) =>
    runTests(loadFiles({ [CI]: caller }, { remotes }), [
      {
        path: 't.test.yml',
        text: 'workflow: ci.yml\ngiven: { event: push, branch: main }\ncases:\n  - name: c\n    when: {}\n    then: { run: [call/ship] }\n',
      },
    ]).files[0]!.cases[0]!.failures.map((f) => [f.headline].concat(f.detail));

  it('runs into a callee the host read', () => {
    expect(headlines({ sources: [source(DEPLOY, deploy)] })).toEqual([]);
  });

  it('says why a remote callee is not in the plan', () => {
    const fails = (remotes: RemoteInputs) => headlines(remotes)[0]![1];
    expect(fails({ sources: [] })).toBe(
      `the remote workflow 'call' calls (${DEPLOY}) is not fetched, so 'call/ship' is not in the plan`,
    );
    expect(
      fails({ sources: [], failed: [{ ref: DEPLOY, kind: 'workflow', failure: 'access', message: '' }] }),
    ).toBe(
      `the remote workflow 'call' calls (${DEPLOY}) could not be read (access), so 'call/ship' is not in the plan`,
    );
    expect(fails({ sources: [], limited: [DEPLOY] })).toContain('is past the limit on remote files read');
  });
});

describe('the limits GitHub refuses a run at (lab R7)', () => {
  const chain = (n: number): RemoteSourceInput[] =>
    Array.from({ length: n }, (_, i) => {
      const next =
        i + 1 < n
          ? `jobs:\n  next:\n    uses: octo/c/.github/workflows/c${i + 1}.yml@v1\n`
          : 'jobs:\n  leaf:\n    runs-on: x\n    steps: [{ run: echo }]\n';
      return source(`octo/c/.github/workflows/c${i}.yml@v1`, `on: workflow_call\n${next}`);
    });
  const files = { [CI]: 'on: push\njobs:\n  call:\n    uses: octo/c/.github/workflows/c0.yml@v1\n' };

  it('runs ten nested calls and refuses eleven, through remotes', () => {
    const ten = planWith({ sources: chain(10) }, files);
    expect(ten.workflows[0]!.triggered.verdict).toBe('yes');
    let wf = ten.workflows[0]!;
    const names: string[] = [];
    while (wf.jobs[0]!.legs[0]!.call) wf = wf.jobs[0]!.legs[0]!.call!;
    names.push(wf.jobs[0]!.legs[0]!.check!.name);
    expect(names).toEqual([`call${' / next'.repeat(9)} / leaf`]);
    const eleven = planWith({ sources: chain(11) }, files);
    const refused = eleven.workflows[0]!;
    expect(refused.triggered.verdict).toBe('no');
    expect(decidingReason(refused.triggered.chain, 'no')).toEqual({ kind: 'limit', limit: 'nesting' });
    expect(refused.jobs).toEqual([]);
    expect(eleven.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['refused', `GitHub does not start ${CI}: its reusable workflows nest 11 deep, more than 10`],
    ]);
  });

  it('refuses an eleventh call it knows of although the host did not read it', () => {
    const ten = chain(10);
    ten[9] = source(
      'octo/c/.github/workflows/c9.yml@v1',
      'on: workflow_call\njobs:\n  next:\n    uses: octo/c/.github/workflows/c10.yml@v1\n',
    );
    expect(
      planWith({ sources: ten, limited: ['octo/c/.github/workflows/c10.yml@v1'] }, files).workflows[0]!
        .triggered.verdict,
    ).toBe('no');
  });

  it('refuses a cycle of calls, whatever their if:s', () => {
    const self =
      'on:\n  push:\n  workflow_call:\njobs:\n  again:\n    if: false\n    uses: ./.github/workflows/ci.yml\n';
    const p = simulate({ files: { [CI]: self }, scenario: SCENARIO });
    expect(p.workflows[0]!.triggered.verdict).toBe('no');
    expect(p.diagnostics[0]!.message).toBe(
      `GitHub does not start ${CI}: its reusable workflows call each other in a cycle`,
    );
  });

  it('runs 50 distinct called workflows and refuses 51', () => {
    const fan = (n: number) => ({
      [CI]: `on: push\njobs:\n${Array.from({ length: n }, (_, i) => `  c${i}:\n    uses: octo/f/.github/workflows/f${i}.yml@v1\n`).join('')}`,
    });
    expect(planWith({ sources: [] }, fan(50)).workflows[0]!.triggered.verdict).toBe('yes');
    const p = planWith({ sources: [] }, fan(51));
    expect(decidingReason(p.workflows[0]!.triggered.chain, 'no')).toEqual({
      kind: 'limit',
      limit: 'workflows',
    });
    expect(p.diagnostics.filter((d) => d.code === 'refused').map((d) => d.message)).toEqual([
      `GitHub does not start ${CI}: it names 51 reusable workflows, more than 50`,
    ]);
  });
});

describe('remotes and the lockfiles', () => {
  const LOCK = '.github/simulci/remotes.lock.yml';
  const lockFile = (refs: Record<string, string>) =>
    `version: 1\nremotes:\n${Object.entries(refs)
      .map(
        ([r, sha]) =>
          `  ${r}:\n    sha: ${sha}\n    kind: ${r.includes('workflows') ? 'workflow' : 'action'}\n    file: x\n    digest: sha256-${'A'.repeat(43)}=\n`,
      )
      .join('')}`;
  const ACTIONS_LOCK = `version: v0.0.3
workflows:
  .github/workflows/ci.yml:
    - octo/act@v1
dependencies:
  octo/act@v1:
    commit: sha1-${SHA_B}
`;
  const steps = (uses: string) => `    runs-on: ubuntu-latest\n    steps: [{ uses: ${uses} }]\n`;

  it('pins an action with the caller’s actions.lock only where its own workflow runs it', () => {
    const outer = `on: workflow_call\njobs:\n  x:\n${steps('octo/act@v1')}`;
    const files = {
      [CI]: `on: push\njobs:\n  call:\n    uses: ${DEPLOY}\n  local:\n${steps('octo/act@v1')}`,
      '.github/workflows/actions.lock': ACTIONS_LOCK,
    };
    const local = loadFiles(files);
    expect(remotesNeeded(local, 'fetch')).toEqual([
      { ref: 'octo/act@v1', kind: 'action', depth: 1, pin: { sha: SHA_B, pinned: 'actions-lock' } },
      {
        ref: DEPLOY,
        kind: 'workflow',
        depth: 1,
        issue: expect.objectContaining({ code: 'remote-unpinned' }),
      },
    ]);
    const onlyRemote = {
      [CI]: `on: push\njobs:\n  call:\n    uses: ${DEPLOY}\n`,
      '.github/workflows/actions.lock': ACTIONS_LOCK,
    };
    const loaded = loadFiles(onlyRemote, { remotes: { sources: [source(DEPLOY, outer)] } });
    expect(remotesNeeded(loaded, 'fetch').map((r) => [r.ref, r.pin])).toEqual([['octo/act@v1', undefined]]);
    expect(remotesNeeded(loaded, 'lock')).toEqual([]);
    expect(remotesNeeded(loaded, 'off')).toEqual([]);
  });

  it('reads locked refs in lock mode and leaves the rest, with no word when there is no lockfile', () => {
    const files = { [CI]: caller, [LOCK]: lockFile({ [DEPLOY]: SHA }) };
    expect(remotesNeeded(loadFiles(files), 'lock')).toEqual([
      { ref: DEPLOY, kind: 'workflow', depth: 1, pin: { sha: SHA, pinned: 'lockfile' } },
    ]);
    expect(remotesNeeded(loadFiles({ [CI]: caller }), 'lock')).toEqual([]);
    expect(
      remotesNeeded(loadFiles(files, { remotes: { sources: [source(DEPLOY, deploy)] } }), 'lock'),
    ).toEqual([]);
  });

  it('says in the plan which remotes the lockfile lacks', () => {
    const files = {
      [CI]: `${caller}  act:\n${steps('actions/cache@v4')}`,
      [LOCK]: lockFile({ [DEPLOY]: SHA }),
    };
    const p = simulate({ files, scenario: SCENARIO, remotes: { sources: [source(DEPLOY, deploy)] } });
    expect(p.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'remote-not-locked',
        message: 'actions/cache@v4 is not in .github/simulci/remotes.lock.yml',
        node: `${CI}#act/~actions-cache`,
      },
    ]);
    expect(p.remotes!.map((r) => r.ref)).toEqual([DEPLOY]);
    const off = simulate({ files, scenario: SCENARIO });
    expect(codes(off)).toEqual(['unsupported']);
  });
});

describe('one row per remote, with the use that says most about its pin', () => {
  const LOCK = '.github/simulci/remotes.lock.yml';
  const BUILD = 'octo/ship/.github/workflows/build.yml@v1';
  const leaf = 'on: workflow_call\njobs:\n  leaf:\n    runs-on: x\n    steps: [{ run: echo }]\n';
  const actionsLock = (paths: string[]) =>
    `version: v0.0.3\nworkflows:\n${paths.map((p) => `  ${p}:\n    - octo/act@v1\n`).join('')}dependencies:\n  octo/act@v1:\n    commit: sha1-${SHA_B}\n`;
  const usingAct = 'on: push\njobs:\n  x:\n    runs-on: x\n    steps: [{ uses: octo/act@v1 }]\n';

  it('keeps a ./ inside a remote apart from a direct ref shown alike', () => {
    const files = {
      [CI]: `on: push\njobs:\n  call:\n    uses: ${DEPLOY}\n  build:\n    uses: ${BUILD}\n`,
      [LOCK]: `version: 1\nremotes:\n  octo/ship/.github/workflows/build.yml@${SHA}:\n    sha: ${'c'.repeat(40)}\n    kind: workflow\n    file: x\n    digest: sha256-${'A'.repeat(43)}=\n`,
    };
    const outer = 'on: workflow_call\njobs:\n  inner:\n    uses: ./.github/workflows/build.yml\n';
    const p = planWith({ sources: [source(DEPLOY, outer), source(BUILD, leaf, SHA_B)] }, files);
    expect(p.remotes!.map((r) => [r.ref, r.state, r.sha, r.at])).toEqual([
      [BUILD, 'simulated', SHA_B, [`${CI}#build`]],
      [BUILD, 'not-fetched', undefined, [`${CALL}>${DEPLOY}#inner`]],
      [DEPLOY, 'simulated', SHA, [CALL]],
    ]);
    expect(p.diagnostics.filter((d) => d.code === 'remote-pin-mismatch')).toEqual([
      expect.objectContaining({
        node: `${CALL}>${DEPLOY}#inner`,
        message: expect.stringContaining('(its parent)'),
      }),
    ]);
  });

  it('lists case variants of one remote once', () => {
    const files = {
      [CI]: `on: push\njobs:\n  a:\n    uses: Octo/Ship/.github/workflows/deploy.yml@v1\n  b:\n    uses: ${DEPLOY}\n`,
    };
    expect(planWith({ sources: [] }, files).remotes!.map((r) => r.at)).toEqual([[`${CI}#a`, `${CI}#b`]]);
  });

  it('pins an action a covered workflow uses although an uncovered one uses it first', () => {
    const files = {
      '.github/workflows/a.yml': usingAct,
      [CI]: usingAct,
      '.github/workflows/actions.lock': actionsLock([CI]),
    };
    expect(remotesNeeded(loadFiles(files), 'lock')).toEqual([
      { ref: 'octo/act@v1', kind: 'action', depth: 1, pin: { sha: SHA_B, pinned: 'actions-lock' } },
    ]);
  });

  it('pins an action of a local composite under the workflow that runs it', () => {
    const files = {
      [CI]: 'on: push\njobs:\n  x:\n    runs-on: x\n    steps: [{ uses: ./.github/actions/a }]\n',
      '.github/actions/a/action.yml': 'runs:\n  using: composite\n  steps: [{ uses: octo/act@v1 }]\n',
      '.github/workflows/actions.lock': actionsLock([CI]),
      [LOCK]: `version: 1\nremotes:\n  octo/act@v1:\n    sha: ${SHA}\n    kind: action\n    file: action.yml\n    digest: sha256-${'A'.repeat(43)}=\n`,
    };
    expect(remotesNeeded(loadFiles(files), 'lock').map((r) => r.pin)).toEqual([
      { sha: SHA_B, pinned: 'actions-lock' },
    ]);
    const p = planWith({ sources: [] }, files);
    expect(p.diagnostics.map((d) => [d.code, d.node])).toEqual([
      ['remote-pin-mismatch', `${CI}#x/~github-actions-a>.github/actions/a/~octo-act`],
    ]);
  });

  it('says a fetch-mode plan resolved a ref live, and that a lockfile it cannot read pins nothing', () => {
    const files = { [CI]: caller, [LOCK]: 'version: 1\nremotes: {}\n' };
    const resolved = [{ ...source(DEPLOY, deploy), pinned: 'resolved' as const }];
    const fetched = simulate({
      files,
      scenario: SCENARIO,
      remotes: { sources: resolved },
      remotesMode: 'fetch',
    });
    expect(codes(fetched)).toEqual(['remote-unpinned']);
    const broken = simulate({
      files: { [CI]: caller, [LOCK]: 'version: 2\n' },
      scenario: SCENARIO,
      remotes: { sources: resolved },
    });
    expect(broken.diagnostics).toEqual([
      expect.objectContaining({ code: 'remotes-lock-invalid', severity: 'warning' }),
    ]);
  });
});

describe('remotes in the plan’s other forms', () => {
  it('renders remote callees and calls with their state', () => {
    const read = renderText(planWith({ sources: [source(DEPLOY, deploy)] }));
    expect(read).toContain(`    ● ${DEPLOY} (remote, aaaaaaa) — parent yes\n`);
    expect(read).toContain(`Remotes:\n  ${DEPLOY} → aaaaaaa (lockfile)\n`);
    const failed = renderText(
      planWith({ sources: [], failed: [{ ref: DEPLOY, kind: 'workflow', failure: 'access', message: '' }] }),
    );
    expect(failed).toContain(`    └ ${DEPLOY} (remote, not read: access)\n`);
    expect(failed).toContain(`Remotes:\n  ${DEPLOY} (not read: access)\n`);
  });

  it('keeps a workflow’s remotes when restricted to it, and drops the others', () => {
    const other = '.github/workflows/other.yml';
    const p = planWith({ sources: [source(DEPLOY, deploy)] }, { [CI]: caller, [other]: caller });
    expect(p.remotes![0]!.at).toEqual([CALL, `${other}#call`]);
    expect(restrictPlan(p, other).remotes).toEqual([{ ...p.remotes![0]!, at: [`${other}#call`] }]);
    const lone = '.github/workflows/lone.yml';
    const q = planWith(
      { sources: [] },
      { [CI]: caller, [lone]: 'on: push\njobs:\n  x:\n    runs-on: x\n    steps: [{ run: echo }]\n' },
    );
    expect(restrictPlan(q, lone)).not.toHaveProperty('remotes');
  });
});
