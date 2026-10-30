import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The right panel and the YAML pane in a real browser, over the bundled starter sample: the changed-files unknown
 * pinned from the Unknowns tab puts the focus in the Changed files field with the example selected, the page simulates
 * again, the row goes and the workflow it decided flips, and the author types over the example; a step output pinned
 * through the editor becomes an assumption the plan applies; a reason's line opens the YAML pane on it; and the
 * scenario column and the right panel, closed, leave a rail that opens them again by a click or by their key, in
 * both themes. The axe pass over every pane, rail and tab is in a11y.spec.ts.
 *
 * The synthesis pins a `vars.X` unknown here, but the engine reads a variable the scenario does not name as empty, so
 * `vars.X` is never unknown; `scenario.changed` is the scenario unknown the starter has.
 */

const CI = '.github/workflows/ci.yml';

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

const workflowNode = (page: Page): Locator => page.locator(`.react-flow__node-workflow[data-id="${CI}"]`);
const jobNode = (page: Page, job: string): Locator =>
  page.locator(`.react-flow__node-job[data-id="${CI}#${job}"]`);
const tab = (page: Page, name: string): Locator =>
  page.getByRole('tablist', { name: 'Plan details' }).getByRole('tab', { name: new RegExp(`^${name}`) });
const panel = (page: Page): Locator => page.getByRole('tabpanel');
const gating = (page: Page): Locator =>
  panel(page).getByRole('list', { name: 'Unknowns that decide a verdict' });

async function openStarter(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(jobNode(page, 'deploy')).toBeVisible();
}

test('the changed-files unknown pinned from the Unknowns tab focuses the field, and the workflow it decided flips', async ({
  page,
}) => {
  await openStarter(page);
  await expect(workflowNode(page)).toHaveAttribute('aria-label', /^might run CI/);

  await tab(page, 'Unknowns').click();
  const row = gating(page).getByRole('listitem').filter({ hasText: 'scenario.changed' });
  await row.getByRole('button', { name: 'Set changed files' }).click();

  // The pin's example, CI's first paths-ignore pattern, is in the field and selected, so the author types over it.
  const changed = page.getByLabel(/^Changed files/);
  await expect(changed).toBeFocused();
  await expect(changed).toHaveValue('docs/**');
  expect(await changed.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([
    0, 7,
  ]);

  // The page simulates the pinned scenario: the files are known, the row goes, and only docs changed, so CI is skipped.
  await expect(panel(page).getByText('scenario.changed')).toHaveCount(0);
  await expect(workflowNode(page)).toHaveAttribute('aria-label', /^skipped CI/);

  await page.keyboard.type('src/index.ts');
  await expect(changed).toHaveValue('src/index.ts');
  await expect(workflowNode(page)).toHaveAttribute('aria-label', /^runs CI/);
});

test('a step output pinned through the editor is an assumption the plan applies, and the step it decided runs', async ({
  page,
}) => {
  await openStarter(page);
  await page.getByLabel(/^Changed files/).fill('src/index.ts');
  await expect(workflowNode(page)).toHaveAttribute('aria-label', /^runs CI/);

  await tab(page, 'Unknowns').click();
  const row = gating(page).getByRole('listitem').filter({ hasText: 'build.detect.outputs.changed' });
  await row.getByRole('button', { name: 'Pin…' }).click();
  // The editor opens on the output the unknown is about, its value focused.
  const editor = panel(page).getByRole('form', { name: /^Pin build\.detect/ });
  await expect(editor.getByLabel('Value of changed')).toBeFocused();
  await page.keyboard.type('true');
  await editor.getByRole('button', { name: 'Apply' }).click();

  const assumptions = panel(page).getByRole('region', { name: /^Assumptions/ });
  await expect(assumptions).toContainText('build.detect · outputs.changed = true');
  await expect(assumptions).toContainText('applied at build.detect');
  await expect(gating(page).getByText('build.detect.outputs.changed')).toHaveCount(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('a'))
    .toBe(JSON.stringify([{ step: 'build.detect', outputs: { changed: 'true' } }]));
});

test('the Reasons tab shows the deciding reason of the job picked, and its line opens the YAML pane', async ({
  page,
}) => {
  await openStarter(page);
  await page.getByLabel(/^Changed files/).fill('src/index.ts');
  await expect(workflowNode(page)).toHaveAttribute('aria-label', /^runs CI/);
  await jobNode(page, 'deploy').locator('.sc-card-label').click();
  await tab(page, 'Reasons').click();
  const deciding = panel(page).locator('[data-deciding]');
  await expect(deciding).toContainText("github.event_name == 'push' || inputs.deploy");
  await expect(deciding).toContainText('decided here');

  await deciding.getByRole('button', { name: /^ci\.yml:\d+ in the YAML pane/ }).click();
  const source = page.getByRole('region', { name: 'Workflow source' });
  await expect(source.locator('.cm-editor')).toBeVisible();
  await expect(source.locator('.cm-sc-deciding')).toContainText(
    "if: github.event_name == 'push' || inputs.deploy",
  );
});

const rail = (page: Page, name: string): Locator =>
  page.getByRole('button', { name: `Open the ${name}`, exact: true });

/** The width the closed column keeps for its rail (app/SimulateView.tsx), in CSS pixels. */
const RAIL = 32;

for (const theme of ['light', 'dark'] as const) {
  test(`a closed scenario column or right panel leaves a rail that opens it by a click or by its key (${theme})`, async ({
    page,
  }) => {
    await openStarter(page);
    if (theme === 'dark') {
      await page.getByRole('button', { name: /^Theme: system;/ }).click();
      await page.getByRole('button', { name: /^Theme: light;/ }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    }
    const scenario = page.getByRole('complementary', { name: 'Scenario and outline' });
    const details = page.getByRole('complementary', { name: 'Plan details' });
    const graph = page.getByRole('region', { name: 'The run graph' });

    await page.keyboard.press('[');
    await page.keyboard.press(']');
    await expect(scenario).toBeHidden();
    await expect(details).toBeHidden();
    await expect(rail(page, 'scenario and outline')).toHaveAttribute('aria-keyshortcuts', '[');
    await expect(rail(page, 'plan details')).toHaveAttribute('aria-keyshortcuts', ']');
    // Each rail is a column as wide as RAIL, from the top of the plan to its foot, and the graph starts after it.
    const left = (await page.locator('[data-rail="left"]').boundingBox())!;
    const right = (await page.locator('[data-rail="right"]').boundingBox())!;
    const plan = (await graph.boundingBox())!;
    expect([left.width, right.width, left.x + left.width]).toEqual([RAIL, RAIL, plan.x]);
    expect(left.height).toBeGreaterThan(plan.height);

    // A click opens the scenario with the focus on its first field, where the rail was.
    await rail(page, 'scenario and outline').click();
    await expect(scenario).toBeVisible();
    await expect(rail(page, 'scenario and outline')).toHaveCount(0);
    await expect(scenario.getByRole('combobox').first()).toBeFocused();
    expect((await graph.boundingBox())!.x).toBe(320);

    // Its key, from the rail the keyboard reached, opens the panel with the focus on its open tab.
    await rail(page, 'plan details').focus();
    await page.keyboard.press(']');
    await expect(details).toBeVisible();
    await expect(details.getByRole('tab', { name: 'Reasons' })).toBeFocused();

    // From anywhere else the key opens the pane and the focus stays.
    await page.keyboard.press('[');
    await expect(rail(page, 'scenario and outline')).toBeVisible();
    await page.keyboard.press('[');
    await expect(scenario).toBeVisible();
    await expect(details.getByRole('tab', { name: 'Reasons' })).toBeFocused();
  });
}
