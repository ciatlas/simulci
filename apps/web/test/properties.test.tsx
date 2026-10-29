// @vitest-environment happy-dom
/**
 * Properties, the Node tab in edit mode (synthesis § 4.4): fields show what the file says, with its line; a field
 * commits on Enter and on blur, and a visit to it is one undo entry; a refused commit says why under the field; a value
 * the field cannot write in place is shown read-only with its fix; key-value rows add and remove pairs, an action's
 * inputs first; a locked file says why and takes no input; the `i` key's request puts the focus in Run if.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import catalog from '../src/catalog/catalog.json';
import { Properties } from '../src/edit/property/Properties';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const CI = '.github/workflows/ci.yml';
const LOCK = '.github/workflows/ci.lock.yml';
const ACTION = '.github/actions/deploy/action.yml';

const TEXT = `on: push
jobs:
  build:
    runs-on: &runner ubuntu-latest
    timeout-minutes: 10
    env:
      CI: 'true'
    steps:
      - uses: actions/checkout@v4
      - name: Test
        run: npm test
  deploy:
    needs: build
    runs-on: *runner
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: write
    steps:
      - uses: ./.github/actions/deploy
        with:
          env: prod
          colour: blue
`;

const ACTION_TEXT = `name: Deploy
inputs:
  env: { required: true }
  wait: { default: '30' }
runs: { using: node20, main: index.js }
`;

/** A store showing the plan of the files under push to main, in edit mode, with a node selected. */
function opened(files: Record<string, string>, sel: string | undefined, focus = CI): SessionStore {
  const store = createSessionStore();
  const s = store.getState();
  s.setFiles(files, { kind: 'folder', name: 'repo', readAt: 0 });
  const loaded = handle(initialState(), { id: 1, type: 'load', files });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  s.projectReady(1, loaded.response.outline, 1);
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario: { event: 'push', branch: 'main' },
    assume: [],
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  const { plan, derived, text, ms } = step.response;
  s.planReceived({ plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1 } });
  s.setEdit(true);
  s.select(focus, sel);
  return store;
}

function mount(store: SessionStore) {
  render(
    <AppProvider app={{ store } as unknown as App}>
      <Properties />
    </AppProvider>,
  );
  return userEvent.setup();
}

const text = (store: SessionStore, path = CI): string => store.getState().files.byPath[path]!;
const fieldOf = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-field="${key}"]`)!;

afterEach(cleanup);

describe('Properties', () => {
  it('shows a job’s fields as the file writes them, each with its line', () => {
    const store = opened({ [CI]: TEXT }, 'build');
    mount(store);
    expect(screen.getByRole('heading', { name: 'build' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Timeout (minutes)' }).value).toBe('10');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).placeholder).toBe('build');
    expect(within(fieldOf('timeout-minutes')).getByRole('button', { name: /line 5/ })).toBeTruthy();
    expect(within(fieldOf('if')).queryByRole('button', { name: /line/ })).toBeNull();
    // build's steps, each selecting its step.
    expect([...document.querySelectorAll('[data-step-name]')].map((b) => b.textContent)).toEqual([
      '1actions/checkout@v4',
      '2Test',
    ]);
  });

  it('commits on Enter and on blur, and a visit to the field is one undo entry', async () => {
    const store = opened({ [CI]: TEXT }, 'build');
    const user = mount(store);
    const timeout = screen.getByRole('textbox', { name: 'Timeout (minutes)' });
    await user.click(timeout);
    await user.clear(timeout);
    await user.type(timeout, '20{Enter}');
    expect(text(store)).toContain('    timeout-minutes: 20\n');
    await user.clear(timeout);
    await user.type(timeout, '30');
    await user.tab();
    expect(text(store)).toContain('    timeout-minutes: 30\n');
    expect(store.getState().edit.past.map((t) => t.label)).toEqual(["Set build's timeout-minutes"]);
    act(() => void store.getState().undo());
    expect(text(store)).toBe(TEXT);
  });

  it('removes a key whose field is emptied, and keeps a number field’s expression a string', async () => {
    const store = opened({ [CI]: TEXT }, 'build');
    const user = mount(store);
    const timeout = screen.getByRole('textbox', { name: 'Timeout (minutes)' });
    await user.click(timeout);
    await user.clear(timeout);
    await user.type(timeout, '${{{{ vars.T }}{Enter}');
    expect(text(store)).toContain('    timeout-minutes: ${{ vars.T }}\n');
    await user.clear(timeout);
    await user.tab();
    expect(text(store)).not.toContain('timeout-minutes');
  });

  it('says why a commit was refused under the field, with the refusal’s fixes', async () => {
    const store = opened({ [CI]: TEXT }, 'build');
    const user = mount(store);
    const runsOn = screen.getByRole('combobox', { name: 'Runs on' });
    await user.click(runsOn);
    await user.clear(runsOn);
    await user.type(runsOn, 'macos-latest{Enter}');
    expect(text(store)).toBe(TEXT);
    const note = within(fieldOf('runs-on'));
    expect(note.getByText(/reuses/)).toBeTruthy();
    await user.click(note.getByRole('button', { name: 'Change only here' }));
    expect(text(store)).toContain('    runs-on: macos-latest\n');
    expect(text(store)).toContain('    runs-on: ubuntu-latest\n');
    expect(store.getState().edit.past).toHaveLength(1);
  });

  it('shows an aliased value read-only, with why and its fix, which is one undo entry', async () => {
    const store = opened({ [CI]: TEXT }, 'deploy');
    const user = mount(store);
    const runsOn = within(fieldOf('runs-on'));
    expect(runsOn.queryByRole('combobox')).toBeNull();
    expect(fieldOf('runs-on').querySelector('pre')!.textContent).toBe('*runner');
    expect(fieldOf('runs-on').textContent).toContain(
      "deploy's runs-on is *runner, a reference to &runner on line 4.",
    );
    await user.click(runsOn.getByRole('button', { name: "Give deploy's runs-on its own value" }));
    expect(text(store)).toContain('    runs-on: ubuntu-latest\n    if:');
    expect(store.getState().edit.past).toHaveLength(1);
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Runs on' }).value).toBe('ubuntu-latest');
  });

  it('lists what the plan says the condition evaluates to, as of the last plan once the text moved', async () => {
    const store = opened({ [CI]: TEXT }, 'deploy');
    const user = mount(store);
    const evaluates = () => fieldOf('if').querySelector('[data-evaluates]')!.textContent;
    expect(evaluates()).toBe('evaluates to true with github.ref is "refs/heads/main"');
    const runIf = screen.getByRole('textbox', { name: 'Run if' });
    await user.click(runIf);
    await user.clear(runIf);
    await user.type(runIf, 'false{Enter}');
    expect(text(store)).toContain("    if: 'false'\n");
    expect(evaluates()).toContain('(as of the last plan)');
  });

  it('edits an env pair, adds one and removes one, each an entry', async () => {
    const store = opened({ [CI]: TEXT }, 'build');
    const user = mount(store);
    const env = within(screen.getByRole('region', { name: 'Env' }));
    const ci = env.getByRole('textbox', { name: 'CI' });
    await user.click(ci);
    await user.clear(ci);
    await user.type(ci, 'false{Enter}');
    await user.tab();
    expect(text(store)).toContain("      CI: 'false'\n");
    await user.type(env.getByRole('textbox', { name: 'New key of Env' }), 'NODE');
    await user.type(env.getByRole('textbox', { name: 'Value of the new key of Env' }), '22{Enter}');
    expect(text(store)).toContain("      CI: 'false'\n      NODE: '22'\n");
    await user.click(env.getByRole('button', { name: 'Remove CI' }));
    expect(text(store)).toContain("    env:\n      NODE: '22'\n");
    expect(store.getState().edit.past).toHaveLength(3);
  });

  it('offers a local action’s inputs as With rows, the required first, and names a key it does not declare', () => {
    const store = opened({ [CI]: TEXT, [ACTION]: ACTION_TEXT }, 'deploy.#1');
    mount(store);
    const rows = within(screen.getByRole('region', { name: 'With' }));
    expect(
      rows
        .getAllByRole('textbox', { name: /^(env|colour|wait)$/ })
        .map((i) => i.getAttribute('aria-label') ?? i.id),
    ).toHaveLength(3);
    expect(rows.getByRole<HTMLInputElement>('textbox', { name: 'wait' }).placeholder).toBe('30');
    expect(rows.getByText('not an input of Deploy')).toBeTruthy();
  });

  it('offers a common action’s inputs from the catalog, warns of a required one not set, and pins it to its commit', async () => {
    const upload = catalog.find((a) => a.uses === 'actions/upload-artifact')!;
    const by = `actions/upload-artifact@${upload.ref}`;
    const store = opened(
      { [CI]: `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${by}\n` },
      'build.#1',
    );
    const user = mount(store);
    const rows = within(screen.getByRole('region', { name: 'With' }));
    // The catalog's chunk comes in, then its rows.
    const path = await rows.findByRole('textbox', { name: 'path' });
    expect(path.closest('[class*="border-might"]')).toBeTruthy();
    expect(rows.getByText(`required by ${by}, and not set`)).toBeTruthy();
    expect(rows.getAllByRole('textbox', { name: /^(?!New key|Value of)/ })).toHaveLength(
      upload.inputs.length,
    );
    // Setting it takes the warning away.
    await user.type(path, 'dist{Enter}');
    expect(text(store)).toContain(`      - uses: ${by}\n        with:\n          path: dist\n`);
    expect(rows.queryByText(`required by ${by}, and not set`)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Pin to SHA' }));
    expect(text(store)).toContain(`      - uses: actions/upload-artifact@${upload.sha} # ${upload.ref}\n`);
    expect(screen.getByText(`Pinned to ${upload.ref}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pin to SHA' })).toBeNull();
    expect(store.getState().edit.past.at(-1)?.label).toBe(
      `Pinned the action of build's step 1 to ${upload.ref}'s commit`,
    );
  });

  it('offers no pin for a ref the catalog has no commit of, and says which it has', async () => {
    const checkout = catalog.find((a) => a.uses === 'actions/checkout')!;
    const store = opened({ [CI]: TEXT }, 'build.#1');
    mount(store);
    expect(await screen.findByText(`The catalog records the commit of ${checkout.ref} only`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pin to SHA' })).toBeNull();
  });

  it('says why a generated file takes no input, and Edit anyway unlocks it', async () => {
    const store = opened({ [LOCK]: `# Code generated by gen. DO NOT EDIT.\n${TEXT}` }, 'build', LOCK);
    const user = mount(store);
    expect(screen.getByText(/is generated/)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Timeout (minutes)' }).readOnly).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Edit anyway' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Timeout (minutes)' }).readOnly).toBe(false);
  });

  it('takes the i key’s request: the focus goes to Run if, its text selected', () => {
    const store = opened({ [CI]: TEXT }, 'deploy');
    mount(store);
    act(() => store.getState().focusProperty('if'));
    const runIf = screen.getByRole<HTMLInputElement>('textbox', { name: 'Run if' });
    expect(document.activeElement).toBe(runIf);
    expect(store.getState().propertyFocus).toBeUndefined();
    expect(store.getState().ui.prefs.panel).toBe('node');
  });

  it('selects a step from the job’s list, and shows a step’s fields', async () => {
    const store = opened({ [CI]: TEXT }, 'build');
    const user = mount(store);
    await user.click(screen.getByRole('button', { name: /Test$/ }));
    expect(store.getState().sel).toBe('build.#2');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Run' }).value).toBe('npm test');
    fireEvent.focus(screen.getByRole('textbox', { name: 'Name' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
  });
});
