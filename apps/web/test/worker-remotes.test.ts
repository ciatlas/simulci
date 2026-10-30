import { createHash } from 'node:crypto';
import type { RemoteSourceInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { handle, initialState, type WorkerState } from '../src/worker/handle';
import { isEngineRequest, type LoadRequest, type RemoteNeed, type RemotePool } from '../src/worker/protocol';

/**
 * The worker's half of the remotes loop (M4 synthesis § 5.3): a load takes from the page's pool what the project's pins
 * ask for, level by level, as `simulci test` reads them, and answers what it still needs.
 */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const DEPLOY = 'octo/ship/.github/workflows/deploy.yml@v1';
const BUILD_AT_A = `octo/ship/.github/workflows/build.yml@${A}`;
const ACT = 'octo/act@v2';

const deployText = 'on: workflow_call\njobs:\n  build:\n    uses: ./.github/workflows/build.yml\n';
const buildText = 'on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n';
const actText = 'name: act\nruns:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n';
const digestOf = (text: string): string => `sha256-${createHash('sha256').update(text).digest('base64')}`;

const files = {
  '.github/workflows/ci.yml': `on: push
jobs:
  ship:
    uses: ${DEPLOY}
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACT}
`,
};
const lockfile = `version: 1
remotes:
  ${DEPLOY}:
    sha: ${A}
    kind: workflow
    file: .github/workflows/deploy.yml
    digest: ${digestOf(deployText)}
`;
const readonly = { '.github/simulci/remotes.lock.yml': lockfile };

const source = (ref: string, sha: string, text: string, pinned: RemoteSourceInput['pinned']) =>
  ({ ref, kind: ref.includes('/.github/workflows/') ? 'workflow' : 'action', sha, text, pinned }) as const;

function load(body: Omit<LoadRequest, 'id' | 'type'>): { state: WorkerState; needed: RemoteNeed[] } {
  const r = handle(initialState(), { id: 1, type: 'load', ...body });
  if (r.response.type !== 'loaded') throw new Error(JSON.stringify(r.response));
  return { state: r.state, needed: r.response.remotesNeeded ?? [] };
}

const read = (state: WorkerState, tested = false): string[] => {
  const project = tested ? state.project!.tested() : state.project!.loaded;
  return [...project.remotes.sources.values()].map((s) => `${s.ref} ${s.sha.slice(0, 1)} ${s.pinned}`).sort();
};

describe('a load with remotes', () => {
  it('without a pool reads nothing, as before, and names what the project needs with its pins and digests', () => {
    const { state, needed } = load({ files, readonly });
    expect(read(state)).toEqual([]);
    expect(state.project!.loaded.remotes.mode).toBe('off');
    expect(needed).toEqual([
      { ref: ACT, kind: 'action', depth: 1, issue: expect.objectContaining({ code: 'remote-unpinned' }) },
      {
        ref: DEPLOY,
        kind: 'workflow',
        depth: 1,
        pin: { sha: A, pinned: 'lockfile' },
        digest: digestOf(deployText),
      },
    ]);
    // The lock files are read, never listed among the project's files.
    expect(state.project!.outline.files.map((f) => f.path)).toEqual(['.github/workflows/ci.yml']);
    expect(Object.keys(state.project!.loaded.files)).toEqual(['.github/workflows/ci.yml']);
  });

  it('takes each level from the pool at the commit its pin names, then the next, until the pool has no more', () => {
    const pool: RemotePool = {
      sources: [
        source(DEPLOY, A, deployText, 'resolved'),
        source(BUILD_AT_A, A, buildText, 'parent'),
        source(ACT, C, actText, 'resolved'),
      ],
      failed: [],
    };
    const { state, needed } = load({ files, readonly, remotes: pool });
    expect(needed).toEqual([]);
    expect(state.project!.loaded.remotes.mode).toBe('fetch');
    // The pin says where each came from, whatever the pool said when it was read.
    expect(read(state)).toEqual([`${ACT} c resolved`, `${BUILD_AT_A} a parent`, `${DEPLOY} a lockfile`]);
  });

  it("leaves a file the pool holds at another commit than the pin's, and asks for the pinned one", () => {
    const pool: RemotePool = { sources: [source(DEPLOY, B, deployText, 'resolved')], failed: [] };
    const { state, needed } = load({ files, readonly, remotes: pool });
    expect(read(state)).toEqual([]);
    expect(needed.map((n) => [n.ref, n.pin?.sha])).toEqual([
      [ACT, undefined],
      [DEPLOY, A],
    ]);
  });

  it('takes a failure at the commit it was asked for, and no longer needs it', () => {
    const failed = [
      { ref: DEPLOY, kind: 'workflow', failure: 'not-found', message: 'gone', sha: A },
    ] as const;
    const { state, needed } = load({ files, readonly, remotes: { sources: [], failed: [...failed] } });
    expect([...state.project!.loaded.remotes.failed.keys()]).toEqual([
      'octo/ship/.github/workflows/deploy.yml@v1',
    ]);
    expect(needed.map((n) => n.ref)).toEqual([ACT]);
  });

  it('runs the route tests on the project `simulci test` loads: only what a pin names, in lock mode', () => {
    const pool: RemotePool = {
      sources: [
        source(DEPLOY, A, deployText, 'lockfile'),
        source(BUILD_AT_A, A, buildText, 'parent'),
        source(ACT, C, actText, 'resolved'),
      ],
      failed: [],
    };
    const { state } = load({ files, readonly, remotes: pool });
    expect(read(state, true)).toEqual([`${BUILD_AT_A} a parent`, `${DEPLOY} a lockfile`]);
    expect(state.project!.tested().remotes.mode).toBe('lock');
    // Asked once, then kept.
    expect(state.project!.tested()).toBe(state.project!.tested());
    // Without remotes, the tests run on the plan's own project.
    const plain = load({ files, readonly }).state;
    expect(plain.project!.tested()).toBe(plain.project!.loaded);
  });

  it('follows remotes ten deep, as the engine plans them, and no further', () => {
    const at = (n: number) => `octo/r${n}/.github/workflows/w.yml@v1`;
    const calls = (n: number) => `on: workflow_call\njobs:\n  next:\n    uses: ${at(n + 1)}\n`;
    const sources = Array.from({ length: 12 }, (_, i) => source(at(i + 1), A, calls(i + 1), 'resolved'));
    const top = { '.github/workflows/ci.yml': `on: push\njobs:\n  go:\n    uses: ${at(1)}\n` };
    const { state, needed } = load({ files: top, remotes: { sources, failed: [] } });
    expect(read(state)).toHaveLength(10);
    expect(needed).toEqual([]);
  });

  it('reads 200 remotes at most and takes the rest as past the cap', () => {
    const refs = Array.from({ length: 201 }, (_, i) => `octo/a${String(i).padStart(3, '0')}@v1`);
    const steps = refs.map((r) => `      - uses: ${r}\n`).join('');
    const many = {
      '.github/workflows/ci.yml': `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
    };
    const sources = refs.map((r) => source(r, A, actText, 'resolved'));
    const { state, needed } = load({ files: many, remotes: { sources, failed: [] } });
    expect(state.project!.loaded.remotes.sources.size).toBe(200);
    expect([...state.project!.loaded.remotes.limited]).toEqual([refs[200]]);
    expect(needed).toEqual([]);
  });

  it('accepts a load with a pool and refuses one with a malformed pool', () => {
    const ok = { id: 1, type: 'load', files: {}, remotes: { sources: [], failed: [] } };
    expect(isEngineRequest(ok)).toBe(true);
    expect(isEngineRequest({ ...ok, remotes: { sources: [] } })).toBe(false);
    expect(isEngineRequest({ ...ok, remotes: [] })).toBe(false);
  });
});
