// @vitest-environment happy-dom
/**
 * Remote states on the canvas (M4 synthesis § 5.4), from the plan alone: a simulated callee's header, the stub of one
 * not fetched or not read, what the Node tab says of each and of a remote action step, places in a remote's file as
 * GitHub links at the commit read, the status bar's line, Retry, and the edit refusal inside a remote callee.
 */
import type { RunPlan } from '@simulci/engine';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { RemotesChip } from '../src/app/RemotesChip';
import { gesturesOf } from '../src/edit/canvas/actions';
import type { GestureUi } from '../src/edit/canvas/ui';
import { retryRemotes } from '../src/engine/remotes';
import { graphModel } from '../src/graph/model';
import {
  blobUrl,
  failureWords,
  pinnedWords,
  remoteHref,
  remoteName,
  remoteScopes,
  remoteStub,
  remoteTitle,
} from '../src/graph/remote';
import { callFrame, cardSize } from '../src/graph/size';
import type { GraphUi, Metrics } from '../src/graph/types';
import { LocLink } from '../src/panels/kit';
import { type Fact, nodeFacts } from '../src/panels/node-facts';
import { planIndex } from '../src/plan/index';
import { createSessionStore, type PlanState, remotePoolKey, type SessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';
import type { RemotePool } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';
const DEPLOY = 'octo/ship/.github/workflows/deploy.yml@v1';
const GONE = 'octo/ship/.github/workflows/gone.yml@v1';
const LATER = 'octo/ship/.github/workflows/later.yml@v1';
const ACT = 'octo/act@v2';
const COMP = 'octo/comp@v1';
const SHA = '4a7c0e1'.padEnd(40, '0');
const CALL = `${CI}#call`;
const CALLEE = `${CALL}>${DEPLOY}`;

const caller = `on: push
jobs:
  call:
    uses: ${DEPLOY}
    with:
      env: prod
  gone:
    uses: ${GONE}
  later:
    uses: ${LATER}
  skipped:
    if: false
    uses: ${LATER}
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACT}
      - uses: ${COMP}
      - uses: octo/unread@v3
`;

const deploy = `on:
  workflow_call:
    inputs:
      env:
        type: string
    outputs:
      released:
        value: \${{ jobs.ship.outputs.r }}
jobs:
  ship:
    if: inputs.env == 'prod'
    runs-on: ubuntu-latest
    outputs:
      r: 'yes'
    steps:
      - run: echo ship
`;

const node20 = `name: act
outputs:
  x:
    description: x
runs:
  using: node20
  main: index.js
`;

const composite = `name: comp
outputs:
  y:
    description: y
    value: ok
runs:
  using: composite
  steps:
    - run: echo
      shell: bash
`;

/** The pool a page holds after Fetch: deploy, the two actions read live; gone private; later not asked. */
const pool: RemotePool = {
  sources: [
    { ref: DEPLOY, kind: 'workflow', sha: SHA, text: deploy, pinned: 'resolved' },
    { ref: ACT, kind: 'action', sha: SHA, text: node20, pinned: 'resolved' },
    { ref: COMP, kind: 'action', sha: SHA, text: composite, pinned: 'resolved' },
  ],
  failed: [{ ref: GONE, kind: 'workflow', failure: 'access', message: 'Not Found' }],
};

/** The worker's plan of the caller with the pool, as the store holds it. */
function planned(remotes: RemotePool | null = pool): PlanState {
  const files = { [CI]: caller };
  const loaded = handle(initialState(), { id: 1, type: 'load', files, ...(remotes ? { remotes } : {}) });
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
  return { plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1 } };
}

const UI: GraphUi = { expanded: [], representative: {}, opened: [], hideUntriggered: false };
const metrics: Metrics = { width: (t) => t.length * 7 };
const facts = (p: PlanState, node: string): Record<string, Fact[]> =>
  Object.fromEntries(nodeFacts(p, planIndex(p), node).map((s) => [s.title, s.facts]));
const said = (list: Fact[] | undefined): Record<string, string> =>
  Object.fromEntries(
    (list ?? []).map((f) => [f.label, 'text' in f.value ? f.value.text : JSON.stringify(f.value)]),
  );

afterEach(() => cleanup());

describe('the words of a remote', () => {
  it('names a remote by its repository, file and ref, and none for a local or docker uses', () => {
    expect(remoteName(DEPLOY)).toEqual({
      owner: 'octo',
      repo: 'ship',
      path: '.github/workflows/deploy.yml',
      ref: 'v1',
    });
    expect(remoteName(ACT)).toEqual({ owner: 'octo', repo: 'act', ref: 'v2' });
    expect(remoteName('./.github/workflows/x.yml')).toBeUndefined();
    expect(remoteName('docker://alpine:3@sha256:1')).toBeUndefined();
    expect(remoteTitle(DEPLOY)).toBe('octo/ship · deploy.yml @ v1');
    expect(remoteTitle(ACT)).toBe('octo/act @ v2');
  });

  it('says where a commit came from, and which failures a Retry may help', () => {
    expect(pinnedWords('resolved', DEPLOY)).toBe('Read at v1 today; the tag can move.');
    expect(pinnedWords('actions-lock', ACT)).toBe('Pinned by actions.lock.');
    expect(pinnedWords('lockfile', DEPLOY)).toBe('Pinned by remotes.lock.yml.');
    expect(failureWords('access')).toEqual({
      words: 'not found, or private (sign in on a simulci server)',
      retry: false,
    });
    expect(failureWords('unreachable')).toEqual({ words: 'GitHub did not answer', retry: true });
    expect(failureWords('rate-limit').retry).toBe(true);
  });

  it('links a line of a remote file at a commit, on its host', () => {
    expect(blobUrl(remoteName(DEPLOY)!, SHA, 12)).toBe(
      `https://github.com/octo/ship/blob/${SHA}/.github/workflows/deploy.yml#L12`,
    );
    expect(blobUrl(remoteName(ACT)!, SHA, undefined, 'ghe.example')).toBe(
      `https://ghe.example/octo/act/blob/${SHA}/action.yml`,
    );
  });

  it('reads a ref read at two commits at the one around the node, and links none without it', () => {
    const OTHER = 'b'.repeat(40);
    const plan = {
      remotes: [
        { ref: ACT, kind: 'action', state: 'simulated', at: ['a'], sha: SHA, pinned: 'actions-lock' },
        { ref: ACT, kind: 'action', state: 'simulated', at: ['b'], sha: OTHER, pinned: 'resolved' },
      ],
      workflows: [],
    } as unknown as RunPlan;
    const loc = { file: ACT, line: 3 };
    expect(remoteHref(plan, loc)).toBeUndefined();
    const near = [{ remote: { ref: ACT, sha: OTHER } }] as never;
    expect(remoteHref(plan, loc, near)).toBe(`https://github.com/octo/act/blob/${OTHER}/action.yml#L3`);
    expect(remoteHref(plan, { file: CI, line: 3 })).toBeUndefined();
  });

  it('stubs every state but simulated, with Fetch or Retry where a click may help', () => {
    const row = { ref: DEPLOY, kind: 'workflow' as const, at: [CALL] };
    expect(remoteStub({ ...row, state: 'simulated', sha: SHA })).toBeUndefined();
    expect(remoteStub({ ...row, state: 'not-fetched' })).toMatchObject({
      title: 'octo/ship · deploy.yml @ v1',
      status: 'not fetched',
      words: 'Its jobs and outputs are unknown.',
      action: 'fetch',
    });
    expect(remoteStub({ ...row, state: 'failed', failure: 'access' })).toMatchObject({
      status: 'not read',
      words: 'Not found, or private (sign in on a simulci server).',
    });
    expect(remoteStub({ ...row, state: 'failed', failure: 'access' })!.action).toBeUndefined();
    expect(remoteStub({ ...row, state: 'failed', failure: 'timeout' })!.action).toBe('retry');
    expect(remoteStub({ ...row, state: 'limit' })!.action).toBeUndefined();
  });
});

describe('the canvas', () => {
  const p = planned();
  const model = graphModel(p.plan, p.derived, UI);

  it('heads a simulated callee with its repository, file, ref and commit', () => {
    expect(model.scopes[CALLEE]).toMatchObject({
      path: DEPLOY,
      remote: { title: 'octo/ship · deploy.yml @ v1', sha: '4a7c0e1' },
      caller: CALL,
    });
    expect(model.jobs[CALL]!.callee).toBe(CALLEE);
    expect(model.jobs[CALL]!.stub).toBeUndefined();
  });

  it('widens the call card for the callee’s title bar, and a local callee’s not at all', () => {
    const call = model.jobs[CALL]!;
    expect(call.calleeHeader).toBe('octo/ship · deploy.yml @ v1 (4a7c0e1)');
    const { calleeHeader: _, ...local } = call;
    expect(callFrame(call, metrics).min.width).toBeGreaterThan(callFrame(local, metrics).min.width);
    expect(callFrame(call, metrics).min.width).toBeLessThanOrEqual(640 + 24);
  });

  it('stubs a callee not read or not fetched under its call, never one that is skipped', () => {
    expect(model.jobs[`${CI}#gone`]!.stub).toMatchObject({ state: 'failed', status: 'not read', ref: GONE });
    expect(model.jobs[`${CI}#later`]!.stub).toMatchObject({
      state: 'not-fetched',
      action: 'fetch',
      ref: LATER,
    });
    expect(model.jobs[`${CI}#skipped`]!.stub).toBeUndefined();
  });

  it('keeps room for the stub, and lays the card out again when it comes or goes', () => {
    const later = model.jobs[`${CI}#later`]!;
    const { stub: _, ...bare } = later;
    expect(cardSize(later, metrics).height).toBeGreaterThan(cardSize(bare, metrics).height + 58);
    expect(cardSize(later, metrics).width).toBeGreaterThanOrEqual(320);
    const unread = planned(null);
    const before = graphModel(unread.plan, unread.derived, UI);
    expect(before.jobs[CALL]!.stub).toMatchObject({ state: 'not-fetched' });
    expect(before.scopes[CI]!.shape).not.toBe(model.scopes[CI]!.shape);
  });
});

describe('the Node tab', () => {
  const p = planned();

  it('says where a simulated callee was read, with a link to its file at the commit, and its interface', () => {
    const f = facts(p, CALLEE);
    expect(said(f['Remote workflow'])).toMatchObject({
      repository: 'octo/ship',
      path: '.github/workflows/deploy.yml',
      ref: 'v1',
      pinned: 'Read at v1 today; the tag can move.',
    });
    expect(f['Remote workflow']!.find((x) => x.label === 'commit')!.value).toEqual({
      kind: 'link',
      text: '4a7c0e1',
      href: `https://github.com/octo/ship/blob/${SHA}/.github/workflows/deploy.yml`,
    });
    expect(said(f.Inputs)).toEqual({ env: 'prod' });
    expect(said(f.Outputs)).toEqual({ released: 'yes' });
  });

  it('says what a call not fetched might end as, the pin, and that its outputs are unknown, never empty', () => {
    const f = said(facts(p, `${CI}#later`)['Remote workflow']);
    expect(f).toMatchObject({
      ref: LATER,
      state: 'not fetched',
      might: 'success, failure or skipped',
      pin: 'assume {"job":"later","outcome":"failure"}',
      outputs: 'unknown until it is read: any a mock sets',
    });
    expect(said(facts(p, `${CI}#gone`)['Remote workflow']).state).toBe(
      'not read: access (not found, or private (sign in on a simulci server))',
    );
  });

  it('says whether a read action’s outputs are closed or open, and that an unread one’s interface is unknown', () => {
    const steps = p.plan.workflows[0]!.jobs.find((j) => j.jobId === 'build')!.legs[0]!.steps!;
    const [act, comp, unread] = steps.map((s) => said(facts(p, s.id)['Remote action']));
    expect(act).toMatchObject({
      repository: 'octo/act',
      ref: 'v2',
      outputs: expect.stringMatching(/^open: /),
    });
    expect(comp).toMatchObject({ repository: 'octo/comp', outputs: expect.stringMatching(/^closed: /) });
    expect(unread).toEqual({
      ref: 'octo/unread@v3',
      state: 'not fetched',
      interface: 'unknown; any mock output is accepted',
    });
  });
});

/** A store showing the plan, in edit mode on CI, with the selection given. */
function opened(p: PlanState, sel?: string): SessionStore {
  const store = createSessionStore();
  const s = store.getState();
  s.setFiles({ [CI]: caller }, { kind: 'sample', name: 'x' });
  s.planReceived(p);
  s.setEdit(true);
  s.select(CI, sel);
  return store;
}

const app = (store: SessionStore): App => ({ store }) as unknown as App;
const shown = (store: SessionStore, el: ReturnType<typeof createElement>) =>
  render(createElement(AppProvider, { app: app(store), children: el }));

describe('places in a remote file', () => {
  it('open on GitHub at the commit the callee was read at, in a new tab', () => {
    const p = planned();
    const store = opened(p, 'call/ship');
    expect(remoteScopes(p.plan, `${CALLEE}#ship`).map((w) => w.id)).toEqual([CALLEE]);
    shown(store, createElement(LocLink, { loc: { file: DEPLOY, line: 11 } }));
    const link = screen.getByRole('link', { name: /^deploy\.yml:11/ });
    expect(link.getAttribute('href')).toBe(
      `https://github.com/octo/ship/blob/${SHA}/.github/workflows/deploy.yml#L11`,
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('of the project stay a button to the YAML pane', () => {
    shown(opened(planned()), createElement(LocLink, { loc: { file: CI, line: 3 } }));
    expect(screen.getByRole('button', { name: /^ci\.yml:3/ })).toBeTruthy();
  });
});

describe('the status bar', () => {
  it('counts the remote workflows, with what is not fetched and Fetch until the author lets the page', async () => {
    const store = opened(planned(null));
    store.getState().setRemotesNeeded([
      { ref: DEPLOY, kind: 'workflow', depth: 1 },
      { ref: ACT, kind: 'action', depth: 1 },
    ]);
    shown(store, createElement(RemotesChip));
    expect(document.body.textContent).toContain(
      '3 remote workflows · 1 workflow and 1 action not fetched · Fetch from api.github.com',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fetch from api.github.com' }));
    expect(store.getState().remotes.consent).toBe('page');
  });

  it('offers Retry for a read GitHub may answer now, which takes its failure out of the store', async () => {
    const failed: RemotePool = {
      sources: [],
      failed: [{ ref: GONE, kind: 'workflow', failure: 'timeout', message: 't' }],
    };
    const store = opened(planned(failed));
    store.getState().consentRemotes('page');
    store.getState().remotesRead(failed, true);
    shown(store, createElement(RemotesChip));
    expect(document.body.textContent).toContain('3 remote workflows · 1 not read · Retry');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(store.getState().remotes.failed).toEqual({});
  });
});

describe('Retry', () => {
  it('leaves the other failures, and changes nothing when the ref has none', () => {
    const store = createSessionStore();
    const s = store.getState();
    s.remotesRead(
      {
        sources: [],
        failed: [
          { ref: GONE, kind: 'workflow', failure: 'timeout', message: 't' },
          { ref: LATER, kind: 'workflow', failure: 'server', message: 's', sha: SHA },
        ],
      },
      true,
    );
    const before = store.getState().remotes;
    retryRemotes(store, [DEPLOY]);
    expect(store.getState().remotes).toBe(before);
    retryRemotes(store, [GONE]);
    expect(Object.keys(store.getState().remotes.failed)).toEqual([remotePoolKey(LATER, SHA)]);
  });
});

describe('an edit inside a remote callee', () => {
  const ui = (): { ui: GestureUi; refused: number[] } => {
    const refused: number[] = [];
    return {
      refused,
      ui: { open: vi.fn(), confirm: vi.fn(), refused: (seq) => refused.push(seq), added: vi.fn() },
    };
  };

  it('refuses every gesture with where to make it, and keeps the job selected', () => {
    const store = opened(planned(), 'call/ship');
    const host = ui();
    const g = gesturesOf(store, host.ui);
    for (const gesture of [
      () => g.remove(),
      () => g.rename(),
      () => g.needs(),
      () => g.palette(),
      () => g.move(1),
    ])
      expect(gesture()).toBe(true);
    expect(host.refused).toHaveLength(5);
    expect(store.getState().edit.refused?.refusal).toMatchObject({
      reason: 'other-workflow',
      message: 'This workflow lives in octo/ship; edit it there.',
      file: DEPLOY,
      fixes: [],
    });
    expect(store.getState().sel).toBe('call/ship');
    expect(store.getState().files.byPath[CI]).toBe(caller);
  });

  it('leaves a gesture on the caller’s own jobs alone', () => {
    const store = opened(planned(), 'build');
    const host = ui();
    gesturesOf(store, host.ui).needs();
    expect(host.refused).toEqual([]);
    expect(store.getState().edit.refused).toBeUndefined();
  });
});
