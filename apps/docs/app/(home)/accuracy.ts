import measured from '../../../../fixtures/routes-lab/accuracy.json' with { type: 'json' };

/**
 * The lab's accuracy figures as the landing and the accuracy page print them, read from
 * fixtures/routes-lab/accuracy.json when the site builds. `pnpm lab:accuracy` writes that file and CI fails while it
 * is stale, so no number here is typed in.
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

/** The remote cases' figure, apart from the headline: they ran on another capture, some as dispatches GitHub refused. */
export interface RemoteFigure extends Omit<Figure, 'commit'> {
  refused: string;
}

export function remoteFigure(a: Accuracy): RemoteFigure {
  const r = a.remote;
  const f = {
    outcomes: count.format(r.exact + r.maybe + r.wrong),
    runs: count.format(r.runs),
    refused: count.format(r.refused),
    exact: count.format(r.exact),
    maybe: count.format(r.maybe),
    wrong: count.format(r.wrong),
  };
  return {
    ...f,
    sentence:
      `On ${f.outcomes} observed outcomes from ${f.runs} real GitHub runs and ${f.refused} refused dispatches of ` +
      `remote reusable workflows and actions, simulci predicted ${f.exact} exactly, ${f.maybe} as “might” while ` +
      `naming the unknown, and ${f.wrong} wrongly.`,
  };
}

const REMOTE_ACCURACY: RemoteFigure = remoteFigure(measured);

/**
 * The values the accuracy page names, as `{accuracy.exact}`, `{remote.sentence}` or `{remote.compared.steps}`:
 * lib/remark-accuracy.ts writes them into the page when the site builds.
 */
export const PAGE_VALUES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ACCURACY).map(([k, v]) => [`accuracy.${k}`, v])),
  ...Object.fromEntries(Object.entries(REMOTE_ACCURACY).map(([k, v]) => [`remote.${k}`, v])),
  ...Object.fromEntries(
    Object.entries(measured.compared).map(([k, n]) => [`compared.${k}`, count.format(n)]),
  ),
  ...Object.fromEntries(
    Object.entries(measured.remote.compared).map(([k, n]) => [`remote.compared.${k}`, count.format(n)]),
  ),
};
