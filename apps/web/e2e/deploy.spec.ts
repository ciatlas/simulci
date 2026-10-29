import { expect, type Page, type Response, test } from '@playwright/test';
import { headerRules, headersFor, VERCEL } from '../headers.ts';

/**
 * The deployment smoke: the app as a host serves it, the deployment BASE_URL names (the deployment smoke workflow
 * runs it for each Vercel deployment) or else the local preview, which serves Vercel's headers and rewrites too
 * (vercel-headers.ts). Every response the page loads carries the headers the header table (headers.ts) gives its path
 * in Vercel's mode: the CSP on all of them, the worker scripts included, so it binds the workers too; hashed assets
 * cached for good, everything else revalidated. A deep link is the page and a missing chunk a 404, never the page
 * under an asset's name. The starter sample's plan renders with both workers running, the YAML pane's chunk and the
 * fonts load, and neither the page nor a worker reports a CSP violation or an error.
 */

/** The response headers the table sets, in the lower case Playwright reports them in. */
const SET_BY_TABLE = new Set(
  headerRules(VERCEL).flatMap((rule) => rule.headers.map((h) => h.key.toLowerCase())),
);
/** Vercel Authentication answers a redirect to vercel.com's login (or a 401), never the app. */
const PROTECTED =
  'Vercel Authentication protects the deployment: set Deployment Protection to none for the project, or give the smoke VERCEL_AUTOMATION_BYPASS_SECRET';

/** What the table says the response's path gets and the host did not send, one line per header. */
function headerProblems(response: Response): string[] {
  const { pathname } = new URL(response.url());
  const served = response.headers();
  const expected = headersFor(pathname, VERCEL);
  const problems: string[] = [];
  for (const key of SET_BY_TABLE) {
    const want = expected.get(key);
    if (served[key] !== want)
      problems.push(`${pathname}: ${key} is ${served[key] ?? 'absent'}, not ${want ?? 'absent'}`);
  }
  return problems;
}

/**
 * Every same-origin response's header problems and every error. The page's console carries the workers' too, and so
 * what the CSP refuses inside a worker (worker/csp.ts).
 */
function watch(page: Page, origin: string): string[] {
  const problems: string[] = [];
  page.on('response', (r) => {
    if (r.url().startsWith(origin)) problems.push(...headerProblems(r));
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  return problems;
}

/** The violations the page's document reported, recorded from before its first script. */
async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}

test('the starter plan renders under the CSP, both workers, the YAML pane and the fonts included', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const problems = watch(page, origin);
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(
        `${e.effectiveDirective} refused ${e.blockedURI || 'an inline source'} (${e.sourceFile}:${e.lineNumber})`,
      ),
    );
  });

  const response = await page.goto('/');
  expect(new URL(page.url()).origin, PROTECTED).toBe(origin);
  expect(response?.status(), PROTECTED).toBe(200);
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(page.locator('.react-flow__node-job').first()).toBeVisible();
  const workers = page.workers().map((w) => new URL(w.url()).pathname.replace(/-[\w-]+\.js$/, ''));
  expect(workers.toSorted()).toEqual(['/assets/engine.worker', '/assets/layout.worker']);

  await page.keyboard.press('\\');
  await expect(page.getByRole('region', { name: 'Workflow source' }).locator('.cm-editor')).toBeVisible();
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map((f) => `${f.family} ${f.status}`).filter((f) => !f.endsWith('unloaded'));
  });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.filter((f) => !f.endsWith(' loaded'))).toEqual([]);

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test('a deep link is the page, and a missing chunk is a 404 rather than the page under its name', async ({
  request,
}) => {
  const deep = await request.get('/some/deep/link?wf=ci.yml', { maxRedirects: 0 });
  expect(deep.status(), PROTECTED).toBe(200);
  expect(deep.headers()['content-type']).toMatch(/^text\/html/);
  const missing = await request.get('/assets/index-missing.js', { maxRedirects: 0 });
  expect(missing.status()).toBe(404);
});
