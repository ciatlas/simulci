import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { type Accuracy, figure } from '../app/(home)/accuracy';

/**
 * The landing in a real browser, light and dark, wide and at a phone's width: axe finds nothing; the titles are set
 * in the display face; the accuracy figure on the page is the one accuracy.json holds today, read here apart from
 * the build; the app's screenshot is the one for the theme, and loads; nothing scrolls sideways; and the page logs
 * no error.
 */

const measured = JSON.parse(
  readFileSync(new URL('../../../fixtures/routes-lab/accuracy.json', import.meta.url), 'utf8'),
) as Accuracy;

const WIDTHS = { wide: { width: 1280, height: 800 }, phone: { width: 375, height: 812 } };

for (const theme of ['light', 'dark'] as const)
  for (const [width, viewport] of Object.entries(WIDTHS))
    test(`the landing, ${theme}, ${width}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/');
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);

      const title = page.getByRole('heading', { level: 1, name: 'What your workflow does, before it runs.' });
      await expect(title).toBeVisible();
      expect(await title.evaluate((h) => getComputedStyle(h).fontFamily)).toMatch(/^"?IBM Plex Serif/);
      expect(
        await page.evaluate(() =>
          document.fonts.ready.then(() => document.fonts.check('500 1em "IBM Plex Serif"')),
        ),
      ).toBe(true);

      const { sentence, outcomes, exact, maybe, wrong } = figure(measured);
      await expect(page.getByText(sentence)).toBeVisible();
      const stats = page.locator('dl dd');
      await expect(stats).toHaveText([outcomes, exact, maybe, wrong]);
      await expect(page.getByText('Remote reusable workflows: not yet lab-verified.')).toBeVisible();

      const shot = page.locator(`img[src="/landing/app-${theme}.jpg"]`);
      await shot.scrollIntoViewIfNeeded();
      await expect(shot).toBeVisible();
      await expect
        .poll(() => shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBe(2048);
      await expect(
        page.locator(`img[src="/landing/app-${theme === 'light' ? 'dark' : 'light'}.jpg"]`),
      ).toBeHidden();

      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);

      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
        [],
      );
      expect(errors).toEqual([]);
    });
