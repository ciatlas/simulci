/**
 * Where `simulci test` keeps a test file's snapshots: `<tests dir>/__snapshots__/<name>.test.snap.json` beside it. A
 * copy of `snapshotPath` in `packages/node/src/tests.ts`, which runs only under Node; a parity test holds the two to
 * the same answer (test/snapshot-path-parity.test.ts).
 */
export function snapshotPath(testFile: string): string {
  const slash = testFile.lastIndexOf('/');
  const dir = slash === -1 ? '.' : testFile.slice(0, slash);
  const name = testFile.slice(slash + 1).replace(/\.ya?ml$/, '');
  return `${dir}/__snapshots__/${name}.snap.json`;
}
