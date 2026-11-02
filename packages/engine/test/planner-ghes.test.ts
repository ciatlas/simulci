import { decidingReason, type RemoteSourceInput, type RunPlan, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const CI = '.github/workflows/ci.yml';
const SHA = 'a'.repeat(40);
const COMPOSITE = 'octo/kit/setup@v2';

const files = {
  [CI]: `
on: push
jobs:
  call:
    uses: $/.github/workflows/build.yml
  steps:
    runs-on: ubuntu-latest
    steps:
      - id: a
        uses: $/.github/actions/a
`,
  '.github/workflows/build.yml':
    'on: workflow_call\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
  '.github/actions/a/action.yml': 'runs:\n  using: composite\n  steps: [{ run: echo a, shell: bash }]\n',
};

const on = (platform: 'dotcom' | 'ghes', given: Record<string, string> = files): RunPlan =>
  simulate({ files: given, scenario: { event: 'push', platform }, maxDepth: given === files ? 10 : 0 });

const jobOf = (p: RunPlan, id: string) =>
  p.workflows.find((w) => w.path === CI)!.jobs.find((j) => j.jobId === id)!;
const said = (p: RunPlan) => p.diagnostics.map((d) => [d.code, d.message, d.node]);

describe('platform: ghes', () => {
  it('leaves this repository’s $/ calls and steps unresolved, with ghes-unsupported', () => {
    const dotcom = on('dotcom');
    expect(jobOf(dotcom, 'call').legs[0]!.call?.jobs.map((j) => j.jobId)).toEqual(['build']);
    expect(jobOf(dotcom, 'steps').legs[0]!.steps![0]!.composite?.path).toBe('.github/actions/a');
    expect(dotcom.diagnostics).toEqual([]);

    const ghes = on('ghes');
    const call = jobOf(ghes, 'call').legs[0]!;
    expect(call.call).toBeUndefined();
    expect(call.result).toMatchObject({ known: false, oneOf: ['success', 'failure', 'skipped'] });
    const step = jobOf(ghes, 'steps').legs[0]!.steps![0]!;
    expect(step.composite).toBeUndefined();
    expect(step.outcome).toEqual({ known: true, value: 'success' });
    expect(said(ghes)).toEqual([
      [
        'ghes-unsupported',
        '$/.github/workflows/build.yml: GitHub Enterprise Server has no $/ refs, so it is not resolved',
        `${CI}#call`,
      ],
      [
        'ghes-unsupported',
        '$/.github/actions/a: GitHub Enterprise Server has no $/ refs, so it is not resolved',
        `${CI}#steps/steps.a`,
      ],
    ]);
  });

  it('leaves a remote’s $/ unresolved and lists no remote for it', () => {
    const outer = 'runs:\n  using: composite\n  steps: [{ uses: $/inner }]\n';
    const inner = 'runs:\n  using: composite\n  steps: [{ run: echo inner, shell: bash }]\n';
    const sources: RemoteSourceInput[] = [
      { ref: COMPOSITE, kind: 'action', sha: SHA, text: outer, pinned: 'lockfile' },
      { ref: `octo/kit/inner@${SHA}`, kind: 'action', sha: SHA, text: inner, pinned: 'parent' },
    ];
    const p = simulate({
      files: {
        [CI]: `on: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps: [{ uses: ${COMPOSITE} }]\n`,
      },
      scenario: { event: 'push', platform: 'ghes' },
      remotes: { sources },
    });
    const self = p.workflows[0]!.jobs[0]!.legs[0]!.steps![0]!.composite!.steps[0]!;
    expect(self.composite).toBeUndefined();
    expect(p.remotes!.map((r) => r.ref)).toEqual([COMPOSITE]);
    expect(p.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['ghes-unsupported', '$/inner: GitHub Enterprise Server has no $/ refs, so it is not resolved'],
    ]);
  });

  it('refuses a run past github.com’s call limits with an unsupported limit, claiming no GHES count', () => {
    const refused = (p: RunPlan) => p.workflows.find((w) => w.path === CI)!.triggered;
    // A `./` call: the `$/` one is not resolved, so it nests nothing on GHES.
    const nested = { ...files, [CI]: 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/build.yml\n' };
    const dotcom = on('dotcom', nested);
    expect(decidingReason(refused(dotcom).chain, 'no')).toEqual({ kind: 'limit', limit: 'nesting' });

    const ghes = on('ghes', nested);
    expect(refused(ghes).verdict).toBe('no');
    expect(decidingReason(refused(ghes).chain, 'no')).toEqual({ kind: 'limit', limit: 'unsupported' });
    expect(said(ghes)).toEqual([
      [
        'refused',
        `GitHub does not start ${CI}: its reusable workflows nest 1 deep, more than 0 ` +
          "(github.com's limit; GitHub Enterprise Server's is not modelled)",
        CI,
      ],
    ]);
  });
});
