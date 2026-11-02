import { expect, type Locator, type Page, test } from '@playwright/test';
import { elsewhere } from './github-api';

/**
 * Remote workflows on the canvas (M4 synthesis § 5.4), in a real browser under the deployment's CSP, api.github.com
 * answered through `page.route`: before Fetch each call is a dashed stub with Fetch; after it, a read callee is a scope
 * headed by its repository, file, ref and commit, whose reasons link to the file on GitHub; one GitHub says is not there
 * is a stub with why, and one it did not answer offers Retry, which reads it. An edit inside a remote callee is
 * refused with where to make it. SHOTS=<dir> saves a screenshot of each state there.
 */

const CI = '.github/workflows/ci.yml';
const DEPLOY = 'octo/ship/.github/workflows/deploy.yml@v1';
const GONE = 'octo/gone/.github/workflows/x.yml@v1';
const FLAKY = 'octo/flaky/.github/workflows/y.yml@v1';
const ACT = 'octo/act@v2';
const WORKFLOW = `on: push
jobs:
  ship:
    uses: ${DEPLOY}
  gone:
    uses: ${GONE}
  flaky:
    uses: ${FLAKY}
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACT}
`;
const CALLEE = `on: workflow_call
jobs:
  release:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: ./release
`;
const SHOTS = process.env.SHOTS;

let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // A 404 or a 503 the fake API answers is logged by the browser as a failed resource; nothing else may be.
    if (m.type() === 'error' && !/status of (404|503)/.test(m.text())) errors.push(m.text());
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const CORS = { 'access-control-allow-origin': '*' };
const PREFLIGHT = {
  status: 204,
  headers: {
    ...CORS,
    'access-control-allow-headers': 'Authorization, If-None-Match, X-GitHub-Api-Version',
    'access-control-allow-methods': 'GET',
  },
};

/** What the fake API answers a GET: octo/gone is not there, octo/flaky is down until healed, the rest as `elsewhere`. */
function answer(path: string, accept: string, healed: boolean) {
  if (path.startsWith('/repos/octo/gone/'))
    return { status: 404, headers: CORS, body: '{"message":"Not Found"}' };
  if (path.startsWith('/repos/octo/flaky/') && !healed)
    return { status: 503, headers: CORS, body: '{"message":"Unavailable"}' };
  const found = elsewhere(path, accept);
  if (!found) return { status: 404, headers: CORS, body: '{"message":"Not Found"}' };
  const body = path.includes('/octo/ship/contents/') ? CALLEE : found.body;
  return { status: found.status, headers: CORS, contentType: found.type, body };
}

/** api.github.com through `page.route`, as `answer` says. */
async function github(page: Page): Promise<{ heal(): void }> {
  let healed = false;
  await page.route('https://api.github.com/**', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill(PREFLIGHT);
    const url = new URL(request.url());
    return route.fulfill(answer(url.pathname + url.search, request.headers().accept ?? '', healed));
  });
  return { heal: () => (healed = true) };
}

async function paste(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('main').getByRole('button', { name: 'Paste YAML' }).click();
  const dialog = page.getByRole('dialog', { name: 'Paste a workflow or an action' });
  await dialog.getByLabel('Path in the repository').fill(CI);
  await dialog.getByLabel('YAML').fill(WORKFLOW);
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog).toHaveCount(0);
}

const job = (page: Page, id: string): Locator => page.locator(`.react-flow__node-job[data-id="${id}"]`);
const callee = (page: Page): Locator =>
  page.locator(`.react-flow__node-workflow[data-id="${CI}#ship>${DEPLOY}"]`);
const tab = (page: Page, name: string): Locator =>
  page.getByRole('tablist', { name: 'Plan details' }).getByRole('tab', { name: new RegExp(`^${name}`) });
const footer = (page: Page): Locator => page.getByRole('contentinfo');

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wv-${name}.png` });
}

test('a call not fetched is a stub with Fetch; read, its callee is headed by where it was read', async ({
  page,
}) => {
  const api = await github(page);
  await paste(page);
  const ship = job(page, `${CI}#ship`);
  await expect(ship.locator('.sc-stub-title')).toHaveText('↗octo/ship · deploy.yml @ v1, not fetched.');
  await expect(ship.locator('.sc-stub-words')).toContainText('Its jobs and outputs are unknown.');
  await expect(footer(page)).toContainText(
    '3 remote workflows · 3 workflows and 1 action not fetched · Fetch from api.github.com',
  );
  await shot(page, 'not-fetched');

  await ship.click();
  await tab(page, 'Node').click();
  const facts = page.getByRole('tabpanel', { name: 'Node' });
  await expect(facts).toContainText('might');
  await expect(facts).toContainText('success, failure or skipped');
  await expect(facts).toContainText('assume {"job":"ship","outcome":"failure"}');
  await expect(facts).toContainText('unknown until it is read: any a mock sets');
  await shot(page, 'not-fetched-node');

  // A remote action's step: the strip is unchanged; its interface is unknown until read.
  const step = job(page, `${CI}#lint`).locator(`[data-step="${CI}#lint/~octo-act"]`);
  await step.click();
  await expect(facts).toContainText('unknown; any mock output is accepted');

  await ship.getByRole('button', { name: 'Fetch remote workflows from api.github.com' }).click();
  await expect(callee(page).locator('.sc-scope-bar')).toContainText(
    /octo\/ship · deploy\.yml @ v1\s*\([0-9a-f]{7}\)/,
  );
  await expect(ship.locator('.sc-stub')).toHaveCount(0);
  const gone = job(page, `${CI}#gone`).locator('.sc-stub');
  await expect(gone).toContainText('octo/gone · x.yml @ v1, not read.');
  await expect(gone).toContainText('Not found, or private (sign in on a simulci server).');
  await expect(gone.getByRole('button')).toHaveCount(0);
  const flaky = job(page, `${CI}#flaky`).locator('.sc-stub');
  await expect(flaky).toContainText('GitHub did not answer.');
  await expect(footer(page)).toContainText('3 remote workflows · 1 not read · Retry');
  await shot(page, 'simulated-and-failed');

  // A reason inside the callee links to its file on GitHub, at the commit read, in a new tab.
  await job(page, `${CI}#ship>${DEPLOY}#release`).click();
  await tab(page, 'Reasons').click();
  const link = page.getByRole('tabpanel', { name: 'Reasons' }).getByRole('link', { name: /^deploy\.yml:4/ });
  await expect(link).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/octo\/ship\/blob\/[0-9a-f]{40}\/\.github\/workflows\/deploy\.yml#L4$/,
  );
  await expect(link).toHaveAttribute('target', '_blank');
  await callee(page).locator('.sc-scope-bar').click();
  await tab(page, 'Node').click();
  await expect(page.getByRole('tabpanel', { name: 'Node' })).toContainText(
    'Read at v1 today; the tag can move.',
  );
  await shot(page, 'node-tab');
  await step.click();
  await expect(page.getByRole('tabpanel', { name: 'Node' })).toContainText(
    'open: a node or docker action may set more than its action.yml declares',
  );
  await shot(page, 'action-node');

  api.heal();
  await flaky.getByRole('button', { name: `Retry octo/flaky · y.yml @ v1` }).click();
  await expect(job(page, `${CI}#flaky`).locator('.sc-stub')).toHaveCount(0);
  await expect(page.locator(`.react-flow__node-workflow[data-id="${CI}#flaky>${FLAKY}"]`)).toBeVisible();
  await expect(footer(page)).not.toContainText('not read');
});

test('an edit inside a remote callee is refused with where to make it, and its job stays selected', async ({
  page,
}) => {
  await github(page);
  await paste(page);
  await footer(page).getByRole('button', { name: 'Fetch from api.github.com' }).click();
  await expect(callee(page)).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(page.getByRole('switch', { name: /^Edit/ })).toHaveAttribute('aria-checked', 'true');
  const release = job(page, `${CI}#ship>${DEPLOY}#release`);
  // The edit runtime answers the canvas keys once it is in.
  await expect(page.getByText('loading the editor…')).toHaveCount(0);
  await release.click();
  await page.keyboard.press('Delete');
  await expect(footer(page)).toContainText('This workflow lives in octo/ship; edit it there.');
  await expect(release.locator('.sc-card')).toHaveAttribute('data-selected', /.*/);
  await shot(page, 'edit-refused');
});
