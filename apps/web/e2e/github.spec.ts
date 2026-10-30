import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type FakeGitHub, fakeGitHub, OWNER, REPO, WORKFLOWS } from './github-api';

/**
 * A public GitHub repository (M4 synthesis § 5.5, § 5.7, § 5.12), in a real browser under the deployment's CSP, with
 * api.github.com answered by the recorded fixtures (`e2e/github-api.ts`): open it from the empty state and see what
 * it cost, edit it and get the edit back after a reload without a request (failure mode 14), be asked before leaving,
 * take its patch with the commands that apply it, Fetch again when nothing moved and when a file did, the sentence a
 * spent rate limit gets, a link that offers a repository and asks GitHub nothing before the click (failure mode 15),
 * a link to the repository stored here that opens it offline, and the CSP refusing any other host even when routed.
 */

const NAME = `${OWNER}/${REPO}`;
const CI = '.github/workflows/ci.yml';
/** Nine workflows and the root action.yml. */
const FILES = Object.keys(WORKFLOWS).length + 1;

let errors: string[] = [];
/** Console errors a test expects: Chromium logs every 403 and every refused connection. */
let expected: RegExp | undefined;

test.beforeEach(({ page }) => {
  errors = [];
  expected = undefined;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
});

test.afterEach(() => {
  expect(errors.filter((e) => !expected?.test(e))).toEqual([]);
});

const nav = (page: Page): Locator => page.getByRole('navigation', { name: 'Source' });
const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Open a GitHub repository' });
const said = (page: Page, text: string | RegExp): Locator =>
  page.getByRole('status').filter({ hasText: text });
const pane = (page: Page): Locator => page.locator('[data-pane="yaml"]');
const editor = (page: Page): Locator => pane(page).locator('.cm-content');
const short = (github: FakeGitHub): string => github.commit().slice(0, 7);

/** The empty state's card, the dialog, the name typed, what GitHub said of it, then Open. */
async function openFromEmptyState(page: Page, github: FakeGitHub): Promise<void> {
  await page.goto('/');
  await page.getByRole('main').getByRole('button', { name: 'Open GitHub repository…' }).click();
  await dialog(page).getByRole('textbox', { name: 'Repository' }).fill(`https://github.com/${NAME}`);
  await expect(dialog(page)).toContainText(
    `${NAME} · public · default branch main · 59 of 60 requests left this hour`,
  );
  await dialog(page).getByRole('button', { name: 'Open' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(nav(page)).toContainText(`${NAME} @ main (${short(github)}) · ${FILES} files`);
}

/** Edit mode on, the pane on ci.yml, `# mine` typed at its top. */
async function editCi(page: Page): Promise<void> {
  await page.getByRole('switch', { name: /^Edit/ }).click();
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  await page.getByRole('tab', { name: 'ci.yml' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('# mine\n');
  await expect(nav(page)).toContainText('1 unsaved');
}

test('opens a public repository from the empty state, at its default branch, for 4 + N requests', async ({
  page,
}) => {
  const github = await fakeGitHub(page);
  await openFromEmptyState(page, github);
  // The dialog's GET /repos is the only one: Open reads the commit, two trees and each file it keeps.
  expect(github.requests).toEqual([
    `/repos/${NAME}`,
    `/repos/${NAME}/commits/main`,
    `/repos/${NAME}/git/trees/${github.commit()}`,
    expect.stringMatching(new RegExp(`^/repos/${NAME}/git/trees/\\w{40}\\?recursive=1$`)),
    ...Array.from({ length: FILES }, () =>
      expect.stringMatching(new RegExp(`^/repos/${NAME}/git/blobs/\\w{40}$`)),
    ),
  ]);
  await expect(page.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
    'href',
    `https://github.com/${NAME}/tree/${github.commit()}`,
  );
  await expect(page).toHaveURL(new RegExp(`[?&]gh=${OWNER}%2F${REPO}%40main(&|$)`));
  // The engine was told the repository: the scenario's defaults take its default branch.
  await expect(page.getByRole('combobox', { name: 'Event' })).toBeVisible();
});

test('keeps an edit through a reload without a request, asks before leaving, and names its patch', async ({
  page,
}) => {
  const github = await fakeGitHub(page);
  await openFromEmptyState(page, github);
  await editCi(page);
  await expect(
    said(page, `Read from ${NAME} at ${short(github)}. Download a patch and apply it in your checkout.`),
  ).toBeVisible();

  const before = github.requests.length;
  await page.reload();
  await expect(nav(page)).toContainText('1 unsaved');
  await expect(said(page, /^Restored unsaved edits to 1 file/)).toBeVisible();
  expect(github.requests.length).toBe(before);

  await page.getByRole('button', { name: 'Changes (1)' }).click();
  const changes = page.getByRole('dialog', { name: 'Changes' });
  const patch = `${OWNER}-${REPO}-${short(github)}.patch`;
  await expect(changes).toContainText(`Download the patch as ${patch}, then in a checkout of ${NAME}:`);
  await expect(changes.getByRole('region', { name: 'Apply in your checkout' })).toContainText(
    `git fetch origin && git switch -c simulci-edits ${short(github)} && git apply ${patch}`,
  );
  const download = page.waitForEvent('download');
  await changes.getByRole('button', { name: 'Download patch' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(patch);
  const text = readFileSync(await file.path(), 'utf8');
  expect(text.split('\n').slice(0, 3)).toEqual([
    `simulci: changes against ${NAME}@${short(github)} (main)`,
    `diff --git a/${CI} b/${CI}`,
    `--- a/${CI}`,
  ]);
  await changes.getByRole('button', { name: 'Close' }).click();

  const asked = new Promise<string>((resolve) =>
    page.once('dialog', (d) => {
      resolve(d.type());
      void d.dismiss();
    }),
  );
  await page.close({ runBeforeUnload: true });
  expect(await asked).toBe('beforeunload');
});

test('Fetch again costs one request when main has not moved, and takes in a moved file around an edit', async ({
  page,
}) => {
  const github = await fakeGitHub(page);
  await openFromEmptyState(page, github);
  const first = short(github);
  let before = github.requests.length;
  await nav(page).getByRole('button', { name: 'Fetch again' }).click();
  await expect(said(page, `${NAME}: up to date (${first})`)).toBeVisible();
  expect(github.requests.slice(before)).toEqual([`/repos/${NAME}/commits/main`]);

  await editCi(page);
  const release = '.github/workflows/release.yml';
  github.push({ [release]: `# moved on GitHub\n${WORKFLOWS[release]}` });
  before = github.requests.length;
  await nav(page).getByRole('button', { name: 'Fetch again' }).click();
  await expect(said(page, `${NAME}: now at ${short(github)}`)).toBeVisible();
  await expect(nav(page)).toContainText(`${NAME} @ main (${short(github)})`);
  // The commit, the two trees, and the one file that changed: the rest come from the cache.
  expect(github.requests.length - before).toBe(4);
  await expect(nav(page)).toContainText('1 unsaved');
  await page.getByRole('tab', { name: 'release.yml' }).click();
  await expect(editor(page)).toContainText('# moved on GitHub');
  await page.getByRole('tab', { name: 'ci.yml' }).click();
  await expect(editor(page)).toContainText('# mine');
});

test('says when the hour’s requests are spent, and when they come back', async ({ page }) => {
  expected = /status of 403/;
  const github = await fakeGitHub(page);
  github.spend();
  await page.goto('/');
  await nav(page).getByRole('button', { name: 'Open GitHub repository…' }).click();
  await dialog(page).getByRole('textbox', { name: 'Repository' }).fill(NAME);
  const reset = await page.evaluate(() =>
    new Date(Date.UTC(2026, 9, 30, 14, 5)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  );
  const sentence = `GitHub allows 60 requests an hour without signing in; this browser has used them. They reset at ${reset}.`;
  await expect(dialog(page)).toContainText(sentence);
  await dialog(page).getByRole('button', { name: 'Open' }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(sentence);
  await expect(page.getByRole('main').getByRole('heading', { name: 'What runs if…' })).toBeVisible();
});

test('a link to a repository offers it and asks GitHub nothing before the click', async ({ page }) => {
  const github = await fakeGitHub(page);
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (/\/assets\/github-/.test(r.url())) chunks.push(r.url());
  });
  await page.goto(`/?event=push&gh=${NAME}@main`);
  const offer = page.getByRole('region', { name: 'Open from GitHub' });
  await expect(offer).toContainText(
    `Open ${NAME} @ main from GitHub? simulci reads its workflow files from api.github.com.`,
  );
  await expect(page.getByRole('main').getByRole('heading', { name: 'What runs if…' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(github.requests).toEqual([]);
  expect(chunks).toEqual([]);

  await offer.getByRole('button', { name: `Open ${NAME}` }).click();
  await expect(nav(page)).toContainText(`${NAME} @ main (${short(github)}) · ${FILES} files`);
  await expect(offer).toHaveCount(0);
  // Without the dialog, Open asks for the repository itself too.
  expect(github.requests.length).toBe(4 + FILES);
  await expect(page).toHaveURL(/[?&]event=push(&|$)/);
});

test('a link to the repository stored here opens it offline, and Dismiss lets another go', async ({
  page,
}) => {
  const github = await fakeGitHub(page);
  await openFromEmptyState(page, github);
  const before = github.requests.length;
  await page.goto(`/?gh=${NAME}@main`);
  await expect(nav(page)).toContainText(`${NAME} @ main (${short(github)}) · ${FILES} files`);
  await expect(page.getByRole('region', { name: 'Open from GitHub' })).toHaveCount(0);
  expect(github.requests.length).toBe(before);

  await page.goto(`/?gh=${OWNER}/elsewhere`);
  const offer = page.getByRole('region', { name: 'Open from GitHub' });
  await expect(offer).toContainText(`Open ${OWNER}/elsewhere from GitHub?`);
  await offer.getByRole('button', { name: 'Dismiss' }).click();
  await expect(offer).toHaveCount(0);
  await expect(page).not.toHaveURL(/elsewhere/);
  expect(github.requests.length).toBe(before);
});

test('the CSP lets the page reach api.github.com and refuses any other host, a routed one too', async ({
  page,
}) => {
  expected = /Content Security Policy/;
  await fakeGitHub(page);
  await page.route('https://example.com/**', (r) =>
    r.fulfill({ status: 200, body: 'routed', headers: { 'access-control-allow-origin': '*' } }),
  );
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const out: string[] = [];
    for (const url of ['https://api.github.com/repos/ciatlas/flowpact', 'https://example.com/x'])
      out.push(
        await fetch(url).then(
          (r) => String(r.status),
          () => 'refused',
        ),
      );
    return out;
  });
  expect(results).toEqual(['200', 'refused']);
  const headers = (await page.request.get('/')).headers();
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
});
