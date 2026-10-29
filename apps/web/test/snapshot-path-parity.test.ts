/**
 * The page reads a test file's snapshots where `simulci test` writes them: `lib/snapshot-path.ts` is a copy of
 * `@simulci/node`'s `snapshotPath`, which the page may not bundle, so the two must agree on every test file name.
 */
import { snapshotPath as nodePath } from '@simulci/node';
import { describe, expect, it } from 'vitest';
import { snapshotPath } from '../src/lib/snapshot-path';

const TEST_FILES = [
  '.github/simulci/tests/ci.test.yml',
  '.github/simulci/tests/release.test.yaml',
  '.github/simulci/tests/nested/deep/ci.test.yml',
  '.github/simulci/tests/.test.yml',
  '.github/simulci/tests/a.b.test.yml',
  '.github/simulci/tests/ci.test.yml.test.yml',
  'ci.test.yml',
];

describe('the snapshot path, on the page and in @simulci/node', () => {
  for (const file of TEST_FILES)
    it(`agree for ${file}`, () => {
      expect(snapshotPath(file)).toBe(nodePath(file));
    });
});
