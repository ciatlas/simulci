import { expect, type Locator, type Page, test } from '@playwright/test';
import { elsewhere, fakeGitHub, isElsewhere, OWNER, REPO, remotesRead } from './github-api';

/**
 * Remotes for any source (M4 synthesis § 5.3, § 5.12), in a real browser under the deployment's CSP, with
 * api.github.com answered through `page.route`: a pasted workflow that calls a remote workflow and a remote action
 * shows the chip and asks GitHub nothing until Fetch (failure mode 15); the click reads each, and the plan simulates
 * the callee; the pasted files restored by a reload ask nothing again before a click; a GitHub repository reads what it
 * calls without the chip.
 */

const CI = '.github/workflows/ci.yml';
const DEPLOY = 'octo/ship/.github/workflows/deploy.yml@v1';
const ACT = 'octo/act@v2';
const WORKFLOW = `on: push
jobs:
  ship:
    uses: ${DEPLOY}
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACT}
`;

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

/** api.github.com as the repositories a workflow calls; every GET recorded as `<path><search>`. */
async function calledRepositories(page: Page): Promise<string[]> {
  const requests: string[] = [];
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'Authorization, If-None-Match, X-GitHub-Api-Version',
          'access-control-allow-methods': 'GET',
        },
      });
    const url = new URL(request.url());
    requests.push(url.pathname + url.search);
    const found = elsewhere(url.pathname + url.search, request.headers().accept ?? '');
    await route.fulfill({
      status: found?.status ?? 404,
      headers: { 'access-control-allow-origin': '*' },
      contentType: found?.type ?? 'application/json',
      body: found?.body ?? '{"message":"Not Found"}',
    });
  });
  return requests;
}

const chip = (page: Page): Locator => page.getByRole('contentinfo').filter({ hasText: 'not fetched' });
const fetchButton = (page: Page): Locator => page.getByRole('button', { name: 'Fetch from api.github.com' });

async function paste(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('main').getByRole('button', { name: 'Paste YAML' }).click();
  const dialog = page.getByRole('dialog', { name: 'Paste a workflow or an action' });
  await dialog.getByLabel('Path in the repository').fill(CI);
  await dialog.getByLabel('YAML').fill(WORKFLOW);
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog).toHaveCount(0);
}

/** The plan as `simulci plan` prints it. */
async function planText(page: Page): Promise<Locator> {
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Text' }).click();
  return page.getByRole('main');
}

test('a pasted workflow asks GitHub nothing until Fetch, then plans the remote workflow and action it calls', async ({
  page,
}) => {
  const requests = await calledRepositories(page);
  await paste(page);
  await expect(chip(page)).toContainText(
    '1 remote workflow and 1 action not fetched · Fetch from api.github.com',
  );
  // Past the reads' quiet, still nothing asked.
  await page.waitForTimeout(1500);
  expect(requests).toEqual([]);
  const text = await planText(page);
  await expect(text).toContainText(`└ ${DEPLOY} (remote, not fetched)`);

  await fetchButton(page).click();
  await expect(text).toContainText(
    new RegExp(`${DEPLOY.replaceAll('.', '\\.')} → [0-9a-f]{7} \\(resolved\\)`),
  );
  await expect(text).toContainText(new RegExp(`${ACT} → [0-9a-f]{7} \\(resolved\\)`));
  // The callee's job is planned, under the call, as the remote it is.
  await expect(text).toContainText(new RegExp(`${DEPLOY.replaceAll('.', '\\.')} \\(remote, [0-9a-f]{7}\\)`));
  await expect(chip(page)).toHaveCount(0);
  expect(requests.sort()).toEqual([
    '/repos/octo/act/commits/v2',
    expect.stringMatching(/^\/repos\/octo\/act\/contents\/action\.yml\?ref=[0-9a-f]{40}$/),
    '/repos/octo/ship/commits/v1',
    expect.stringMatching(
      /^\/repos\/octo\/ship\/contents\/\.github\/workflows\/deploy\.yml\?ref=[0-9a-f]{40}$/,
    ),
  ]);
});

test('the pasted files restored by a reload, or with a link, ask GitHub nothing again before a click', async ({
  page,
}) => {
  const requests = await calledRepositories(page);
  await paste(page);
  await fetchButton(page).click();
  await expect(chip(page)).toHaveCount(0);
  await expect.poll(() => requests.length).toBe(4);

  await page.reload();
  await expect(chip(page)).toContainText('1 remote workflow and 1 action not fetched');
  await page.goto('/?event=push');
  await expect(chip(page)).toContainText('1 remote workflow and 1 action not fetched');
  await page.waitForTimeout(1500);
  expect(requests).toHaveLength(4);
});

test('a GitHub repository reads the remotes it calls without the chip', async ({ page }) => {
  const github = await fakeGitHub(page);
  await page.goto('/');
  await page.getByRole('main').getByRole('button', { name: 'Open GitHub repository…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open a GitHub repository' });
  await dialog.getByRole('textbox', { name: 'Repository' }).fill(`${OWNER}/${REPO}`);
  await expect(dialog).toContainText(`${OWNER}/${REPO} · public`);
  await dialog.getByRole('button', { name: 'Open' }).click();
  await expect(dialog).toHaveCount(0);
  // The workflows pin every action by its SHA: each is read at it, one request apiece, no resolve.
  await remotesRead(page, github);
  const text = await planText(page);
  await expect(text).toContainText(/actions\/checkout@\w{40} → \w{7} \(sha-ref\)/);
  expect(
    github.requests
      .filter(isElsewhere)
      .every((r) => /\/contents\/(?:[^?]+\/)?action\.yml\?ref=\w{40}$/.test(r)),
  ).toBe(true);
  await expect(chip(page)).toHaveCount(0);
});
