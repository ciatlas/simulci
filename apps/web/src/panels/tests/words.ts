import type { TestRun } from '../../state/store';
import type { TestedCase } from '../../worker/protocol';

/** The Tests tab's words: its header, and a status as a glyph that does not lean on its colour. */

/** `14 passed · 1 failed · 0 invalid · ran as CI on 3f2a9c1`; skipped cases are counted only when there are some. */
export function headerOf(run: Pick<TestRun, 'summary' | 'for'>): string {
  const { passed, failed, invalid, skipped } = run.summary;
  const counts = [`${passed} passed`, `${failed} failed`, `${invalid} invalid`];
  if (skipped > 0) counts.push(`${skipped} skipped`);
  return `${counts.join(' · ')} · ran ${run.for.ci ? 'as CI' : 'locally'} on ${run.for.digest}`;
}

export const STATUS: Record<TestedCase['status'], { glyph: string; className: string }> = {
  passed: { glyph: '✓', className: 'text-run' },
  failed: { glyph: '✗', className: 'text-danger' },
  invalid: { glyph: '!', className: 'text-danger' },
  skipped: { glyph: '–', className: 'text-muted' },
};

/** Whether a case opens on its failures: it did not pass, and says why. */
export const opensOnFailures = (c: Pick<TestedCase, 'status' | 'failures'>): boolean =>
  (c.status === 'failed' || c.status === 'invalid') && c.failures.length > 0;
