// @vitest-environment happy-dom
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { type ScenarioInput, simulate } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { SimulateView } from '../src/app/SimulateView';
import { UrlSync } from '../src/app/UrlSync';
import { defaultScenario } from '../src/scenario/defaults';
import { withEvent } from '../src/scenario/form';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { validateSearch } from '../src/state/url';
import { createUrlSync, pageDefault, restoreDefault } from '../src/state/url-sync';
import { deriveTables } from '../src/worker/derived';
import type { Outline } from '../src/worker/protocol';

/** A form that cannot render the event `boom`, standing in for any render error under the boundary. */
vi.mock('../src/app/ScenarioForm', async () => {
  const { createElement: h } = await import('react');
  const { useSession } = await import('../src/app/providers');
  return {
    ScenarioForm: () => {
      const event = useSession((s) => s.scenario.event);
      if (event === 'boom') throw new Error('cannot show boom');
      return h('p', null, `the form for ${event}`);
    },
  };
});

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';

const outline: Outline = {
  files: [],
  workflows: [
    {
      path: CI,
      callable: false,
      events: [{ event: 'push', branches: ['main'] }, { event: 'pull_request' }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: {},
};

/** The project is loaded and the page chose its default scenario, as the session does after a load. */
function loaded(store: SessionStore): void {
  const a = store.getState();
  a.projectReady(1, outline, 1);
  a.setScenario({ event: 'push', branch: 'main' }, { assumed: ['event', 'branch'], from: 'default' });
  a.setFocus(CI);
}

/** A browser history of search params: the bridge writes to it, the test moves it as Back and Forward do. */
function fakeHistory(first: Record<string, unknown>) {
  const entries = [validateSearch(first)];
  let at = 0;
  const writes: { search: Record<string, unknown>; replace: boolean }[] = [];
  return {
    entries,
    writes,
    navigate: (search: Record<string, unknown>, replace: boolean): void => {
      writes.push({ search, replace });
      if (replace) entries[at] = search;
      else entries.splice(++at, entries.length, search);
    },
    current: () => entries[at]!,
    move: (by: number): void => {
      at += by;
    },
  };
}

/**
 * The bridge over a fresh store, seeded with the first URL; `routeRenders` is the route rendering the URL it is on,
 * through the route's own picker.
 */
function bridge(first: Record<string, unknown> = {}) {
  const store = createSessionStore();
  const history = fakeHistory(first);
  const sync = createUrlSync({ store, navigate: history.navigate, current: history.current });
  const stop = sync.start();
  const routeRenders = (): void => sync.urlChanged(validateSearch(history.current()));
  routeRenders();
  return { store, history, stop, routeRenders };
}

describe('a link that names a GitHub repository (failure mode 15)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const repo = {
    kind: 'github' as const,
    host: 'github.com',
    owner: 'octo',
    repo: 'ship',
    ref: 'main',
    sha: 'a'.repeat(40),
    defaultBranch: 'main',
    private: false,
    readAt: 0,
  };

  it('offers a repository the source is not, keeps it in the URL while it waits, and lets it go once it opens', async () => {
    const { store, history, stop } = bridge({ event: 'push', gh: 'Octo/Ship' });
    expect(store.getState().githubOffer).toEqual({ owner: 'Octo', repo: 'Ship' });
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'sample', name: 'starter' });
    loaded(store);
    await vi.advanceTimersByTimeAsync(300);
    expect(history.current().gh).toBe('Octo/Ship');
    // Opening it (at its default branch) satisfies the link: the offer goes, the source names itself.
    store.getState().setFiles({ [CI]: 'on: push\n' }, repo);
    expect(store.getState().githubOffer).toBeUndefined();
    loaded(store);
    await vi.advanceTimersByTimeAsync(300);
    expect(history.current().gh).toBe('octo/ship@main');
    stop();
  });

  it('offers nothing for the repository already open, and drops a dismissed offer from the URL', async () => {
    const store = createSessionStore();
    store.getState().setFiles({ [CI]: 'on: push\n' }, repo);
    const history = fakeHistory({ event: 'push', gh: 'octo/ship@main' });
    const sync = createUrlSync({ store, navigate: history.navigate, current: history.current });
    const stop = sync.start();
    sync.urlChanged(validateSearch(history.current()));
    expect(store.getState().githubOffer).toBeUndefined();
    sync.urlChanged(validateSearch({ event: 'push', gh: 'octo/boat' }));
    expect(store.getState().githubOffer).toEqual({ owner: 'octo', repo: 'boat' });
    store.getState().offerGitHub(undefined);
    expect(store.getState().githubOffer).toBeUndefined();
    stop();
  });

  it('never names a private repository', async () => {
    const { store, history, stop } = bridge({ event: 'push' });
    store.getState().setFiles({ [CI]: 'on: push\n' }, { ...repo, private: true });
    loaded(store);
    await vi.advanceTimersByTimeAsync(300);
    expect(history.current().gh).toBeUndefined();
    stop();
  });
});

describe('the URL bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds the store from the first URL and writes nothing back', () => {
    const b = bridge({
      event: 'pull_request',
      number: 7,
      a: [{ step: 'build.test', outcome: 'failure' }],
      wf: CI,
      d: 'legs',
      view: 'text',
      hide: '1',
      edit: '1',
    });
    const s = b.store.getState();
    expect(s.edit.on).toBe(true);
    expect(s.scenario).toEqual({ event: 'pull_request', number: 7 });
    expect(s.scenarioFrom).toBe('url');
    expect(s.assume).toEqual([{ step: 'build.test', outcome: 'failure' }]);
    expect([s.focus, s.detail, s.ui.view, s.ui.hideUntriggered]).toEqual([CI, 'legs', 'text', true]);
    vi.advanceTimersByTime(300);
    expect(b.history.writes).toEqual([]);
  });

  it('applies a later URL it did not write, a key the URL leaves out going back to its default', () => {
    const b = bridge({
      event: 'pull_request',
      a: [{ step: 'build.test', outcome: 'failure' }],
      d: 'legs',
      hide: 1,
      edit: 1,
    });
    expect(b.store.getState().edit.on).toBe(true);
    b.store.getState().projectReady(1, outline, 1);
    b.history.entries[0] = {};
    b.routeRenders();

    const s = b.store.getState();
    const d = defaultScenario(outline);
    expect(s.scenario).toEqual(d.scenario);
    expect(s.scenarioFrom).toBe('default');
    expect(s.assumed).toEqual(d.assumed);
    expect(s.focus).toBe(CI);
    expect([s.assume, s.detail, s.ui.view, s.ui.hideUntriggered]).toEqual([[], 'steps', 'graph', false]);
    expect(s.edit.on).toBe(false);
  });

  it('keeps assume entries too long for the URL when a URL without them is applied', () => {
    const b = bridge({ event: 'push' });
    const long = Array.from({ length: 200 }, (_, i) => ({
      step: `job.step${i}`,
      outcome: 'failure' as const,
    }));
    b.store.getState().setAssume(long);
    b.history.entries[0] = { event: 'pull_request' };
    b.routeRenders();
    expect(b.store.getState().assume).toBe(long);
    b.store.getState().setAssume(long.slice(0, 2));
    b.history.entries[0] = { event: 'push' };
    b.routeRenders();
    expect(b.store.getState().assume).toEqual([]);
  });

  it('takes the first scenario of the page for a URL without one before a project is loaded', () => {
    const b = bridge({ event: 'release', tag: 'v1' });
    b.history.entries[0] = { view: 'text' };
    b.routeRenders();
    expect(b.store.getState().scenario).toEqual({ event: 'push' });
    expect(b.store.getState().scenarioFrom).toBe('default');
    expect(b.store.getState().ui.view).toBe('text');
  });

  it('does not take its own write back for a move, and keeps the edit pending behind it', () => {
    const b = bridge({ event: 'push', branch: 'main' });
    b.store.getState().patchScenario({ branch: 'dev' });
    vi.advanceTimersByTime(300);
    b.store.getState().patchScenario({ branch: 'next' });
    b.routeRenders();
    expect(b.store.getState().scenario).toEqual({ event: 'push', branch: 'next' });
    vi.advanceTimersByTime(300);
    expect(b.history.writes.map((w) => w.search.branch)).toEqual(['dev', 'next']);
  });

  it('writes only what the route keeps, and takes the URL the route renders for its own write', () => {
    const b = bridge({ event: 'push' });
    const changed = [{ path: 'src/a.ts', status: { kind: 'added' } }] as unknown as ScenarioInput['changed'];
    b.store.getState().patchScenario({ branch: 'dev', changed });
    vi.advanceTimersByTime(300);
    b.routeRenders();

    expect(b.history.writes).toEqual([{ search: { event: 'push', branch: 'dev' }, replace: true }]);
    expect(b.store.getState().scenario).toEqual({ event: 'push', branch: 'dev', changed });
    expect(b.store.getState().scenarioFrom).toBe('author');
  });

  it('writes nothing while the event is blank, and the event typed next is pushed', () => {
    const b = bridge({ event: 'push', branch: 'main' });
    b.store.getState().setScenario(withEvent(b.store.getState().scenario, ''));
    vi.advanceTimersByTime(300);
    b.routeRenders();

    expect(b.history.writes).toEqual([]);
    expect(b.store.getState().scenario).toEqual({ event: '', branch: 'main' });
    expect(b.store.getState().scenarioFrom).toBe('author');
    b.store.getState().patchScenario({ event: 'pull_request' });
    vi.advanceTimersByTime(300);
    expect(b.history.writes).toEqual([{ search: { event: 'pull_request', branch: 'main' }, replace: false }]);
  });

  it('drops a pending write when the URL moves under it, and follows the move', () => {
    const b = bridge({ event: 'push', branch: 'main' });
    b.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    vi.advanceTimersByTime(300);
    b.store.getState().patchScenario({ base: 'dev' });
    b.history.move(-1);
    b.routeRenders();
    vi.advanceTimersByTime(300);

    expect(b.history.writes).toHaveLength(1);
    expect(b.history.entries).toEqual([
      { event: 'push', branch: 'main' },
      { event: 'pull_request', base: 'main' },
    ]);
    expect(b.store.getState().scenario).toEqual({ event: 'push', branch: 'main' });
  });

  it('writes nothing over an entry Back led to before the route rendered it', () => {
    const b = bridge({ event: 'push', branch: 'main' });
    b.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    vi.advanceTimersByTime(300);
    b.store.getState().patchScenario({ base: 'dev' });
    b.history.move(-1);
    vi.advanceTimersByTime(300);

    expect(b.history.entries[0]).toEqual({ event: 'push', branch: 'main' });
    b.routeRenders();
    expect(b.store.getState().scenario).toEqual({ event: 'push', branch: 'main' });
  });

  it('pushes a write whose event differs from the URL last written, and replaces any other', () => {
    const b = bridge({ event: 'push', branch: 'main' });
    b.store.getState().patchScenario({ branch: 'dev' });
    vi.advanceTimersByTime(300);
    b.store.getState().setScenario({ event: 'pull_request', branch: 'dev' });
    vi.advanceTimersByTime(100);
    b.store.getState().patchScenario({ base: 'main' });
    vi.advanceTimersByTime(300);
    b.store.getState().patchScenario({ base: 'develop' });
    vi.advanceTimersByTime(300);

    expect(b.history.writes.map((w) => [w.search.event, w.replace])).toEqual([
      ['push', true],
      ['pull_request', false],
      ['pull_request', true],
    ]);
    expect(b.history.entries).toHaveLength(2);
  });

  it('writes the page default at once and in place, whatever event the URL held', () => {
    const b = bridge({ event: 'push', branch: 'main' });
    b.store.getState().projectReady(1, outline, 1);
    b.store.getState().setScenario({ event: 'pull_request', base: 'main' }, { from: 'default' });
    expect(b.history.writes).toEqual([{ search: { event: 'pull_request', base: 'main' }, replace: true }]);
    b.store.getState().patchScenario({ base: 'dev' });
    vi.advanceTimersByTime(300);
    expect(b.history.writes.map((w) => w.replace)).toEqual([true, true]);
    expect(b.history.entries).toHaveLength(1);
  });

  it('replaces the bare first entry with the first scenario written', () => {
    const b = bridge({});
    b.store.getState().projectReady(1, outline, 1);
    b.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    vi.advanceTimersByTime(300);
    expect(b.history.writes).toEqual([{ search: { event: 'pull_request', base: 'main' }, replace: true }]);
  });

  it('writes a selection in place beside its workflow, and takes back one it did not write', () => {
    const b = bridge({ event: 'push', branch: 'main', wf: CI });
    b.store.getState().select(CI, 'test[node=20].#1');
    vi.advanceTimersByTime(300);
    expect(b.history.writes).toEqual([
      { search: { event: 'push', branch: 'main', wf: CI, sel: 'test[node=20].#1' }, replace: true },
    ]);

    b.history.entries[0] = { event: 'push', branch: 'main', wf: RELEASE, sel: 'publish' };
    b.routeRenders();
    expect([b.store.getState().focus, b.store.getState().sel]).toEqual([RELEASE, 'publish']);
    b.history.entries[0] = { event: 'push', branch: 'main', wf: CI };
    b.routeRenders();
    expect([b.store.getState().focus, b.store.getState().sel]).toEqual([CI, undefined]);
    vi.advanceTimersByTime(300);
    expect(b.history.writes).toHaveLength(1);
  });

  it('takes the selection out of the URL when the workflow itself is selected again', () => {
    const b = bridge({ event: 'push', wf: CI, sel: 'build' });
    b.store.getState().select(CI, undefined);
    vi.advanceTimersByTime(300);
    expect(b.history.writes).toEqual([{ search: { event: 'push', wf: CI }, replace: true }]);
  });

  it('writes nothing for the page default before a project backs it, and nothing once stopped', () => {
    const b = bridge({});
    b.store.getState().setScenario({ event: 'release' }, { from: 'default' });
    vi.advanceTimersByTime(300);
    expect(b.history.writes).toEqual([]);
    b.store.getState().setScenario({ event: 'push', branch: 'dev' });
    b.stop();
    vi.advanceTimersByTime(300);
    expect(b.history.writes).toEqual([]);
  });
});

describe("the page's own scenario", () => {
  it('is the outline default once a project is loaded, and the first scenario before', () => {
    const store = createSessionStore();
    expect(pageDefault(store.getState())).toEqual({ scenario: { event: 'push' }, assumed: [] });
    store.getState().projectReady(1, outline, 1);
    expect(pageDefault(store.getState())).toEqual(defaultScenario(outline));
  });

  it('comes back with its marks and its focus, and nothing selected in it', () => {
    const store = createSessionStore();
    store.getState().projectReady(1, outline, 1);
    store.getState().setScenario({ event: 'boom' }, { from: 'url' });
    store.getState().select(undefined, 'build');
    restoreDefault(store);
    const s = store.getState();
    expect([s.scenario, s.scenarioFrom, s.assumed, s.focus, s.sel]).toEqual([
      { event: 'push', branch: 'main' },
      'default',
      ['event', 'branch'],
      CI,
      undefined,
    ]);
  });
});

/** UrlSync under a real router on a memory history, with the route's own validateSearch. */
async function mountRouter(path: string, browser = false) {
  const store = createSessionStore();
  const root = createRootRoute({ component: () => createElement(Outlet) });
  const index = createRoute({ getParentRoute: () => root, path: '/', validateSearch, component: UrlSync });
  if (browser) window.history.replaceState(null, '', path);
  const history = browser ? createBrowserHistory() : createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree: root.addChildren([index]), history });
  await act(async () => {
    const app = { store } as unknown as App;
    render(createElement(AppProvider, { app, children: createElement(RouterProvider, { router }) }));
  });
  const search = (): Record<string, unknown> => router.state.location.search;
  const settle = async (ms = 300): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const go = async (move: () => void): Promise<void> => {
    await act(async () => {
      move();
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  return { store, history, search, settle, go };
}

describe('the URL bridge under the router', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('puts the store back where Back and Forward lead', async () => {
    const r = await mountRouter('/');
    loaded(r.store);
    await r.settle();
    expect(r.search()).toEqual({ event: 'push', branch: 'main', wf: CI });
    r.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    await r.settle();
    expect(r.history.length).toBe(2);

    await r.go(() => r.history.back());
    expect(r.search().event).toBe('push');
    expect(r.store.getState().scenario).toEqual({ event: 'push', branch: 'main' });

    await r.go(() => r.history.forward());
    expect(r.store.getState().scenario).toEqual({ event: 'pull_request', base: 'main' });
  });

  it('carries the selection and its workflow through Back and Forward', async () => {
    const r = await mountRouter('/');
    loaded(r.store);
    await r.settle();
    r.store.getState().select(CI, 'build');
    await r.settle();
    expect(r.search()).toEqual({ event: 'push', branch: 'main', wf: CI, sel: 'build' });
    r.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    await r.settle();
    r.store.getState().select(RELEASE, 'publish.#1');
    await r.settle();
    expect(r.search()).toEqual({ event: 'pull_request', base: 'main', wf: RELEASE, sel: 'publish.#1' });
    expect(r.history.length).toBe(2);

    const selection = () => [r.store.getState().focus, r.store.getState().sel];
    await r.go(() => r.history.back());
    expect(selection()).toEqual([CI, 'build']);
    await r.go(() => r.history.forward());
    expect(selection()).toEqual([RELEASE, 'publish.#1']);
    expect(r.store.getState().scenario).toEqual({ event: 'pull_request', base: 'main' });
  });

  it('opens a shared link on its selection', async () => {
    const r = await mountRouter(
      `/?event=push&wf=${encodeURIComponent(CI)}&sel=${encodeURIComponent('test[node=20]')}`,
    );
    expect([r.store.getState().focus, r.store.getState().sel]).toEqual([CI, 'test[node=20]']);
    await r.settle();
    expect(r.search()).toEqual({ event: 'push', wf: CI, sel: 'test[node=20]' });
  });

  it("follows the browser's own Back and Forward, and leaves an edit pending at the move unwritten", async () => {
    const r = await mountRouter('/', true);
    loaded(r.store);
    await r.settle();
    r.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    await r.settle();
    expect(window.location.search).toContain('event=pull_request');

    await r.go(() => r.history.back());
    await r.settle(0);
    expect(window.location.search).toContain('event=push');
    expect(r.store.getState().scenario).toEqual({ event: 'push', branch: 'main' });

    r.store.getState().patchScenario({ branch: 'feature' });
    await r.go(() => r.history.forward());
    await r.settle();
    expect(r.store.getState().scenario).toEqual({ event: 'pull_request', base: 'main' });
    await r.go(() => r.history.back());
    await r.settle(0);
    expect(r.search()).toEqual({ event: 'push', branch: 'main', wf: CI });
    r.history.destroy();
  });

  it('writes the next edit after Back over the entry Back led to, with that entry as its base', async () => {
    const r = await mountRouter('/');
    loaded(r.store);
    await r.settle();
    r.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    await r.settle();
    await r.go(() => r.history.back());

    r.store.getState().patchScenario({ branch: 'feature' });
    await r.settle();
    expect(r.search()).toEqual({ event: 'push', branch: 'feature', wf: CI });
    await r.go(() => r.history.forward());
    expect(r.search()).toEqual({ event: 'pull_request', base: 'main', wf: CI });
    expect(r.store.getState().scenario).toEqual({ event: 'pull_request', base: 'main' });
  });

  it('never writes a pending edit over the entry Back led to', async () => {
    const r = await mountRouter('/');
    loaded(r.store);
    await r.settle();
    r.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    await r.settle();
    r.store.getState().patchScenario({ base: 'develop' });
    await r.go(() => r.history.back());
    await r.settle();

    expect(r.search()).toEqual({ event: 'push', branch: 'main', wf: CI });
    expect(r.store.getState().scenario).toEqual({ event: 'push', branch: 'main' });
  });

  it('pushes an event change even when another edit follows it within the quiet period', async () => {
    const r = await mountRouter('/');
    loaded(r.store);
    await r.settle();
    r.store.getState().setScenario({ event: 'pull_request', base: 'main' });
    await r.settle(100);
    r.store.getState().patchScenario({ base: 'develop' });
    await r.settle();

    expect(r.history.length).toBe(2);
    await r.go(() => r.history.back());
    expect(r.store.getState().scenario.event).toBe('push');
  });

  it('keeps what the author typed while the event field is empty, and leaves the URL as it was', async () => {
    const r = await mountRouter('/');
    loaded(r.store);
    await r.settle();
    r.store.getState().setScenario(withEvent(r.store.getState().scenario, ''));
    await r.settle();

    expect(r.store.getState().scenario).toEqual({ event: '', branch: 'main' });
    expect(r.store.getState().scenarioFrom).toBe('author');
    expect(r.search()).toEqual({ event: 'push', branch: 'main', wf: CI });
    expect(r.history.length).toBe(1);
    r.store.getState().patchScenario({ event: 'pull_request' });
    await r.settle();
    await r.go(() => r.history.back());
    expect(r.store.getState().scenario).toEqual({ event: 'push', branch: 'main' });
  });

  it("writes the page's own default in place of the entry, whatever event it held", async () => {
    const r = await mountRouter('/?event=push&branch=main');
    const a = r.store.getState();
    a.projectReady(1, outline, 1);
    a.setScenario({ event: 'pull_request', base: 'main' }, { assumed: ['event'], from: 'default' });
    await r.settle();

    expect(r.search()).toEqual({ event: 'pull_request', base: 'main' });
    expect(r.history.length).toBe(1);
  });
});

describe('a scenario the page cannot render', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mountView(event: string) {
    const store = createSessionStore();
    const a = store.getState();
    const files = {
      [CI]: 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: make }]\n',
    };
    a.setFiles(files, { kind: 'sample', name: 'starter' });
    a.projectReady(1, outline, 1);
    const plan = simulate({ files, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    const derived = deriveTables(plan, outline);
    a.planReceived({
      plan,
      derived,
      text: 'ci.yml ● build',
      ms: { simulate: 1, derive: 0 },
      for: { files: 1, epoch: 1, project: 1 },
    });
    a.setScenario({ event }, { from: 'url' });
    a.setView('text');
    const app = { store, sources: { canPickFolder: false } } as unknown as App;
    render(createElement(AppProvider, { app, children: createElement(SimulateView) }));
    return store;
  }

  it('shows the error in place of the form and the plan, the top bar and the source menu still there', () => {
    mountView('boom');
    expect(screen.getByRole('alert').textContent).toContain('cannot show boom');
    expect(screen.getByRole('navigation', { name: 'Source' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paste YAML' })).toBeTruthy();
    expect(screen.queryByLabelText('The plan')).toBeNull();
  });

  it("puts back the page's own scenario from its button, and shows the form again", () => {
    const store = mountView('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Put back the default scenario' }));
    expect(store.getState().scenario).toEqual({ event: 'push', branch: 'main' });
    expect(store.getState().scenarioFrom).toBe('default');
    expect(screen.getByText('the form for push')).toBeTruthy();
    expect(screen.getByLabelText('The plan').textContent).toContain('build');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tries the form again when the scenario changes from elsewhere', () => {
    const store = mountView('boom');
    act(() => store.getState().setScenario({ event: 'pull_request' }, { from: 'url' }));
    expect(screen.getByText('the form for pull_request')).toBeTruthy();
  });
});
