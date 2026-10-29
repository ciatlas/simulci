import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Editing the YAML in the pane, in a real browser under the deployment's CSP (synthesis § 9.2 A5, C2, § 9.5): the
 * closed pane has a bar that opens it, and edit mode opens it; in edit mode a key typed into a file re-simulates and
 * the card follows; undoing everything gives back the file's bytes; an edit that stops the workflow from being
 * triggered keeps its jobs on the canvas, dimmed under a banner; a CRLF file with a BOM edited by one character
 * downloads with exactly that character changed, its BOM and its CRLF kept; a generated file refuses edits until the author unlocks it; an edit survives a reload; opening another
 * source while a file has unsaved edits asks first; and the status line says what an edit changed, with Details. The
 * edit runtime (the `edit-*` chunk, synthesis § 2.1) is fetched when the author turns edit mode on, or on idle once
 * dropped files have a plan, and not for a sample looked at.
 */

const CI = '.github/workflows/ci.yml';
const STARTER_CI = readFileSync(join(import.meta.dirname, '../src/samples/starter/ci.yml'), 'utf8');

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

const jobNode = (page: Page, job: string, path = CI): Locator =>
  page.locator(`.react-flow__node-job[data-id="${path}#${job}"]`);
const pane = (page: Page): Locator => page.locator('[data-pane="yaml"]');
const editor = (page: Page): Locator => pane(page).locator('.cm-content');
const footer = (page: Page): Locator => pane(page).locator('footer');

async function openStarter(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(jobNode(page, 'deploy')).toBeVisible();
}

/** The top bar's Edit switch on, which opens the YAML pane on its file. */
async function editMode(page: Page): Promise<void> {
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(page.getByRole('switch', { name: /^Edit/ })).toHaveAttribute('aria-checked', 'true');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
}

/** The cursor at the end of a line of the shown file, by the keyboard alone. */
async function endOfLine(page: Page, line: number): Promise<void> {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
}

/** The shown file as Download hands it over, byte for byte. */
async function downloaded(page: Page): Promise<Buffer> {
  const downloading = page.waitForEvent('download');
  await footer(page).getByRole('button', { name: 'Download' }).click();
  return readFileSync(await (await downloading).path());
}

/** Drops loose files on the page, as the author drags them in: they become pasted workflows by their names. */
async function dropFiles(page: Page, files: Record<string, number[]>): Promise<void> {
  const transfer = await page.evaluateHandle((given) => {
    const dt = new DataTransfer();
    for (const [name, bytes] of Object.entries(given)) dt.items.add(new File([new Uint8Array(bytes)], name));
    return dt;
  }, files);
  await page.dispatchEvent('header', 'drop', { dataTransfer: transfer });
}

const bytesOf = (text: string): number[] => [...Buffer.from(text, 'utf8')];

/** Line 43 of the starter's CI: deploy's `if:`, whose condition runs it on a push. */
const DEPLOY_IF = "github.event_name == 'push' || inputs.deploy";

async function skipDeploy(page: Page): Promise<void> {
  await endOfLine(page, 43);
  for (let i = 0; i < DEPLOY_IF.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.type('false');
}

test('the bar under the plan opens the closed YAML pane, and turning edit mode on opens it too', async ({
  page,
}) => {
  await openStarter(page);
  await expect(pane(page)).toHaveCount(0);
  const open = page.getByRole('button', { name: 'Open the workflow source' });
  await open.click();
  await expect(editor(page)).toBeVisible();
  await footer(page).getByRole('button', { name: 'Close the workflow source' }).click();
  await expect(pane(page)).toHaveCount(0);
  await expect(open).toBeVisible();
  await editMode(page);
});

test('typing if: false turns the deploy card skipped, and undoing everything gives back the file’s bytes', async ({
  page,
}) => {
  await openStarter(page);
  await expect(jobNode(page, 'deploy')).not.toHaveAttribute('aria-label', /^skipped/);
  await editMode(page);
  await skipDeploy(page);
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/, { timeout: 2000 });
  await expect(footer(page)).toContainText('● unsaved');
  await expect(page).toHaveTitle('• simulci');

  // Mod+Z in the editor goes to the page's history, as the Undo button does; the canvas follows.
  await page.keyboard.press('ControlOrMeta+z');
  const undo = page.getByRole('button', { name: /^Undo/ });
  while ((await undo.getAttribute('aria-disabled')) !== 'true') await undo.click();
  await expect(jobNode(page, 'deploy')).not.toHaveAttribute('aria-label', /^skipped/);
  await expect(footer(page)).not.toContainText('● unsaved');
  await expect(page).toHaveTitle('simulci');
  expect((await downloaded(page)).toString('utf8')).toBe(STARTER_CI);
  // Mod+Y redoes on the page outside the editor, Mod+Z undoes there too, and Mod+Shift+Z redoes in the editor.
  await page.keyboard.press('ControlOrMeta+y');
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(jobNode(page, 'deploy')).not.toHaveAttribute('aria-label', /^skipped/);
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/);
  await expect(page.getByRole('button', { name: /^Undo/ })).toHaveAttribute(
    'aria-label',
    'Undo Typed in ci.yml',
  );
});

test('typing a branch filter that untriggers CI says so, and Details lists it', async ({ page }) => {
  await openStarter(page);
  await editMode(page);
  // Line 4 of the starter's CI: `    branches: [main]`; the branch is replaced in one input.
  await endOfLine(page, 4);
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 'main'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.insertText('release');

  const sentence = page.getByRole('contentinfo').locator('[aria-live="polite"]');
  await expect(sentence).toHaveText('Edited ci.yml: CI is no longer triggered', { timeout: 3000 });
  await page.getByRole('contentinfo').getByRole('button', { name: 'Details' }).click();
  const rows = page.getByRole('list', { name: 'What changed' });
  await expect(rows.getByRole('button', { name: 'CI is no longer triggered' })).toBeVisible();
  // The checks CI reported went with it: listed, with nothing left on the canvas to select.
  await expect(rows).toContainText("check 'build' removed");
  await rows.getByRole('button', { name: 'CI is no longer triggered' }).click();
  await expect(page.locator(`.react-flow__node-workflow[data-id="${CI}"] .sc-scope`)).toHaveAttribute(
    'data-selected',
    'self',
  );
});

test('filtering the push to release branches keeps the jobs on the canvas, dimmed under a banner whose button simulates another event', async ({
  page,
}) => {
  await openStarter(page);
  await editMode(page);
  // Line 4 of the starter's CI: `branches: [main]` under its push, which the scenario simulates.
  await endOfLine(page, 4);
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 'main'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.type('release/**');

  const banner = page.getByRole('status').filter({ hasText: 'Not triggered by' });
  await expect(banner.locator('p')).toHaveText(
    'Not triggered by push to main (branches [release/**] ← main: false). Showing its jobs as they would be planned.',
  );
  await expect(page.locator(`.react-flow__node-workflow[data-id="${CI}"] .sc-scope`)).toHaveAttribute(
    'data-dimmed',
    'true',
  );
  for (const job of ['test', 'build', 'deploy', 'preview'])
    await expect(jobNode(page, job)).toHaveAttribute('aria-label', /^skipped .* — parent no/);
  // The Reasons tab says why a job of it is skipped, and the canvas still selects it.
  await jobNode(page, 'deploy').locator('.sc-card-label').click();
  await page
    .getByRole('tablist', { name: 'Plan details' })
    .getByRole('tab', { name: /^Reasons/ })
    .click();
  await expect(page.getByRole('tabpanel', { name: 'Reasons' })).toContainText(
    'Its workflow is not triggered',
  );

  await banner.getByRole('button', { name: 'Simulate pull_request instead' }).click();
  // In edit mode the triggers editor's radios are the event picker.
  await expect(
    page.getByRole('region', { name: 'Triggers' }).getByRole('radio', { name: 'pull_request' }),
  ).toBeChecked();
  await expect(banner).toHaveCount(0);
  await expect(jobNode(page, 'test')).not.toHaveAttribute('aria-label', /^skipped/);
});

test('a CRLF file with a BOM edited by one character downloads with that character changed and nothing else', async ({
  page,
}) => {
  const text =
    'name: CRLF\r\non: push\r\njobs:\r\n  a:\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - run: echo\r\n';
  await page.goto('/');
  await dropFiles(page, { 'crlf.yml': [0xef, 0xbb, 0xbf, ...bytesOf(text)] });
  await expect(jobNode(page, 'a', '.github/workflows/crlf.yml')).toBeVisible();
  await editMode(page);
  await expect(footer(page)).toContainText('CRLF · 2 spaces');
  await endOfLine(page, 1);
  await page.keyboard.type('X');
  await expect(footer(page)).toContainText('● unsaved');
  const bytes = await downloaded(page);
  expect([...bytes]).toEqual([0xef, 0xbb, 0xbf, ...bytesOf(text.replace('name: CRLF', 'name: CRLFX'))]);
  // A line break typed into it is a CRLF too.
  await endOfLine(page, 1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('#');
  const after = (await downloaded(page)).toString('utf8');
  expect(after).toBe(`\uFEFF${text.replace('name: CRLF\r\n', 'name: CRLFX\r\n#\r\n')}`);
});

test('a generated file refuses edits until the author unlocks it', async ({ page }) => {
  const text =
    '# Code generated by gen. DO NOT EDIT.\non: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: echo }]\n';
  await page.goto('/');
  await dropFiles(page, { 'made.yml': bytesOf(text) });
  await expect(jobNode(page, 'a', '.github/workflows/made.yml')).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  await expect(footer(page)).toContainText('Generated (line 1: Code generated by gen.)');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
  await footer(page).getByRole('button', { name: 'Edit anyway' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  // The button goes; the focus goes to the text it unlocked, not to the page.
  await expect(editor(page)).toBeFocused();
  await endOfLine(page, 2);
  await page.keyboard.type(' # edited');
  await expect(footer(page)).toContainText('● unsaved');
});

test('an edit of the sample survives a reload, as the edited copy it became, still unsaved', async ({
  page,
}) => {
  await openStarter(page);
  await editMode(page);
  await skipDeploy(page);
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/);
  await expect(page.getByRole('navigation', { name: 'Source' })).toContainText(
    'edited copy of the starter sample',
  );
  // The buffers are written 500 ms after the last edit; then nothing waits, and the page leaves without asking.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/);
  await expect(page.getByRole('navigation', { name: 'Source' })).toContainText(
    'edited copy of the starter sample',
  );
  // Still unsaved: the buffers keep the text the edit was made to, so opening another sample asks.
  await expect(page).toHaveTitle('• simulci');
  await page.getByRole('navigation', { name: 'Source' }).getByRole('combobox').selectOption('monorepo');
  await expect(page.getByRole('dialog', { name: 'Unsaved edits' })).toContainText(
    'ci.yml has unsaved edits.',
  );
});

test('opening a sample or pasting over a file with unsaved edits asks first: Cancel keeps them, Discard goes on', async ({
  page,
}) => {
  await openStarter(page);
  await editMode(page);
  await skipDeploy(page);
  await expect(footer(page)).toContainText('● unsaved');
  const sample = page.getByRole('navigation', { name: 'Source' }).getByRole('combobox');
  await sample.selectOption('monorepo');
  const dialog = page.getByRole('dialog', { name: 'Unsaved edits' });
  await expect(dialog).toContainText('ci.yml has unsaved edits. Opening the monorepo sample drops them.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/);

  // Pasting over the edited file asks too; Cancel keeps the edits, and the paste dialog with what was pasted.
  await page.getByRole('navigation', { name: 'Source' }).getByRole('button', { name: 'Paste YAML' }).click();
  const paste = page.getByRole('dialog', { name: 'Paste a workflow or an action' });
  await paste.getByLabel('Path in the repository').fill(CI);
  await paste.getByLabel('YAML').fill('on: push\n');
  await paste.getByRole('button', { name: 'Add' }).click();
  await expect(dialog).toContainText(`ci.yml has unsaved edits. Pasting ${CI} drops them.`);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(paste.getByLabel('YAML')).toHaveValue('on: push\n');
  await paste.getByRole('button', { name: 'Cancel' }).click();
  await expect(paste).toHaveCount(0);
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/);

  await sample.selectOption('monorepo');
  await dialog.getByRole('button', { name: 'Discard edits' }).click();
  await expect(page.getByRole('navigation', { name: 'Source' })).toContainText('sample: monorepo');
});

/** The edit runtime's chunk, each time the page asks the server for it. */
function editFetches(page: Page): string[] {
  const fetched: string[] = [];
  page.on('request', (request) => {
    if (/\/assets\/edit-[\w-]+\.js$/.test(new URL(request.url()).pathname)) fetched.push(request.url());
  });
  return fetched;
}

test('a sample looked at fetches no edit runtime; turning edit mode on fetches it once', async ({ page }) => {
  const fetched = editFetches(page);
  await openStarter(page);
  // Past the idle callback's timeout: a folder or dropped files would have fetched it by now.
  await page.waitForTimeout(2500);
  expect(fetched).toEqual([]);
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect.poll(() => fetched.length).toBe(1);
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await page.waitForTimeout(300);
  expect(fetched).toHaveLength(1);
});

test('dropped files fetch the edit runtime on idle once their plan is on screen', async ({ page }) => {
  const fetched = editFetches(page);
  await page.goto('/');
  await dropFiles(page, { 'ci.yml': bytesOf(STARTER_CI) });
  await expect(jobNode(page, 'deploy')).toBeVisible();
  await expect.poll(() => fetched.length, { timeout: 5000 }).toBe(1);
});
