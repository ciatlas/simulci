/**
 * A checkout's route tests run as `simulci test --ci` runs them (packages/cli/src/test.ts: CI's options, the snapshots
 * read from disk and never written), in Node by the engine's root entry and `@simulci/node`, not by the page's worker:
 * the browser pass checks that the Tests tab says what the CLI says. The browser pass runs it as `node
 * --conditions=source --import tsx e2e/node-test.ts <checkout>` and reads the one JSON object it prints.
 */
import { loadFiles, runTests } from '@simulci/engine';
import { discoverTests, diskSnapshotStore, readTests, readWorkflowFiles } from '@simulci/node';

const root = process.argv[2]!;
const result = runTests(loadFiles(readWorkflowFiles(root)), readTests(root, discoverTests(root)), {
  ci: true,
  update: false,
  strict: false,
  snapshotDetail: 'steps',
  snapshots: diskSnapshotStore(root),
});
process.stdout.write(
  JSON.stringify({
    exitCode: result.exitCode,
    summary: result.summary,
    files: result.files.map((f) => ({
      path: f.path,
      status: f.status,
      failures: f.failures.map((x) => x.headline),
      cases: f.cases.map((c) => ({
        name: c.name,
        status: c.status,
        failures: c.failures.map((x) => x.headline),
      })),
    })),
  }),
);
