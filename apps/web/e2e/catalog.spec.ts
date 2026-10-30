import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The action palette with the bundled catalog (synthesis § 4.8, § 9.2 C8), in a real browser under the deployment's
 * CSP (`connect-src` only api.github.com, for a GitHub source): the catalog's chunk loads from the app's own origin as the palette opens, a common action
 * the repository does not use yet is inserted at the catalog's ref, Properties lists its inputs from the catalog and
 * warns of a required one not set, Pin to SHA writes the commit the catalog recorded with the tag as a comment, and
 * undoing it all gives the file's bytes back. Nothing is fetched from GitHub.
 */

const PATH = '.github/workflows/ci.yml';

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run build
`;

interface Action {
  uses: string;
  ref: string;
  sha: string;
  inputs: { id: string; required: boolean; default?: string }[];
}

const catalog: Action[] = JSON.parse(
  readFileSync(new URL('../src/catalog/catalog.json', import.meta.url), 'utf8'),
);
const actionOf = (uses: string): Action => catalog.find((a) => a.uses === uses)!;

let errors: string[] = [];
let requests: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => requests.push(r.url()));
});

test.afterEach(({ baseURL }) => {
  expect(errors).toEqual([]);
  // The catalog is the app's own script: no request leaves the origin.
  expect(requests.filter((url) => !url.startsWith(baseURL!) && !url.startsWith('data:'))).toEqual([]);
});

const jobNode = (page: Page, job: string): Locator =>
  page.locator(`.react-flow__node-job[data-id="${PATH}#${job}"]`);
const pane = (page: Page): Locator => page.locator('[data-pane="yaml"]');
const properties = (page: Page): Locator => page.locator('[data-panel="node"]');

/** The CI file dropped and laid out in edit mode, build's first step selected by the keys. */
async function firstStep(page: Page): Promise<void> {
  await page.goto('/');
  const transfer = await page.evaluateHandle((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'ci.yml'));
    return dt;
  }, CI);
  await page.dispatchEvent('header', 'drop', { dataTransfer: transfer });
  await expect(jobNode(page, 'build')).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(page.getByRole('button', { name: '+ Add job' })).toBeAttached();
  await jobNode(page, 'build').click();
  await page.keyboard.press(' ');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/sel=build\.%231/);
}

async function downloaded(page: Page): Promise<string> {
  // The pane's key is the page's: not a field's, which would take it as text.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  const downloading = page.waitForEvent('download');
  await pane(page).locator('footer').getByRole('button', { name: 'Download' }).click();
  return readFileSync(await (await downloading).path(), 'utf8');
}

async function undoAll(page: Page): Promise<void> {
  const undo = page.getByRole('button', { name: /^Undo/ }).first();
  while ((await undo.getAttribute('aria-disabled')) !== 'true') await undo.click();
}

/** The palette opened with `s`, a query typed and its first entry picked. */
async function insert(page: Page, query: string, expected: string): Promise<void> {
  await page.keyboard.press('s');
  const palette = page.getByRole('dialog', { name: 'Add a step to build' });
  await expect(palette.getByRole('group', { name: 'Common actions' })).toContainText(expected);
  await page.keyboard.type(query);
  await expect(palette.getByRole('option').first()).toContainText(expected);
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/sel=build\.%232/, { timeout: 3000 });
}

test('actions/setup-node from the catalog is inserted at its ref, lists its inputs, and pins to its commit', async ({
  page,
}) => {
  const node = actionOf('actions/setup-node');
  const uses = `actions/setup-node@${node.ref}`;
  await firstStep(page);
  await insert(page, 'setup-node', uses);
  expect(requests.some((url) => /\/assets\/catalog-[\w-]+\.js$/.test(url))).toBe(true);
  await expect(properties(page).getByRole('heading', { name: uses }).first()).toBeVisible();
  const withRows = properties(page).getByRole('region', { name: 'With' });
  await expect(withRows.getByRole('textbox', { name: node.inputs[0]!.id, exact: true })).toBeVisible();
  // setup-node declares no input it cannot do without.
  await expect(withRows.getByText(/, and not set$/)).toHaveCount(0);
  expect(await downloaded(page)).toContain(
    `      - uses: actions/checkout@v4\n      - uses: ${uses}\n      - run:`,
  );
  await properties(page).getByRole('button', { name: 'Pin to SHA' }).click();
  await expect(properties(page).getByText(`Pinned to ${node.ref}`)).toBeVisible({ timeout: 3000 });
  expect(await downloaded(page)).toContain(`      - uses: actions/setup-node@${node.sha} # ${node.ref}\n`);
  await undoAll(page);
  expect(await downloaded(page)).toBe(CI);
});

test('a required input not set is a warning in Properties until a value is typed into it', async ({
  page,
}) => {
  const upload = actionOf('actions/upload-artifact');
  const uses = `actions/upload-artifact@${upload.ref}`;
  const required = upload.inputs.find((i) => i.required && i.default === undefined)!;
  await firstStep(page);
  await insert(page, 'upload-artifact', uses);
  const withRows = properties(page).getByRole('region', { name: 'With' });
  const warning = withRows.getByText(`required by ${uses}, and not set`);
  await expect(warning).toBeVisible({ timeout: 3000 });
  const field = withRows.getByRole('textbox', { name: required.id, exact: true });
  await field.fill('dist');
  await field.press('Enter');
  await expect(warning).toHaveCount(0, { timeout: 3000 });
  expect(await downloaded(page)).toContain(
    `      - uses: ${uses}\n        with:\n          ${required.id}: dist\n`,
  );
  await undoAll(page);
  expect(await downloaded(page)).toBe(CI);
});
