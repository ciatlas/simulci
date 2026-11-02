import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { type Accuracy, figure, remoteFigure } from '../app/(home)/accuracy';

/**
 * The accuracy page in a real browser, light and dark: axe finds nothing in the page's own content (the docs layout
 * around it is Fumadocs', whose table of contents sits outside a landmark); both figures are the ones accuracy.json
 * holds today, read here apart from the build; and the landing's "How the lab measures it" leads to it.
 */

const measured = JSON.parse(
  readFileSync(new URL('../../../fixtures/routes-lab/accuracy.json', import.meta.url), 'utf8'),
) as Accuracy;

for (const theme of ['light', 'dark'] as const)
  test(`the accuracy page, ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    await page.getByRole('link', { name: 'How the lab measures it' }).click();
    await expect(page).toHaveURL(/\/docs\/accuracy$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Accuracy' })).toBeVisible();

    await expect(page.getByText(figure(measured).sentence)).toBeVisible();
    await expect(page.getByText(remoteFigure(measured).sentence)).toBeVisible();
    const kinds = page.locator('table').nth(1).locator('tbody tr');
    await expect(kinds).toHaveCount(Object.keys(measured.compared).length);
    for (const [i, [kind, n]] of Object.entries(measured.compared).entries())
      await expect(kinds.nth(i).locator('td')).toContainText([
        kind,
        n.toLocaleString('en-US'),
        measured.remote.compared[kind]!.toLocaleString('en-US'),
      ]);

    const { violations } = await new AxeBuilder({ page }).include('#nd-page').analyze();
    expect(violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
