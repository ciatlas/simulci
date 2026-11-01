import measured from '../../../../fixtures/routes-lab/accuracy.json' with { type: 'json' };

/**
 * The lab's accuracy figure as the landing prints it, read from fixtures/routes-lab/accuracy.json when the site
 * builds. `pnpm lab:accuracy` writes that file and CI fails while it is stale, so no number here is typed in.
 */

/** fixtures/routes-lab/accuracy.json: what was compared, by kind, and how each outcome was graded. */
export interface Accuracy {
  /** The lab commit whose pushes the capture holds. */
  capture: string;
  runs: number;
  compared: Record<string, number>;
  exact: number;
  maybe: number;
  wrong: number;
  /** The remote cases (R1-R10), graded apart: runs, refused dispatches and the same counts. */
  remote: Omit<Accuracy, 'capture' | 'remote'> & { refused: number };
}

export interface Figure {
  outcomes: string;
  runs: string;
  exact: string;
  maybe: string;
  wrong: string;
  /** The capture's commit, short. */
  commit: string;
  sentence: string;
}

const count = new Intl.NumberFormat('en-US');

export function figure(a: Accuracy): Figure {
  const f = {
    outcomes: count.format(a.exact + a.maybe + a.wrong),
    runs: count.format(a.runs),
    exact: count.format(a.exact),
    maybe: count.format(a.maybe),
    wrong: count.format(a.wrong),
    commit: a.capture.slice(0, 7),
  };
  return {
    ...f,
    sentence:
      `On ${f.outcomes} observed outcomes from ${f.runs} real GitHub runs (runs on the lab’s pushes up to commit ` +
      `${f.commit}, ubuntu-latest, github.com), simulci predicted ${f.exact} exactly, ${f.maybe} as “might” while ` +
      `naming the unknown, and ${f.wrong} wrongly, given which scripted steps failed.`,
  };
}

export const ACCURACY: Figure = figure(measured);
