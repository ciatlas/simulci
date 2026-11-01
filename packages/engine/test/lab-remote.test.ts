import { describe, expect, it } from 'vitest';
import { labFiles } from './lab';
import { measureRemote, NOT_COMPARED, refusals, remoteRuns } from './lab-remote';

/**
 * Conformance against the routes lab's remote cases (fixtures/routes-lab/cases.md, R1-R10): every outcome GitHub
 * reported for a run calling ciatlas/simulci-lab-remote, and every dispatch it refused, graded against the plan with
 * the remote files fed in as a host reads them. scripts/lab-accuracy.ts writes the counts to accuracy.json's
 * `remote` block. The engine predicts six outcomes wrongly; they are pinned here by case, so a fix or a new miss
 * fails this test until accuracy.json and this list are updated (~/.claude/plans/simulci/m4-pass/wave3/l3.md).
 */

/** Each case's callers in the lab (`repo/.github/workflows/`). */
const CASES: Record<string, string[]> = {
  R1: ['case-remote-reusable-outputs.yml'],
  R2: ['case-remote-relative-workflow.yml', 'case-remote-self.yml'],
  R3: ['case-remote-workspace-action.yml'],
  R4: ['case-remote-node-undeclared-output.yml'],
  R5: ['case-remote-tag-vs-sha.yml'],
  R6: ['case-remote-secrets-inherit.yml'],
  R7: [
    ...Array.from({ length: 12 }, (_, i) => `case-remote-nesting-${i + 10}.yml`),
    'case-remote-total-50.yml',
    'case-remote-total-51.yml',
  ],
  R8: ['case-remote-composite-outputs.yml'],
  R9: [
    'case-remote-actions-lock.yml',
    'case-remote-actions-lock-uncovered.yml',
    'case-remote-actions-lock-local-callee.yml',
    'case-remote-actions-lock-missing.yml',
  ],
  R10: ['case-remote-same-repo-ref.yml', 'case-remote-same-repo-self.yml'],
};

const wf = (file: string) => `.github/workflows/${file}`;

/** The engine's six wrong predictions, by case (the PR that added this test lists what GitHub did in each). */
const KNOWN_WRONG = [
  // R3: a remote step's `./` is the job's workspace: empty without a checkout, the caller's files after one.
  `probes ${wf('case-remote-workspace-action.yml')} [workflow_dispatch refs/heads/main] call / bare probe ` +
    'bare.outcome: predicted {"known":true,"value":"success"}, was failure',
  `probes ${wf('case-remote-workspace-action.yml')} [workflow_dispatch refs/heads/main] call / checkout probe ` +
    'r3-action: no predicted step echoes it',
  // R9: an `actions.lock` pin holds only in the workflow it covers; one source per ref gives every use the pin.
  `probes ${wf('case-remote-actions-lock-uncovered.yml')} [workflow_dispatch refs/heads/main] a probe r9-action: ` +
    'predicted {"known":true,"value":"a"}, was b',
  `probes ${wf('case-remote-actions-lock-local-callee.yml')} [workflow_dispatch refs/heads/main] call / a probe ` +
    'r9-action: predicted {"known":true,"value":"a"}, was b',
  // R9: a covered workflow with a `uses:` its lock lacks is refused at dispatch.
  `triggers ${wf('case-remote-actions-lock-missing.yml')} [refused refs/heads/main 2035977]: predicted yes, refused`,
  `triggers ${wf('case-remote-actions-lock-missing.yml')} [refused refs/heads/main 4061055]: predicted yes, refused`,
];

/** The commits GitHub ran that a host following `remotesNeeded` does not read: R9's uncovered uses after the move. */
const KNOWN_INPUTS = [
  `${wf('case-remote-actions-lock-uncovered.yml')} [refs/heads/main 4061055] ` +
    'ciatlas/simulci-lab-remote/.github/actions/r9-action@v1: fed d19def8c3562ef6c1be3f12443345575530f1ac4, a ' +
    'downloaded 38a93ff01695fd104bfe8bc8b79ceeae91206ddc',
  `${wf('case-remote-actions-lock-local-callee.yml')} [refs/heads/main 4061055] ` +
    'ciatlas/simulci-lab-remote/.github/actions/r9-action@v1: fed d19def8c3562ef6c1be3f12443345575530f1ac4, call / a ' +
    'downloaded 38a93ff01695fd104bfe8bc8b79ceeae91206ddc',
];

describe('routes lab, remote cases', () => {
  const measured = measureRemote();

  it('grades every remote caller the lab has, by a run or a refused dispatch', () => {
    const callers = Object.keys(labFiles).filter((p) => p.startsWith(wf('case-remote-')));
    expect(Object.values(CASES).flat().map(wf).sort()).toEqual(callers.sort());
    const graded = new Set([...remoteRuns, ...refusals].map((r) => r.workflow));
    expect(callers.filter((p) => !graded.has(p))).toEqual([]);
  });

  it('leaves out only the values a plan cannot hold, each with its reason', () => {
    for (const n of NOT_COMPARED) {
      expect(n.reason).not.toBe('');
      expect(
        remoteRuns.some((r) => r.workflow === n.workflow && r.jobs.some((j) => n.probe in j.probes)),
      ).toBe(true);
    }
  });

  it('counts every compared outcome once, one trigger per run and per refused dispatch', () => {
    const { accuracy } = measured;
    const compared = Object.values(accuracy.compared).reduce((a, b) => a + b, 0);
    expect(accuracy.exact + accuracy.maybe + accuracy.wrong).toBe(compared);
    expect(accuracy.compared.triggers).toBe(accuracy.runs + accuracy.refused);
  });

  it('reads every remote at the commit GitHub ran, but where R9 needs two commits for one ref', () => {
    expect(measured.inputs).toEqual(KNOWN_INPUTS);
  });

  it('predicts wrongly only the six known outcomes of R3 and R9', () => {
    expect(measured.wrong).toEqual(KNOWN_WRONG);
    expect(measured.accuracy.wrong).toBe(KNOWN_WRONG.length);
  });
});
