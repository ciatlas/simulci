// @vitest-environment happy-dom
import { installStaleClock } from '../src/app/stale';
import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { installShortcuts } from '../src/app/shortcuts';
import { SimulateView } from '../src/app/SimulateView';
import { StatusBar } from '../src/app/StatusBar';
import { sampleByName } from '../src/input/samples';
import { Gate } from '../src/panels/kit';
import { summarize } from '../src/plan/summary';
import { createSessionStore, type PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const chunk = vi.hoisted(() => ({ fails: false }));

/** The YAML pane as built, or, while `chunk.fails`, an editor chunk that could not load. */
vi.mock('../src/yaml/YamlPane', async (importOriginal) => {
  const built = await importOriginal<typeof import('../src/yaml/YamlPane')>();
  return {
    YamlPane: () => {
      if (chunk.fails) throw new TypeError('Failed to fetch dynamically imported module');
      return createElement(built.YamlPane);
    },
  };
});

/**
 * The YAML pane's module (CodeMirror under the mock above), imported before any test opens the pane, as the page's
 * lazy import would fetch it. A test's wait then covers what it checks, the editor or its error boundary, and not the
 * module's cold import, which a CI runner busy with other test files has made take over a second.
 */
beforeAll(async () => {
  await import('../src/yaml/YamlPane');
});

/** The screen over the starter sample: a push to main that changes src/, simulated by the worker's own `handle`. */
function mount() {
  const files = sampleByName('starter')!.files;
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  if (loaded.response.type !== 'loaded') throw new Error(loaded.response.type);
  const scenario: ScenarioInput = { event: 'push', branch: 'main', changed: ['src/a.ts'] };
  const r = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (r.response.type !== 'plan') throw new Error(r.response.type);
  const store = createSessionStore();
  const a = store.getState();
  a.setFiles(files, { kind: 'sample', name: 'starter' });
  a.projectReady(1, loaded.response.outline, 1);
  a.setScenario(scenario, { from: 'url' });
  a.setFocus('.github/workflows/ci.yml');
  const { plan, derived, text, ms } = r.response;
  a.planReceived({ plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1 } });
  const app = { store, sources: { canPickFolder: false } } as unknown as App;
  render(
    <AppProvider app={app}>
      <SimulateView />
    </AppProvider>,
  );
  return { store, user: userEvent.setup() };
}

const happy = () =>
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;

const classes = (el: Element): string[] => el.className.split(/\s+/);

/** The status line's live region: the sentence alone, without Details beside it. */
const liveLine = (): HTMLElement =>
  screen.getByRole('contentinfo').querySelector<HTMLElement>('[aria-live]')!;

function resize(width: number): void {
  act(() => {
    happy().setViewport({ width, height: 768 });
    window.dispatchEvent(new Event('resize'));
  });
}

describe('the screen', () => {
  afterEach(() => {
    cleanup();
    resize(1024);
    chunk.fails = false;
    vi.restoreAllMocks();
  });

  it('puts the outline below the scenario form, and the run graph beside them', () => {
    mount();
    const column = screen.getByRole('complementary', { name: 'Scenario and outline' });
    const tree = within(column).getByRole('tree', { name: 'Outline' });
    const form = within(column).getAllByRole('combobox')[0]!;
    expect(form.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: 'CI, runs' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'The run graph' }).textContent).toContain(
      'Laying out the graph',
    );
    expect(screen.queryByLabelText('The plan')).toBeNull();
  });

  it('puts the plan details beside the graph, on the tab the author last opened', () => {
    const { store } = mount();
    const details = screen.getByRole('complementary', { name: 'Plan details' });
    expect(within(details).getByRole('tab', { name: 'Reasons', selected: true })).toBeTruthy();
    act(() => store.getState().setPanel('problems'));
    expect(within(details).getByRole('tab', { name: /^Problems/, selected: true })).toBeTruthy();
    act(() => store.getState().togglePane('right'));
    expect(screen.queryByRole('complementary', { name: 'Plan details' })).toBeNull();
  });

  it('shows the plan as text when the author picks it, and the graph again on the next pick', async () => {
    const { store, user } = mount();
    await user.click(screen.getByRole('button', { name: 'Text' }));
    expect(store.getState().ui.view).toBe('text');
    expect(screen.getByLabelText('The plan').textContent).toContain('deploy');
    expect(screen.queryByRole('region', { name: 'The run graph' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Graph' }));
    expect(screen.getByRole('region', { name: 'The run graph' })).toBeTruthy();
  });

  it('shows the text below 1024 px whatever the author picked, and the graph once there is room again', () => {
    const { store } = mount();
    resize(800);
    expect(store.getState().ui.view).toBe('graph');
    expect(screen.getByLabelText('The plan')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'The run graph' })).toBeNull();
    resize(1280);
    expect(screen.getByRole('region', { name: 'The run graph' })).toBeTruthy();
  });

  it('offers the closed YAML pane under the plan, naming its key while the page keys are on', async () => {
    const { store, user } = mount();
    expect(screen.queryByRole('region', { name: 'Workflow source' })).toBeNull();
    const open = screen.getByRole('button', { name: 'Open the workflow source' });
    expect(open.getAttribute('aria-keyshortcuts')).toBe('\\');
    act(() => store.getState().setPrefs({ keys: false }));
    expect(open.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(open.textContent).toBe('Open the workflow source');
    await user.click(open);
    expect(await screen.findByRole('region', { name: 'Workflow source' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open the workflow source' })).toBeNull();
  });

  it('puts a rail naming its key where the scenario column or the right panel was, while the page keys are on', () => {
    const { store } = mount();
    expect(document.querySelector('[data-rail]')).toBeNull();
    act(() => {
      store.getState().togglePane('left');
      store.getState().togglePane('right');
    });
    const left = screen.getByRole('button', { name: 'Open the scenario and outline' });
    const right = screen.getByRole('button', { name: 'Open the plan details' });
    expect([left.getAttribute('aria-keyshortcuts'), right.getAttribute('aria-keyshortcuts')]).toEqual([
      '[',
      ']',
    ]);
    act(() => store.getState().setPrefs({ keys: false }));
    expect([left.hasAttribute('aria-keyshortcuts'), right.textContent]).toEqual([
      false,
      'Open the plan details',
    ]);
    // Where the panel is a row (768 to 1023 px), its bar takes its own height under the plan, which keeps the rest.
    expect(classes(screen.getByRole('main'))).toEqual(
      expect.arrayContaining(['md:grid-rows-[minmax(0,1fr)_auto]', 'lg:grid-rows-[minmax(0,1fr)]']),
    );
  });

  it("opens a pane from its rail by a click or by its key, with the focus on the pane's first stop", async () => {
    const { store, user } = mount();
    const stop = installShortcuts(store);
    try {
      act(() => {
        store.getState().togglePane('left');
        store.getState().togglePane('right');
      });
      await user.click(screen.getByRole('button', { name: 'Open the scenario and outline' }));
      expect(store.getState().ui.prefs.collapsed.left).toBe(false);
      expect(screen.queryByRole('button', { name: 'Open the scenario and outline' })).toBeNull();
      const column = screen.getByRole('complementary', { name: 'Scenario and outline' });
      await waitFor(() => expect(column.contains(document.activeElement)).toBe(true));
      expect(document.activeElement).toBe(within(column).getAllByRole('combobox')[0]);

      screen.getByRole('button', { name: 'Open the plan details' }).focus();
      fireEvent.keyDown(document.activeElement!, { key: ']' });
      expect(store.getState().ui.prefs.collapsed.right).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Reasons' })));
    } finally {
      stop();
    }
  });

  it('leaves the focus where it was when a key opens a pane from elsewhere', async () => {
    const { store } = mount();
    const stop = installShortcuts(store);
    try {
      act(() => store.getState().togglePane('left'));
      const plan = document.querySelector<HTMLElement>('[data-plan]')!;
      plan.focus();
      fireEvent.keyDown(plan, { key: '[' });
      expect(store.getState().ui.prefs.collapsed.left).toBe(false);
      await new Promise((done) => requestAnimationFrame(done));
      expect(document.activeElement).toBe(plan);
    } finally {
      stop();
    }
  });

  it('keeps an editor that could not load inside the YAML pane, with a way to close it and one to reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    chunk.fails = true;
    const { store, user } = mount();
    act(() => store.getState().togglePane('yaml'));
    const pane = await screen.findByRole('region', { name: 'Workflow source' });
    const alert = await within(pane).findByRole('alert');
    expect(alert.textContent).toContain('The editor could not load.');
    expect(screen.getByRole('form', { name: 'Scenario' })).toBeTruthy();
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    await user.click(within(alert).getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledOnce();
    await user.click(within(alert).getByRole('button', { name: 'Close the workflow source' }));
    expect(store.getState().ui.prefs.collapsed.yaml).toBe(true);
    expect(document.activeElement?.hasAttribute('data-plan')).toBe(true);
    expect([store.getState().scenarioFrom, store.getState().scenario.branch]).toEqual(['url', 'main']);
  });

  it('hands the focus to the plan when [, ] or \\ closes the pane that holds it', async () => {
    const { store } = mount();
    const stop = installShortcuts(store);
    try {
      const plan = () => document.querySelector('[data-plan]');
      screen.getByRole('treeitem', { name: 'CI, runs' }).focus();
      fireEvent.keyDown(document.activeElement!, { key: '[' });
      expect(store.getState().ui.prefs.collapsed.left).toBe(true);
      expect(document.activeElement).toBe(plan());
      screen.getByRole('tab', { name: 'Reasons' }).focus();
      fireEvent.keyDown(document.activeElement!, { key: ']' });
      expect(store.getState().ui.prefs.collapsed.right).toBe(true);
      expect(document.activeElement).toBe(plan());
      act(() => store.getState().togglePane('yaml'));
      const pane = await screen.findByRole('region', { name: 'Workflow source' });
      (await within(pane).findAllByRole('tab'))[0]!.focus();
      fireEvent.keyDown(document.activeElement!, { key: '\\' });
      expect(screen.queryByRole('region', { name: 'Workflow source' })).toBeNull();
      expect(document.activeElement).toBe(plan());
    } finally {
      stop();
    }
  });

  it('puts the focus in the Reasons panel itself with r, and makes the open panel a tab stop', async () => {
    const { store } = mount();
    const stop = installShortcuts(store);
    try {
      act(() => store.getState().setPanel('problems'));
      const details = screen.getByRole('complementary', { name: 'Plan details' });
      expect(details.querySelector('[data-panel="problems"]')?.getAttribute('tabindex')).toBe('0');
      fireEvent.keyDown(document.body, { key: 'r' });
      await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('tabpanel'));
      expect(document.activeElement?.getAttribute('data-panel')).toBe('reasons');
      expect(within(details).getByRole('tab', { name: 'Reasons', selected: true })).toBeTruthy();
    } finally {
      stop();
    }
  });

  it('turns the page keys off and on with the Shortcuts switch, which says its state in words', async () => {
    const { store, user } = mount();
    const keys = screen.getByRole('switch', { name: 'Shortcuts' });
    expect([keys.getAttribute('aria-checked'), keys.textContent]).toEqual(['true', 'Shortcuts on']);
    await user.click(keys);
    expect(store.getState().ui.prefs.keys).toBe(false);
    expect([keys.getAttribute('aria-checked'), keys.textContent]).toEqual(['false', 'Shortcuts off']);
  });

  it('lays the panes out on the classes the layout rests on (happy-dom lays nothing out)', () => {
    const { store } = mount();
    // Below 768 px every row takes its own height and the page scrolls, so the open YAML pane starves no row.
    expect(classes(screen.getByRole('main'))).toEqual(
      expect.arrayContaining(['auto-rows-max', 'md:auto-rows-auto']),
    );
    // From 768 to 1023 px the scenario column spans the plan and the panel under it; alone, the plan has the height.
    const column = screen.getByRole('complementary', { name: 'Scenario and outline' });
    expect(classes(column)).toEqual(expect.arrayContaining(['md:row-span-2', 'lg:row-span-1']));
    // The scrollers hold their sr-only text, which would otherwise scroll the page.
    const details = screen.getByRole('complementary', { name: 'Plan details' });
    expect(classes(column)).toContain('relative');
    expect(classes(within(details).getByRole('tabpanel'))).toContain('relative');
    // Closed, the panel leaves its rail in that row, so the column still spans it.
    act(() => store.getState().togglePane('right'));
    expect(classes(column)).toContain('md:row-span-2');
  });

  it('draws an undecided gate in the amber kept for text, and names it', () => {
    render(<Gate gate={{ known: false, unknowns: [] }} />);
    const gate = screen.getByRole('img', { name: 'undecided' });
    expect([gate.textContent, classes(gate).includes('text-might-text')]).toEqual(['?', true]);
  });
});

describe('the status line', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const files = sampleByName('starter')!.files;
  const source: ScenarioInput = { event: 'push', branch: 'main', changed: ['src/a.ts'] };
  const detect: AssumeEntry = { step: 'build.detect', outputs: { changed: 'true' } };

  /** The starter's plan for exactly these inputs, as the session hands it to the store. */
  function planOf(scenario: ScenarioInput, assume: AssumeEntry[]): PlanState {
    const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
    const r = handle(loaded.state, {
      id: 2,
      type: 'simulate',
      project: 1,
      scenario,
      assume,
      detail: 'steps',
    });
    if (r.response.type !== 'plan') throw new Error(r.response.type);
    const { plan, derived, text, ms } = r.response;
    return { plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1, assume, scenario } };
  }

  /** The store answers the inputs it holds now with their plan. */
  const answer = (store: ReturnType<typeof createSessionStore>): PlanState => {
    const s = store.getState();
    const plan = planOf(s.scenario, s.assume);
    act(() => s.planReceived(plan));
    return plan;
  };
  const wait = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('says what a pin changed for the plan that answers it, half a second behind, and the summary for the next', () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    store.getState().setScenario(source);
    render(
      <AppProvider app={{ store } as unknown as App}>
        <StatusBar />
      </AppProvider>,
    );
    const line = liveLine();
    expect(line.getAttribute('aria-live')).toBe('polite');
    const first = answer(store);
    wait(500);
    const summary = summarize(first.plan).sentence;
    expect(line.textContent).toBe(summary);

    act(() => store.getState().pinAssume([detect]));
    answer(store);
    wait(499);
    expect(line.textContent).toBe(summary);
    wait(1);
    expect(line.textContent).toBe('pinned; build.#3 now runs');

    // A pin made since says nothing until its own plan comes.
    act(() => store.getState().pinAssume([]));
    wait(500);
    expect(line.textContent).toBe('pinned; build.#3 now runs');
    answer(store);
    wait(500);
    expect(line.textContent).toBe('pinned; build.#3 now might run');

    // Another plan for the same inputs says its own summary: the pin spoke for the plan that answered it.
    const next = answer(store);
    wait(500);
    expect(store.getState().change?.after).toBeDefined();
    expect(line.textContent).toBe(summarize(next.plan).sentence);
  });

  it('lists what the change did in Details beside the sentence, each row selecting what it names', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = createSessionStore();
    store.getState().setScenario(source);
    render(
      <AppProvider app={{ store } as unknown as App}>
        <StatusBar />
      </AppProvider>,
    );
    answer(store);
    wait(500);
    // A summary has no Details.
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    act(() => store.getState().pinAssume([detect]));
    answer(store);
    wait(500);
    expect(liveLine().textContent).toBe('pinned; build.#3 now runs');
    // Outside the live region, which reads the sentence alone.
    const details = screen.getByRole('button', { name: 'Details' });
    expect(liveLine().contains(details)).toBe(false);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(details);
    const rows = await screen.findByRole('list', { name: 'What changed' });
    await user.click(within(rows).getByRole('button', { name: 'build.#3 now runs' }));
    expect([store.getState().focus, store.getState().sel]).toEqual(['.github/workflows/ci.yml', 'build.#3']);
  });

  /** The status line over a store that holds the starter's first plan, said. */
  function said() {
    vi.useFakeTimers();
    const store = createSessionStore();
    store.getState().setScenario(source);
    installStaleClock({ store });
    render(
      <AppProvider app={{ store } as unknown as App}>
        <StatusBar />
      </AppProvider>,
    );
    answer(store);
    wait(500);
    return { store, line: liveLine() };
  }

  it('says a pin’s sentence in an element of its own, so the live region reads it again when the last pin said the same', () => {
    const { store, line } = said();
    const summary = line.firstElementChild;
    // Pinning the list it holds changes no verdict, every time.
    act(() => store.getState().pinAssume([]));
    answer(store);
    wait(500);
    const first = line.firstElementChild;
    expect(first?.textContent).toBe('pinned; no verdict changed');
    expect(first).not.toBe(summary);

    act(() => store.getState().pinAssume([]));
    answer(store);
    wait(500);
    const second = line.firstElementChild;
    expect(second?.textContent).toBe('pinned; no verdict changed');
    expect(second).not.toBe(first);
    expect(first?.isConnected).toBe(false);

    // The summary of every other plan keeps its element, and says only what changed.
    const again = answer(store);
    wait(500);
    const back = line.firstElementChild;
    expect(back?.textContent).toBe(summarize(again.plan).sentence);
    answer(store);
    wait(500);
    expect(line.firstElementChild).toBe(back);
  });

  it('sets a stale sentence in italics, at the contrast of the rest of the line', () => {
    const { store, line } = said();
    const sentence = line.firstElementChild!;
    expect(classes(sentence)).not.toContain('italic');
    act(() => store.getState().patchScenario({ message: 'docs' }));
    expect(store.getState().stale).toBe('inputs');
    expect(classes(sentence)).toContain('italic');
    expect(sentence.className).not.toMatch(/opacity/);
  });
});
