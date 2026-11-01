import { describe, expect, it } from 'vitest';
import { labFiles } from './lab';
import { measureRemote, NOT_COMPARED, refusals, remoteRuns } from './lab-remote';

/**
 * Conformance against the routes lab's remote cases (fixtures/routes-lab/cases.md, R1-R10): every outcome GitHub
 * reported for a run calling ciatlas/simulci-lab-remote, and every dispatch it refused, graded against the plan with
 * the remote files fed in as a host reads them. scripts/lab-accuracy.ts writes the counts to accuracy.json's
 * `remote` block. The engine predicts none wrongly, so a new miss fails this test until it is fixed.
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

  it('reads every remote at the commit GitHub ran, and plans each job from it (R9: one ref at two commits)', () => {
    expect(measured.inputs).toEqual([]);
  });

  it('predicts no outcome wrongly', () => {
    expect(measured.wrong).toEqual([]);
    expect(measured.accuracy.wrong).toBe(0);
  });
});
