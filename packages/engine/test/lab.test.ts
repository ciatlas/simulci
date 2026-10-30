import { describe, expect, it } from 'vitest';
import { measure, notTriggered } from './lab';

/**
 * Conformance against the routes lab: every outcome GitHub reported for a captured run (that it ran, its check runs,
 * job and step conclusions, and the values its jobs echoed) is predicted exactly or as "might", never wrongly, given
 * which scripted steps failed, and every workflow a push did not start is predicted not to trigger.
 * scripts/lab-accuracy.ts writes the same counts to fixtures/routes-lab/accuracy.json.
 */

describe('routes lab', () => {
  it(
    'grades every observed outcome once, every run and every push that did not start a workflow for its trigger',
    {
      timeout: 60_000,
    },
    () => {
      const { accuracy } = measure();
      const compared = Object.values(accuracy.compared).reduce((a, b) => a + b, 0);
      expect(accuracy.exact + accuracy.maybe + accuracy.wrong).toBe(compared);
      expect(accuracy.compared.triggers).toBe(accuracy.runs + notTriggered);
    },
  );

  it('predicts no observed outcome wrongly', { timeout: 60_000 }, () => {
    const { accuracy, wrong } = measure();
    expect(wrong).toEqual([]);
    expect(accuracy.wrong).toBe(0);
  });
});
