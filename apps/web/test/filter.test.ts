import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverTests, readWorkflowFiles } from '@simulci/node';
import { afterAll, describe, expect, it } from 'vitest';
import {
  filterFiles,
  isKeptFile,
  isProjectFile,
  isReadFile,
  isSnapshotFile,
  isTestFile,
  mayHoldProjectFiles,
  normalizePath,
  snapshotFiles,
} from '../src/input/filter';
import { snapshotPath } from '../src/lib/snapshot-path';
import { LIMITS, overLimit } from '../src/input/limits';

/** Every file under a directory, as a browser walk would hand them over: relative path → text. */
function everyFile(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, everyFile(join(dir, entry.name), rel));
    else out[rel] = readFileSync(join(dir, entry.name), 'utf8');
  }
  return out;
}

const SYNTHETIC = [
  '.github/workflows/ci.yml',
  '.github/workflows/Release.YAML',
  '.github/workflows/nested/not-a-workflow.yml',
  '.github/workflows/README.md',
  '.github/actions/setup/action.yml',
  '.github/actions/deep/er/action.yaml',
  '.github/actions/setup/README.md',
  '.github/actions/setup/scripts/action.sh',
  '.github/actions/ACTION.YML',
  '.github/dependabot.yml',
  '.github/simulci/tests/ci.test.yml',
  '.github/simulci/tests/nested/deep/release.test.yaml',
  '.github/simulci/tests/.test.yml',
  '.github/simulci/tests/Upper.TEST.YML',
  '.github/simulci/tests/ci.test.yml.bak',
  '.github/simulci/tests/README.md',
  '.github/simulci/tests/__snapshots__/ci.test.snap.json',
  '.github/simulci/tests/__snapshots__/odd.test.yml',
  '.github/simulci/tests/nested/__snapshots__/deep.test.yml',
  '.github/simulci/tests/nested/deep/__snapshots__/release.test.snap.json',
  '.github/simulci/tests/__snapshots__/__snapshots__/inner.test.snap.json',
  '.github/simulci/tests/__snapshots__/notes.json',
  '.github/simulci/__snapshots__/outside.test.snap.json',
  '.github/simulci/other.test.yml',
  'tests/ci.test.yml',
  'action.yml',
  'node_modules/x/action.yml',
  'packages/a/action.yaml',
  'src/index.ts',
];

const tmp = mkdtempSync(join(tmpdir(), 'simulci-filter-'));
for (const path of SYNTHETIC) {
  mkdirSync(dirname(join(tmp, path)), { recursive: true });
  writeFileSync(join(tmp, path), `# ${path}\n`);
}
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Of the files the filter keeps, the ones a predicate takes. */
const pick = (files: Record<string, string>, keep: (path: string) => boolean): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter(([path]) => keep(path)));

/** The route tests the filter keeps, by path, as `discoverTests` lists them. */
const testsOf = (files: Record<string, string>): string[] =>
  Object.keys(pick(files, isTestFile)).sort((x, y) => x.localeCompare(y));

describe('the browser file filter', () => {
  it('keeps exactly what @simulci/node reads from the routes lab', () => {
    const root = join(import.meta.dirname, '../../../fixtures/routes-lab/repo');
    const kept = filterFiles(everyFile(root));
    expect(pick(kept, isProjectFile)).toEqual(readWorkflowFiles(root));
    expect(testsOf(kept)).toEqual(discoverTests(root));
  });

  it('keeps exactly what @simulci/node reads from a tree with every edge', () => {
    const node = readWorkflowFiles(tmp);
    expect(Object.keys(node).sort()).toEqual([
      '.github/actions/ACTION.YML',
      '.github/actions/deep/er/action.yaml',
      '.github/actions/setup/action.yml',
      '.github/workflows/Release.YAML',
      '.github/workflows/ci.yml',
      'action.yml',
    ]);
    const kept = filterFiles(everyFile(tmp));
    expect(pick(kept, isProjectFile)).toEqual(node);
    expect(discoverTests(tmp)).toEqual([
      '.github/simulci/tests/.test.yml',
      '.github/simulci/tests/ci.test.yml',
      '.github/simulci/tests/nested/deep/release.test.yaml',
    ]);
    expect(testsOf(kept)).toEqual(discoverTests(tmp));
    // Nothing else: a kept file is a project file or a route test.
    expect(Object.keys(kept).every((p) => isProjectFile(p) !== isTestFile(p))).toBe(true);
  });

  it('finds the route tests simulci test finds in this repository', () => {
    const root = join(import.meta.dirname, '../../..');
    const tests = testsOf(filterFiles(everyFile(join(root, '.github'), '.github')));
    expect(tests.length).toBeGreaterThan(0);
    expect(tests).toEqual(discoverTests(root));
  });

  it('normalizes the paths a picker or a drop hands over', () => {
    expect(normalizePath('./.github\\workflows\\ci.yml')).toBe('.github/workflows/ci.yml');
    expect(normalizePath('/action.yml')).toBe('action.yml');
    expect(isProjectFile('repo/.github/workflows/ci.yml')).toBe(false);
    expect(isProjectFile('Action.yml')).toBe(false);
    expect(isTestFile('./.github\\simulci\\tests\\ci.test.yml')).toBe(true);
    expect(isTestFile('repo/.github/simulci/tests/ci.test.yml')).toBe(false);
    expect(isKeptFile('.github/simulci/tests/ci.test.yml')).toBe(true);
    expect(isKeptFile('.github/simulci/tests/ci.yml')).toBe(false);
  });

  it('knows which directories a walk may skip', () => {
    expect(mayHoldProjectFiles('')).toBe(true);
    expect(mayHoldProjectFiles('.github')).toBe(true);
    expect(mayHoldProjectFiles('.github/actions/setup/deep')).toBe(true);
    expect(mayHoldProjectFiles('.github/workflows')).toBe(true);
    expect(mayHoldProjectFiles('node_modules')).toBe(false);
    expect(mayHoldProjectFiles('.github/simulci')).toBe(true);
    expect(mayHoldProjectFiles('.github/simulci/tests/nested/deep')).toBe(true);
    expect(mayHoldProjectFiles('.github/simulci/tests/__snapshots__')).toBe(true);
    expect(mayHoldProjectFiles('.github/simulci/tests/nested/__snapshots__')).toBe(true);
    expect(mayHoldProjectFiles('.github/simulci/tests/__snapshots__/deep')).toBe(false);
    expect(mayHoldProjectFiles('.github/simulci/tests/__snapshots__/__snapshots__')).toBe(false);
    expect(mayHoldProjectFiles('.github/simulci/__snapshots__')).toBe(false);
    expect(mayHoldProjectFiles('.github/simulci/other')).toBe(false);
    expect(mayHoldProjectFiles('.github/workflowsx')).toBe(false);
  });

  it('reads the snapshots simulci test keeps beside the tests, and no other', () => {
    const snapshots = Object.keys(snapshotFiles(everyFile(tmp))).sort();
    expect(snapshots).toEqual([
      '.github/simulci/tests/__snapshots__/ci.test.snap.json',
      '.github/simulci/tests/nested/deep/__snapshots__/release.test.snap.json',
    ]);
    // Each is where simulci test reads the snapshot of a test the filter keeps.
    const tests = testsOf(filterFiles(everyFile(tmp)));
    expect(snapshots.every((p) => tests.some((t) => snapshotPath(t) === p))).toBe(true);
    // Read, never kept: they are not the project's or the tests'.
    expect(snapshots.every((p) => isReadFile(p) && !isKeptFile(p))).toBe(true);
    expect(isSnapshotFile('./.github\\simulci\\tests\\__snapshots__\\ci.test.snap.json')).toBe(true);
  });

  it('refuses sources over the limits with the reason', () => {
    expect(overLimit({ 'action.yml': 'x' })).toBeUndefined();
    expect(overLimit({ 'action.yml': 'x'.repeat(LIMITS.fileBytes + 1) })).toMatch(/action\.yml is 2\.0 MB/);
    const many: Record<string, string> = {};
    for (let i = 0; i <= LIMITS.files; i++) many[`f${i}`] = '';
    expect(overLimit(many)).toMatch(/2001 files/);
    const big: Record<string, string> = {};
    for (let i = 0; i < 11; i++) big[`f${i}`] = 'x'.repeat(LIMITS.fileBytes);
    expect(overLimit(big)).toMatch(/22 MB in all/);
  });
});
