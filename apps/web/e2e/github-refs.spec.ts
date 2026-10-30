import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type FakeGitHub, fakeGitHub, OWNER, REPO, WORKFLOWS } from './github-api';

/**
 * The ref picker of the Open GitHub repository dialog (M4 synthesis § 5.6, § 5.12), in a real browser under the
 * deployment's CSP, against the recorded api.github.com (`e2e/github-api.ts`): the default branch preselected and no
 * list asked for before the picker opens, a tag picked from the list and kept through a reload, a commit typed as its
 * SHA, the words for a ref GitHub does not have and for a name git refuses, a name that is both a branch and a tag,
 * a link to a tree whose branch has a `/`, and a spent rate limit while listing.
 */

const NAME = `${OWNER}/${REPO}`;
const REPOS = `/repos/${NAME}`;
const FILES = Object.keys(WORKFLOWS).length + 1;
const RELEASE = '.github/workflows/release.yml';

let errors: string[] = [];
/** Console errors a test expects: Chromium logs every 4xx answer. */
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
const picker = (page: Page): Locator => dialog(page).getByRole('combobox', { name: 'Branch, tag or commit' });
const list = (page: Page): Locator => dialog(page).getByRole('listbox', { name: 'Branches and tags' });
const short = (sha: string): string => sha.slice(0, 7);
const lists = [`${REPOS}/branches?per_page=100&page=1`, `${REPOS}/tags?per_page=100&page=1`];

/** The dialog from the empty state, the repository named, and what GitHub said of it. */
async function describe(page: Page, name = NAME): Promise<void> {
  await page.goto('/');
  await page.getByRole('main').getByRole('button', { name: 'Open GitHub repository…' }).click();
  await dialog(page).getByRole('textbox', { name: 'Repository' }).fill(name);
  await expect(dialog(page)).toContainText(`${NAME} · public · default branch main`);
}

/** Moves `main` on, so a ref made before it is at another commit. */
const moveMain = (github: FakeGitHub): void =>
  github.push({ [RELEASE]: `# moved on GitHub\n${WORKFLOWS[RELEASE]}` });

test('preselects the default branch, and asks for no list before the picker opens', async ({ page }) => {
  const github = await fakeGitHub(page);
  github.branch('dev');
  github.tag('v1.0.0');
  await describe(page);
  await expect(picker(page)).toHaveValue('main');
  await expect(list(page)).toBeHidden();
  expect(github.requests).toEqual([REPOS]);

  await dialog(page).getByRole('button', { name: 'Branches and tags' }).click();
  await expect(list(page).getByRole('option')).toHaveText([
    /^main\s*default branch$/,
    /^dev\s*branch$/,
    /^v1\.0\.0\s*tag$/,
  ]);
  await expect(list(page).getByRole('option', { selected: true })).toHaveText(/^main/);
  await expect(picker(page)).toBeFocused();
  expect(github.requests.slice(1).sort()).toEqual(lists);
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
    [],
  );

  // Escape closes the list and leaves the dialog; the list opening again asks nothing more.
  await picker(page).press('Escape');
  await expect(list(page)).toBeHidden();
  await expect(dialog(page)).toBeVisible();
  await picker(page).press('ArrowDown');
  await expect(list(page)).toBeVisible();
  expect(github.requests).toHaveLength(3);
  // Typing filters it and makes no option current; the arrows and Enter pick.
  await picker(page).fill('v1');
  await expect(list(page).getByRole('option')).toHaveText([/^v1\.0\.0/]);
  await expect(list(page).getByRole('option', { selected: true })).toHaveCount(0);
  await picker(page).press('ArrowDown');
  await picker(page).press('Enter');
  await expect(picker(page)).toHaveValue('v1.0.0');
  await expect(list(page)).toBeHidden();

  // Another repository's lists, then this one's again, from what was read: no request.
  expected = /status of 404/;
  const repository = dialog(page).getByRole('textbox', { name: 'Repository' });
  await repository.fill(`${OWNER}/elsewhere`);
  await dialog(page).getByRole('button', { name: 'Branches and tags' }).click();
  await expect(dialog(page)).toContainText(`GitHub did not list the branches of ${OWNER}/elsewhere`);
  await repository.fill(NAME);
  const read = github.requests.length;
  await dialog(page).getByRole('button', { name: 'Branches and tags' }).click();
  await expect(list(page).getByRole('option')).toHaveCount(3);
  expect(github.requests).toHaveLength(read);
});

test('opens at a tag picked from the list, and keeps it through a reload', async ({ page }) => {
  const github = await fakeGitHub(page);
  github.tag('v1.0.0');
  const tagged = github.commit();
  moveMain(github);
  await describe(page);
  await picker(page).press('ArrowDown');
  await list(page)
    .getByRole('option', { name: /^v1\.0\.0/ })
    .click();
  await expect(picker(page)).toHaveValue('v1.0.0');
  const before = github.requests.length;
  await dialog(page).getByRole('button', { name: 'Open' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(nav(page)).toContainText(`${NAME} @ v1.0.0 (${short(tagged)}) · ${FILES} files`);
  expect(github.requests[before]).toBe(`${REPOS}/commits/v1.0.0`);
  await expect(page).toHaveURL(new RegExp(`[?&]gh=${OWNER}%2F${REPO}%40v1\\.0\\.0(&|$)`));

  const read = github.requests.length;
  await page.reload();
  await expect(nav(page)).toContainText(`${NAME} @ v1.0.0 (${short(tagged)}) · ${FILES} files`);
  expect(github.requests).toHaveLength(read);
});

test('opens at a commit typed as its SHA, without listing anything', async ({ page }) => {
  const github = await fakeGitHub(page);
  const first = github.commit();
  moveMain(github);
  await describe(page);
  await picker(page).fill(first.toUpperCase());
  await dialog(page).getByRole('button', { name: 'Open' }).click();
  await expect(nav(page)).toContainText(`${NAME} @ ${short(first)} · ${FILES} files`);
  expect(github.requests.slice(0, 2)).toEqual([REPOS, `${REPOS}/commits/${first}`]);
  expect(github.requests.filter((r) => /\/(branches|tags)\?/.test(r))).toEqual([]);
});

test('says a ref GitHub does not have, and refuses a name git would before asking', async ({ page }) => {
  expected = /status of 422/;
  const github = await fakeGitHub(page);
  await describe(page);
  const open = dialog(page).getByRole('button', { name: 'Open' });
  const alert = dialog(page).getByRole('alert');

  await picker(page).fill('nope');
  await open.click();
  await expect(alert).toHaveText(`${NAME} has no branch, tag or commit named “nope”.`);
  const zeros = '0'.repeat(40);
  await picker(page).fill(zeros);
  await open.click();
  await expect(alert).toHaveText(`${NAME} has no commit ${zeros}.`);

  const before = github.requests.length;
  await picker(page).fill('../../../users');
  await open.click();
  await expect(alert).toHaveText('“../../../users” cannot be the name of a branch, tag or commit.');
  expect(github.requests).toHaveLength(before);
  await expect(dialog(page)).toBeVisible();
});

test('opens a name that is both a branch and a tag as the one picked', async ({ page }) => {
  const github = await fakeGitHub(page);
  github.tag('release');
  const tagged = github.commit();
  moveMain(github);
  github.branch('release');
  await describe(page);
  await dialog(page).getByRole('button', { name: 'Branches and tags' }).click();
  await list(page)
    .getByRole('option', { name: /^release\s*tag$/ })
    .click();
  await dialog(page).getByRole('button', { name: 'Open' }).click();
  await expect(nav(page)).toContainText(`${NAME} @ refs/tags/release (${short(tagged)})`);
  expect(github.requests).toContain(`${REPOS}/commits/refs%2Ftags%2Frelease`);
});

test('resolves a link to a tree whose branch has a slash, whole', async ({ page }) => {
  const github = await fakeGitHub(page);
  moveMain(github);
  github.branch('feature/x');
  await describe(page, `https://github.com/${NAME}/tree/feature/x/.github/workflows`);
  await expect(picker(page)).toHaveValue('feature');
  expect(github.requests).toEqual([REPOS]);
  await dialog(page).getByRole('button', { name: 'Open' }).click();
  await expect(nav(page)).toContainText(`${NAME} @ feature/x (${short(github.commit())})`);
  expect(github.requests.slice(1, 3).sort()).toEqual(lists);
  expect(github.requests[3]).toBe(`${REPOS}/commits/feature%2Fx`);
});

test('reads a link at the default branch without listing: no branch can start with it', async ({ page }) => {
  const github = await fakeGitHub(page);
  await describe(page, `https://github.com/${NAME}/tree/main/.github/workflows`);
  await dialog(page).getByRole('button', { name: 'Open' }).click();
  await expect(nav(page)).toContainText(`${NAME} @ main (${short(github.commit())})`);
  expect(github.requests.slice(0, 2)).toEqual([REPOS, `${REPOS}/commits/main`]);
  expect(github.requests.filter((r) => /\/(branches|tags)\?/.test(r))).toEqual([]);
});

test('says when the hour’s requests ran out while listing, and still opens a typed ref', async ({ page }) => {
  expected = /status of 403/;
  const github = await fakeGitHub(page);
  await describe(page);
  github.spend();
  await dialog(page).getByRole('button', { name: 'Branches and tags' }).click();
  await expect(
    dialog(page).getByRole('status').filter({ hasText: 'GitHub allows 60 requests' }),
  ).toContainText('GitHub allows 60 requests an hour without signing in; this browser has used them.');
  await expect(list(page)).toBeHidden();
  await expect(picker(page)).toHaveValue('main');
});
