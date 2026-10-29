import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { nodeTests } from './node-run';
import { fileOf, folderWith, useOpfsFolder } from './opfs';

/**
 * The Tests tab in a real browser (synthesis § 5.1, failure mode 19): over a checkout opened as a folder, key `5` opens
 * the tab, whose verdicts are the ones `simulci test --ci` gives in Node over the same files (e2e/node-test.ts), a
 * missing snapshot failed with the CLI's headline; each case shows its line in its test file and the workflow line
 * that decided it, and loads its scenario into the form; "As CI" off passes a missing snapshot without writing one;
 * Reload reads the snapshots again; and a source with no route tests says how to add one.
 */

const FIXTURE = join(import.meta.dirname, 'fixtures/tests');
const CI_TEST = '.github/simulci/tests/ci.test.yml';
const SNAPSHOT = '.github/simulci/tests/__snapshots__/ci.test.snap.json';

/** Every page error and console error, so a test that passes on screen still fails on a thrown handler. */
let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

/** The fixture's files by repository path, as bytes. */
function fixture(): Record<string, number[]> {
  const files: Record<string, number[]> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(FIXTURE, path)] = Array.from(readFileSync(path));
    }
  };
  walk(FIXTURE);
  return files;
}

const source = (page: Page): Locator => page.getByRole('navigation', { name: 'Source' });
const panelTab = (page: Page, name: string): Locator =>
  page.getByRole('tablist', { name: 'Plan details' }).getByRole('tab', { name: new RegExp(`^${name}`) });
const testsPanel = (page: Page): Locator => page.locator('[data-panel="tests"]');
const header = (page: Page): Locator => testsPanel(page).getByRole('status');
const caseRow = (page: Page, name: string): Locator => testsPanel(page).locator(`li[data-case="${name}"]`);
const paneTab = (page: Page, name: string | RegExp): Locator =>
  page.locator('[data-pane="yaml"]').getByRole('tab', { name });

/** The fixture opened as a folder, its plan in, and the Tests tab opened by its key once the run is in. */
async function openFixture(page: Page): Promise<void> {
  await useOpfsFolder(page);
  await page.goto('/');
  await folderWith(page, fixture());
  await source(page).getByRole('button', { name: 'Open folder' }).click();
  await expect(source(page)).toContainText(/repo · \d files?/);
  await expect(page.locator('.react-flow__node-workflow')).toBeVisible();
  await page.locator('body').press('5');
  await expect(panelTab(page, 'Tests')).toHaveAttribute('aria-selected', 'true');
  await expect(header(page)).toHaveText(/^\d+ passed · \d+ failed · \d+ invalid · ran as CI on [0-9a-f]{7}$/);
}

/** What the tab shows, per file and case, as the Node helper reports it. */
async function shown(page: Page) {
  return testsPanel(page)
    .locator('section[data-file]')
    .evaluateAll((sections) =>
      sections.map((s) => ({
        path: s.getAttribute('data-file'),
        status: s.getAttribute('data-status'),
        cases: Array.from(s.querySelectorAll('li[data-case]')).map((li) => ({
          name: li.getAttribute('data-case'),
          status: li.getAttribute('data-status'),
        })),
      })),
    );
}

test('the Tests tab says what simulci test --ci says of the same checkout', async ({ page }) => {
  await openFixture(page);
  const node = nodeTests(FIXTURE);
  const { passed, failed, invalid } = node.summary;
  await expect(header(page)).toHaveText(
    new RegExp(`^${passed} passed · ${failed} failed · ${invalid} invalid · `),
  );
  expect(await shown(page)).toEqual(
    node.files.map((f) => ({
      path: f.path,
      status: f.status,
      cases: f.cases.map((c) => ({ name: c.name, status: c.status })),
    })),
  );
  // A failed case is open on its failures, in the CLI's words; a file's own failure shows above its cases.
  for (const f of node.files) {
    for (const headline of f.failures) await expect(testsPanel(page)).toContainText(headline);
    for (const c of f.cases)
      for (const headline of c.failures) await expect(caseRow(page, c.name)).toContainText(headline);
  }
  await expect(caseRow(page, 'the plan of a pull request')).toContainText(
    "snapshot: no snapshot for 'the plan of a pull request' (CI=true never writes one; run simulci test -u and commit it)",
  );
  // The tab counts what did not pass.
  await expect(panelTab(page, 'Tests')).toHaveText(`Tests${failed + invalid}`);
});

test('a case shows its line in its test file and the line that decided it, and loads its scenario', async ({
  page,
}) => {
  await openFixture(page);
  const row = caseRow(page, 'a pull request deploys too');
  await row.getByRole('button', { name: 'Show in test file' }).click();
  await expect(paneTab(page, /^ci\.test\.yml/)).toHaveAttribute('aria-selected', 'true');
  await row.getByRole('button', { name: 'Show deciding line' }).click();
  await expect(paneTab(page, /^ci\.yml/)).toHaveAttribute('aria-selected', 'true');
  await row.getByRole('button', { name: 'Load into scenario' }).click();
  await expect(page.getByLabel('Event', { exact: true })).toHaveValue('pull_request');
  // A file the workflow is missing from has nothing to load or to decide.
  const invalid = caseRow(page, 'a tag releases');
  await expect(invalid.getByRole('button', { name: 'Show deciding line' })).toBeDisabled();
  await expect(invalid.getByRole('button', { name: 'Load into scenario' })).toBeDisabled();
  await expect(invalid.getByRole('button', { name: 'Show in test file' })).toBeEnabled();
});

test('As CI off passes a missing snapshot without writing it, and Reload reads the snapshots again', async ({
  page,
}) => {
  await openFixture(page);
  await testsPanel(page).getByRole('checkbox', { name: 'As CI' }).uncheck();
  await expect(header(page)).toHaveText(/ · ran locally on [0-9a-f]{7}$/);
  const missing = caseRow(page, 'the plan of a pull request');
  await expect(missing).toHaveAttribute('data-status', 'passed');
  await expect(missing).toContainText('snapshot not written here');
  expect(await fileOf(page, '.github/simulci/tests/__snapshots__/ci.test.snap.json')).toBeDefined();
  expect(
    Buffer.from((await fileOf(page, SNAPSHOT))!.bytes).equals(readFileSync(join(FIXTURE, SNAPSHOT))),
  ).toBe(true);

  // The stored snapshot goes from the folder: Reload takes that in, and the case it held fails under CI again.
  await testsPanel(page).getByRole('checkbox', { name: 'As CI' }).check();
  await expect(caseRow(page, 'the plan of a push to main')).toHaveAttribute('data-status', 'passed');
  await page.evaluate(async (path) => {
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('repo');
    const parts = path.split('/');
    const name = parts.pop()!;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(name);
  }, SNAPSHOT);
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByText('repo: only snapshots changed')).toBeVisible();
  await expect(caseRow(page, 'the plan of a push to main')).toHaveAttribute('data-status', 'failed');
  // The test file itself was never touched.
  expect(Buffer.from((await fileOf(page, CI_TEST))!.bytes).equals(readFileSync(join(FIXTURE, CI_TEST)))).toBe(
    true,
  );
});

test('a source with no route tests says where they go and how to add one', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(page.locator('.react-flow__node-workflow').first()).toBeVisible();
  await panelTab(page, 'Tests').click();
  await expect(testsPanel(page)).toHaveText(
    'No route tests in .github/simulci/tests. Add a case from a plan (Add case…) or read how.',
  );
  await expect(testsPanel(page).getByRole('link', { name: 'read how' })).toHaveAttribute('target', '_blank');
});
