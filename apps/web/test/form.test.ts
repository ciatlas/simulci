import { describe, expect, it } from 'vitest';
import {
  activityTypes,
  asBoolean,
  changedText,
  crons,
  dispatchInputs,
  inputValue,
  jsonText,
  parseChanged,
  pathPatterns,
  pushRef,
  readsChangedFiles,
  refPatch,
  releaseTag,
  runConclusion,
  runNamed,
  sameChanged,
  strayAction,
  withEvent,
  workflowNames,
} from '../src/scenario/form';
import { reportText } from '../src/state/report';
import { readSearch, urlSliceChanged, urlStateOf, writeSearch } from '../src/state/url';
import type { Outline } from '../src/worker/protocol';

const outline: Outline = {
  files: [],
  workflows: [
    {
      path: '.github/workflows/ci.yml',
      name: 'CI',
      callable: false,
      events: [
        {
          event: 'pull_request',
          types: { allowed: ['opened', 'labeled'], all: ['opened', 'labeled', 'closed'], narrowed: true },
        },
        { event: 'push', paths: ['src/**'], pathsIgnore: ['docs/**'] },
        { event: 'schedule', crons: ['0 6 * * 1'] },
      ],
      dispatch: [
        { name: 'env', type: 'choice', required: false, default: 'staging', options: ['staging', 'prod'] },
        { name: 'dry', type: 'boolean', required: true },
      ],
      jobs: [],
      onLine: 1,
    },
    {
      path: '.github/workflows/nightly.yml',
      callable: false,
      events: [
        { event: 'pull_request' },
        { event: 'schedule', crons: ['0 2 * * *', '0 6 * * 1'] },
        { event: 'workflow_run', workflows: ['CI', 'Release'] },
      ],
      dispatch: [{ name: 'env', type: 'string', required: false }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: { pull_request: { types: ['opened', 'labeled', 'closed'], default: ['opened'] } },
};

describe('the form helpers', () => {
  it('keep the ref and the repository facts across an event change and drop the rest', () => {
    const next = withEvent(
      {
        event: 'pull_request',
        action: 'labeled',
        base: 'main',
        head: 'x',
        number: 3,
        inputs: { a: 1 },
        cron: 'x',
        vars: { A: '1' },
      },
      'push',
    );
    expect(next).toEqual({ event: 'push', base: 'main', head: 'x', number: 3, vars: { A: '1' } });
  });

  it('leave a tag behind when the event becomes a pull request, which runs on a ref of its own', () => {
    expect(withEvent({ event: 'push', tag: 'v1', changed: ['a'] }, 'pull_request')).toEqual({
      event: 'pull_request',
      changed: ['a'],
    });
    expect(withEvent({ event: 'push', ref: 'refs/tags/v1' }, 'pull_request_target')).toEqual({
      event: 'pull_request_target',
    });
    expect(withEvent({ event: 'push', tag: 'v1' }, 'workflow_dispatch')).toEqual({
      event: 'workflow_dispatch',
      tag: 'v1',
    });
    expect(withEvent({ event: 'push', branch: 'dev' }, 'pull_request')).toEqual({
      event: 'pull_request',
      branch: 'dev',
    });
  });

  it('leave a branch behind when the event becomes a release, which runs on its tag', () => {
    expect(withEvent({ event: 'push', branch: 'main', changed: ['a'] }, 'release')).toEqual({
      event: 'release',
      changed: ['a'],
    });
    expect(withEvent({ event: 'push', ref: 'refs/heads/dev' }, 'release')).toEqual({ event: 'release' });
    expect(withEvent({ event: 'push', tag: 'v1' }, 'release')).toEqual({ event: 'release', tag: 'v1' });
    expect(withEvent({ event: 'push', ref: 'refs/tags/v1' }, 'release')).toEqual({
      event: 'release',
      ref: 'refs/tags/v1',
    });
    expect(releaseTag({ event: 'release', ref: 'refs/tags/v1' })).toBe('v1');
    expect(releaseTag({ event: 'release', tag: 'v2' })).toBe('v2');
    expect(releaseTag({ event: 'release', branch: 'main' })).toBe('');
    expect(releaseTag({ event: 'release' })).toBe('');
  });

  it('keep the scenario as it is when the event stays the same', () => {
    const scenario = { event: 'pull_request', action: 'labeled', merged: true, number: 3 };
    expect(withEvent(scenario, 'pull_request')).toBe(scenario);
  });

  it('read the changed files for every path-filter event but a push of a tag', () => {
    expect(readsChangedFiles({ event: 'push', branch: 'main' })).toBe(true);
    expect(readsChangedFiles({ event: 'push' })).toBe(true);
    expect(readsChangedFiles({ event: 'push', tag: 'v1' })).toBe(false);
    expect(readsChangedFiles({ event: 'push', ref: 'refs/tags/v1' })).toBe(false);
    expect(readsChangedFiles({ event: 'push', ref: 'tags/v1' })).toBe(false);
    expect(readsChangedFiles({ event: 'pull_request', tag: 'v1' })).toBe(true);
    expect(readsChangedFiles({ event: 'pull_request_target' })).toBe(true);
    expect(readsChangedFiles({ event: 'schedule' })).toBe(false);
  });

  it('read a ref as the branch or the tag it names and write one back in its place', () => {
    expect(pushRef({ event: 'push', tag: 'v1' })).toEqual({ kind: 'tag', name: 'v1' });
    expect(pushRef({ event: 'push', branch: 'dev' })).toEqual({ kind: 'branch', name: 'dev' });
    expect(pushRef({ event: 'push', ref: 'refs/tags/v1' })).toEqual({ kind: 'tag', name: 'v1' });
    expect(pushRef({ event: 'push', ref: 'tags/v1' })).toEqual({ kind: 'tag', name: 'v1' });
    expect(pushRef({ event: 'push', ref: 'refs/heads/tags/x' })).toEqual({ kind: 'branch', name: 'tags/x' });
    expect(pushRef({ event: 'push', ref: 'heads/dev' })).toEqual({ kind: 'branch', name: 'dev' });
    expect(pushRef({ event: 'push', ref: 'main' })).toEqual({ kind: 'branch', name: 'main' });
    expect(pushRef({ event: 'push' })).toEqual({ name: '' });
    expect(refPatch('tag', 'v2')).toEqual({ ref: undefined, branch: undefined, tag: 'v2' });
    expect(refPatch('branch', '')).toEqual({ ref: undefined, branch: undefined, tag: undefined });
  });

  it('look up events and inputs by their own names only', () => {
    expect(activityTypes(outline, 'constructor')).toBeUndefined();
    expect(activityTypes(outline, 'toString')).toBeUndefined();
    expect(activityTypes(outline, '__proto__')).toBeUndefined();
    expect(inputValue({}, 'constructor')).toBeUndefined();
    expect(inputValue({ dry: false }, 'dry')).toBe(false);
    expect(inputValue(undefined, 'dry')).toBeUndefined();
  });

  it('keep an action that is none of the types offered', () => {
    const types = activityTypes(outline, 'pull_request')!;
    expect(strayAction(types, 'foo')).toBe('foo');
    expect(strayAction(types, 'closed')).toBeUndefined();
    expect(strayAction(types, 'opened')).toBeUndefined();
    expect(strayAction(types, undefined)).toBeUndefined();
  });

  it('coerce a boolean input the way the engine does', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean('true')).toBe(true);
    expect(asBoolean('True')).toBe(false);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean(1)).toBe(false);
    expect(asBoolean(undefined)).toBe(false);
  });

  it('join a conclusion chosen before the triggering workflow to the run that names it', () => {
    expect(runNamed(undefined, 'CI', 'failure')).toEqual({ name: 'CI', conclusion: 'failure' });
    expect(runNamed(undefined, 'CI', undefined)).toEqual({ name: 'CI' });
    expect(runNamed({ name: 'A', conclusion: 'cancelled' }, 'B', 'failure')).toEqual({
      name: 'B',
      conclusion: 'cancelled',
    });
    expect(runNamed({ name: 'A' }, 'B', 'failure')).toEqual({ name: 'B' });
  });

  it('show the conclusion of a named run, and the one chosen only while no run is named', () => {
    expect(runConclusion({ name: 'CI' }, 'failure')).toBe('success');
    expect(runConclusion({ name: 'CI', conclusion: 'cancelled' }, 'failure')).toBe('cancelled');
    expect(runConclusion(undefined, 'failure')).toBe('failure');
    expect(runConclusion(undefined, undefined)).toBe('success');
  });

  it('derive the activity types, the inputs, the crons, the names and the path patterns', () => {
    expect(activityTypes(outline, 'pull_request')).toEqual({
      allowed: ['opened', 'labeled'],
      rest: ['closed'],
      required: true,
    });
    expect(activityTypes({ ...outline, workflows: [outline.workflows[1]!] }, 'pull_request')).toEqual({
      allowed: ['opened'],
      rest: ['labeled', 'closed'],
      required: false,
    });
    expect(activityTypes(outline, 'push')).toBeUndefined();
    expect(dispatchInputs(outline).map((i) => [i.name, i.type])).toEqual([
      ['env', 'choice'],
      ['dry', 'boolean'],
    ]);
    expect(crons(outline)).toEqual(['0 6 * * 1', '0 2 * * *']);
    expect(workflowNames(outline)).toEqual(['CI', 'Release']);
    expect(pathPatterns(outline, 'push')).toEqual(['src/**', 'docs/**']);
    expect(pathPatterns(outline, 'pull_request')).toEqual([]);
  });

  it('read and write the changed-files lines', () => {
    expect(parseChanged('')).toBeUndefined();
    expect(parseChanged('\n  \n')).toBeUndefined();
    expect(parseChanged('src/a.ts\n docs/b.md (added)\nold.ts (renamed from older.ts)\nx (moved)')).toEqual([
      'src/a.ts',
      { path: 'docs/b.md', status: 'added' },
      { path: 'old.ts', status: 'renamed', from: 'older.ts' },
      'x (moved)',
    ]);
    expect(changedText(parseChanged('a\nb (removed)\nc (renamed from d)'))).toBe(
      'a\nb (removed)\nc (renamed from d)',
    );
    expect(changedText(undefined)).toBe('');
    expect(jsonText('x')).toBe('x');
    expect(jsonText(true)).toBe('true');
  });

  it('show changed files of the wrong shape as their JSON', () => {
    expect(changedText([null, 3, {}, { path: 'a' }, { path: 'b', status: 'added' }])).toBe(
      'null\n3\n{}\na\nb (added)',
    );
    expect(changedText('a')).toBe('');
    expect(changedText(null)).toBe('');
  });

  it('tell whether a text spells the changed files, whatever its spacing', () => {
    expect(sameChanged('a\n\n b \n', ['a', 'b'])).toBe(true);
    expect(sameChanged('a (added)', [{ path: 'a', status: 'added' }])).toBe(true);
    expect(sameChanged('', undefined)).toBe(true);
    expect(sameChanged('a', ['b'])).toBe(false);
    expect(sameChanged('null', [null])).toBe(false);
  });

  it('tell the URL slice apart and spell it', () => {
    const base = {
      scenario: { event: 'push' },
      assume: [],
      detail: 'steps' as const,
      ui: { view: 'graph' as const, hideUntriggered: false },
      edit: { on: false },
      source: { kind: 'none' as const },
    };
    expect(urlStateOf(base)).toEqual({ scenario: { event: 'push' }, assume: [] });
    expect(urlStateOf({ ...base, edit: { on: true } })).toMatchObject({ edit: true });
    expect(urlSliceChanged({ ...base, edit: { on: true } }, base)).toBe(true);
    expect(
      urlStateOf({ ...base, focus: 'ci.yml', detail: 'legs', ui: { view: 'text', hideUntriggered: true } }),
    ).toEqual({
      scenario: { event: 'push' },
      assume: [],
      wf: 'ci.yml',
      d: 'legs',
      view: 'text',
      hide: true,
    });
    expect(urlSliceChanged(base, base)).toBe(false);
    expect(urlSliceChanged({ ...base, scenario: { event: 'push' } }, base)).toBe(true);
    expect(urlSliceChanged({ ...base, ui: { ...base.ui, hideUntriggered: true } }, base)).toBe(true);
  });

  it("names a public repository's source in gh, a private one never, and an offer while it waits", () => {
    const base = {
      scenario: { event: 'push' },
      assume: [],
      detail: 'steps' as const,
      ui: { view: 'graph' as const, hideUntriggered: false },
      edit: { on: false },
    };
    const source = {
      kind: 'github' as const,
      host: 'github.com',
      owner: 'octo',
      repo: 'ship',
      ref: 'feature/x',
      sha: 'a'.repeat(40),
      defaultBranch: 'main',
      private: false,
      readAt: 0,
    };
    const offer = { owner: 'octo', repo: 'boat' };
    expect(writeSearch(urlStateOf({ ...base, source }))).toMatchObject({ gh: 'octo/ship@feature/x' });
    expect(
      urlStateOf({ ...base, source: { ...source, private: true }, githubOffer: offer }).gh,
    ).toBeUndefined();
    expect(writeSearch(urlStateOf({ ...base, source: { kind: 'none' }, githubOffer: offer })).gh).toBe(
      'octo/boat',
    );
    expect(readSearch({ event: 'push', gh: 'octo/ship@feature/x' }).gh).toEqual({
      owner: 'octo',
      repo: 'ship',
      ref: 'feature/x',
    });
    for (const bad of ['octo', 'octo/ship/x', '-octo/ship', 'octo/..', 'octo/ship@', 7])
      expect(readSearch({ event: 'push', gh: bad }).gh, String(bad)).toBeUndefined();
    expect(urlSliceChanged({ ...base, source }, { ...base, source: { kind: 'none' } })).toBe(true);
    expect(urlSliceChanged({ ...base, source, githubOffer: offer }, { ...base, source })).toBe(true);
  });

  it('write a failure report without file contents', () => {
    const text = reportText({
      engine: { status: 'ready', version: '0.2.0', models: [], restarts: 1, busy: false },
      error: { kind: 'engine', message: 'boom', stack: 'at x' },
      scenario: { event: 'push' },
      assume: [{ step: 'a.b', outcome: 'failure' }],
      files: { '.github/workflows/ci.yml': 'secret: contents' },
    });
    expect(text).toContain('engine 0.2.0, protocol 1, restarts 1');
    expect(text).toContain('error: engine: boom\nat x');
    expect(text).toContain('files: .github/workflows/ci.yml (16 chars)');
    expect(text).not.toContain('contents');
  });
});
