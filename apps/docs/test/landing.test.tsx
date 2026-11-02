import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { planArgs } from '../../../packages/cli/src/plan';
import { type Accuracy, figure, PAGE_VALUES, remoteFigure } from '../app/(home)/accuracy';
import HomePage from '../app/(home)/page';
import { remarkAccuracy } from '../lib/remark-accuracy';

/**
 * The landing and the accuracy page against what they claim: the figures are the ones accuracy.json holds, the remote
 * cases' apart, and no number of them is typed into either; the remote caveat stays while the lab's remote cases have
 * a wrong prediction; the landing's links go to pages the site has; the command it shows is one `simulci plan` reads;
 * and the Action's ref is the release the repository is at.
 */

const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const measured = JSON.parse(read('fixtures/routes-lab/accuracy.json')) as Accuracy;

/**
 * The page as markup. The sentences checked here are one text node each and hold nothing React escapes (their
 * quotes are typographic), so they show in the markup as written.
 */
const html = renderToStaticMarkup(<HomePage />);

describe('the accuracy figure', () => {
  const f = figure(measured);

  it('counts every compared outcome once, as exact, maybe or wrong', () => {
    const compared = Object.values(measured.compared).reduce((a, b) => a + b, 0);
    expect(measured.exact + measured.maybe + measured.wrong).toBe(compared);
    expect(f.outcomes).toBe(compared.toLocaleString('en-US'));
  });

  it('is on the page as accuracy.json has it, in the wording of the synthesis', () => {
    expect(f.sentence).toBe(
      `On ${f.outcomes} observed outcomes from ${measured.runs} real GitHub runs (runs on the lab’s pushes up to ` +
        `commit ${measured.capture.slice(0, 7)}, ubuntu-latest, github.com), simulci predicted ${f.exact} ` +
        `exactly, ${f.maybe} as “might” while naming the unknown, and ${measured.wrong} wrongly, given which ` +
        `scripted steps failed.`,
    );
    expect(html).toContain(`>${f.sentence}<`);
    for (const n of [f.outcomes, f.exact, f.maybe, f.wrong]) expect(html).toContain(`>${n}</dd>`);
  });

  it('counts every compared remote outcome once, apart from the headline', () => {
    const r = measured.remote;
    const compared = Object.values(r.compared).reduce((a, b) => a + b, 0);
    expect(r.exact + r.maybe + r.wrong).toBe(compared);
    const rf = remoteFigure(measured);
    expect(rf.sentence).toBe(
      `On ${rf.outcomes} observed outcomes from ${r.runs} real GitHub runs and ${r.refused} refused dispatches of ` +
        `remote reusable workflows and actions, simulci predicted ${rf.exact} exactly, ${rf.maybe} as “might” while ` +
        `naming the unknown, and ${r.wrong} wrongly.`,
    );
    expect(rf.outcomes).toBe(compared.toLocaleString('en-US'));
  });

  it('is never typed into the landing or the accuracy page', () => {
    const dir = new URL('apps/docs/app/(home)/', root);
    const sources = [
      ...readdirSync(dir).map((file) => readFileSync(new URL(file, dir), 'utf8')),
      read('apps/docs/content/docs/accuracy.mdx'),
      read('apps/docs/lib/remark-accuracy.ts'),
    ];
    const { remote } = measured;
    // Two digits and more: a 0 or a 4 is in any source.
    const numbers = [
      measured.runs,
      measured.exact,
      measured.maybe,
      ...Object.values(measured.compared),
      remote.runs,
      remote.refused,
      remote.exact,
      remote.maybe,
      ...Object.values(remote.compared),
    ].flatMap((n) => (n >= 10 ? [String(n), n.toLocaleString('en-US')] : []));
    // Not a part of a name, a version, an issue or a path (the page links pull requests by URL).
    for (const source of sources)
      for (const n of numbers) expect(source).not.toMatch(new RegExp(`(?<![\\w.#/-])${n}(?![\\w.-])`));
    expect(sources.join()).not.toContain(measured.capture.slice(0, 7));
  });

  it('says remote reusable workflows are not lab-verified while the remote cases have a wrong prediction', () => {
    expect(html.includes('>Remote reusable workflows: not yet lab-verified.<')).toBe(
      measured.remote.wrong > 0,
    );
  });
});

describe('the accuracy page', () => {
  const mdx = read('apps/docs/content/docs/accuracy.mdx');
  const names = [...mdx.matchAll(/\{([a-z]+(?:\.[a-z]+)+)\}/g)].map((m) => m[1]!);

  it('names only values accuracy.ts gives, every count among them', () => {
    expect(names.filter((n) => !(n in PAGE_VALUES))).toEqual([]);
    for (const n of [
      'accuracy.sentence',
      'accuracy.exact',
      'accuracy.maybe',
      'accuracy.wrong',
      'remote.sentence',
    ])
      expect(names).toContain(n);
    for (const kind of Object.keys(measured.compared)) {
      expect(names).toContain(`compared.${kind}`);
      expect(names).toContain(`remote.compared.${kind}`);
    }
  });

  it('gets its values written in when the site builds, and refuses a name it does not have', () => {
    const text = (value: string) => ({ type: 'mdxTextExpression', value });
    const tree = {
      type: 'root',
      children: [
        { type: 'mdxFlowExpression', value: 'accuracy.sentence' },
        { type: 'paragraph', children: [text('remote.exact'), text('/* a comment */')] },
      ],
    };
    remarkAccuracy()(tree, { path: 'accuracy.mdx', data: {} } as never);
    expect(tree.children).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: figure(measured).sentence }] },
      {
        type: 'paragraph',
        children: [{ type: 'text', value: remoteFigure(measured).exact }, text('/* a comment */')],
      },
    ]);
    expect(() =>
      remarkAccuracy()({ type: 'root', children: [text('accuracy.typo')] }, { data: {} } as never),
    ).toThrow('{accuracy.typo}: no such value');
  });
});

describe('the landing', () => {
  it('links to pages the site has, and to files the repository has', () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs.filter((h) => h.startsWith('/docs'))) {
      const page = href.replace(/^\/docs\/?/, '') || 'index';
      expect(existsSync(new URL(`apps/docs/content/docs/${page}.mdx`, root)), href).toBe(true);
    }
    for (const href of hrefs.filter((h) => h.startsWith('https://github.com/ciatlas/simulci/tree/main/')))
      expect(existsSync(new URL(href.replace(/^.*\/tree\/main\//, ''), root)), href).toBe(true);
    for (const src of [...html.matchAll(/src="(\/[^"]+)"/g)].map((m) => m[1]!))
      expect(existsSync(new URL(`apps/docs/public${src}`, root)), src).toBe(true);
  });

  it('shows a command simulci plan reads', () => {
    const command = /npx simulci plan ([^<]+)</.exec(html)![1]!;
    expect(() => planArgs(command.split(' '))).not.toThrow();
  });

  it('uses the release the repository is at', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    expect(html.match(/ciatlas\/simulci@[^<\s]+/g)).toEqual([`ciatlas/simulci@v${version}`]);
  });
});
