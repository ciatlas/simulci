import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { folderWith, useOpfsFolder } from './opfs';

/**
 * The accessibility pass in a real browser (synthesis §§ 7, 10 and 11), over the bundled starter sample: axe finds
 * nothing on any view the page has, in the light theme and the dark, wide, narrow, with an input the worker refused
 * and at 200 % zoom; the plan the refusal keeps is marked stale without fading any text; the text view's ring is
 * drawn where its section cannot clip it; at 200 %, in the stacked layout and in the one where each pane scrolls
 * itself, nothing scrolls sideways and the last of each column can be scrolled to; an author who asked for less
 * motion gets no transition, no flash and an instant fit, and still hears the pin's sentence; with motion the cards a
 * pin changed flash once; the pointer on an unknown's "affects n" dims every card it does not affect; a pin from the
 * Unknowns tab leaves the focus on the next row and dims nothing; and a reason's "Show … in Unknowns" puts the focus
 * on that unknown's row.
 */

const CI = '.github/workflows/ci.yml';
/** The starter's two unknowns: the build step's output its last step's if: reads, and the changed files. */
const DETECT = `${CI}#build/steps.detect.outputs.changed`;
const CHANGED = 'scenario.changed';
const TABS = ['Reasons', 'Unknowns', 'Node', 'Problems', 'Tests'] as const;
const FORMATS = ['Test case (jobs)', 'Test case (steps)', 'Plan as text', 'Plan as Mermaid'] as const;
/** What the status line says once the changed-files pin's plan comes: only docs changed, which CI ignores. */
const PINNED = 'pinned; CI is no longer triggered';

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

const canvasOf = (page: Page): Locator => page.getByRole('region', { name: 'The run graph' });
const workflowNode = (page: Page): Locator => page.locator(`.react-flow__node-workflow[data-id="${CI}"]`);
const jobNode = (page: Page, job: string): Locator =>
  page.locator(`.react-flow__node-job[data-id="${CI}#${job}"]`);
const viewButton = (page: Page, name: 'Graph' | 'Text'): Locator =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name, exact: true });
const tab = (page: Page, name: string): Locator =>
  page.getByRole('tablist', { name: 'Plan details' }).getByRole('tab', { name: new RegExp(`^${name}`) });
const panel = (page: Page): Locator => page.getByRole('tabpanel');
const unknownRow = (page: Page, id: string): Locator => page.locator(`li[data-unknown="${id}"]`);
const source = (page: Page): Locator => page.getByRole('region', { name: 'Workflow source' });
/** The status line's sentence: its live region, without the Details button beside it. */
const statusLine = (page: Page): Locator => page.getByRole('contentinfo').locator('[aria-live]');
const caseButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Copy as test case', exact: true });
const caseDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Copy as test case' });
const transform = (page: Page): Promise<string> =>
  page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
const thePlan = (page: Page): Locator => page.getByLabel('The plan', { exact: true });

/** The empty page, the starter sample, and its first plan: Copy as test case is enabled once there is one. */
async function loadStarter(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(caseButton(page)).toBeEnabled();
}

/** The starter and its first graph laid out. */
async function openStarter(page: Page): Promise<void> {
  await loadStarter(page);
  await expect(jobNode(page, 'deploy')).toBeVisible();
}

/** `\` opens the YAML pane; the editor is a chunk of its own, so the pane is open once it has drawn. */
async function openYaml(page: Page): Promise<void> {
  await page.keyboard.press('\\');
  await expect(source(page).locator('.cm-editor')).toBeVisible();
}

/** The top bar's theme button, from the system theme (light in this browser) through light to dark. */
async function darkTheme(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Theme: system;/ }).click();
  await page.getByRole('button', { name: /^Theme: light;/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

/**
 * axe over the page as it is once every transition has run out (a colour caught halfway reads as the wrong
 * contrast). Each violation names the view, and the check is soft, so one run reports every view that fails.
 */
async function expectAxeClean(page: Page, view: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect
    .soft(
      violations.map((v) => `${view}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      `axe on ${view}`,
    )
    .toEqual([]);
}

/** The case dialog at each format, its text written, and a test case's place in the repository, before axe looks. */
async function expectCaseFormatsClean(page: Page, theme: string): Promise<void> {
  await caseButton(page).click();
  const dialog = caseDialog(page);
  for (const label of FORMATS) {
    await dialog.getByRole('radio', { name: label }).check();
    await expect(dialog.getByRole('textbox', { name: 'Text to copy' })).toHaveAttribute('aria-busy', 'false');
    if (label.startsWith('Test case'))
      await expect(dialog.getByRole('button', { name: 'Create ci.test.yml' })).toBeEnabled();
    await expectAxeClean(page, `${theme}: the Copy as test case dialog at ${label}`);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

/** The graph with the YAML pane open and each tab of the right panel in turn. */
async function expectTabsClean(page: Page, theme: string): Promise<void> {
  await openYaml(page);
  for (const name of TABS) {
    await tab(page, name).click();
    await expectAxeClean(page, `${theme}: the graph with the ${name} tab and the YAML pane`);
  }
}

test.describe('axe finds nothing', () => {
  test('on the empty state, and with the paste dialog open', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^Starter/ })).toBeVisible();
    await expectAxeClean(page, 'the empty state');
    await page.getByRole('main').getByRole('button', { name: 'Paste YAML' }).click();
    await expect(page.getByRole('dialog', { name: 'Paste a workflow or an action' })).toBeVisible();
    await expectAxeClean(page, 'the paste dialog');
  });

  test('on the starter’s graph with each tab and the YAML pane, and on the text view', async ({ page }) => {
    await openStarter(page);
    await expectTabsClean(page, 'light');
    await viewButton(page, 'Text').click();
    await expect(thePlan(page)).toBeVisible();
    await expectAxeClean(page, 'light: the text view');
  });

  test('on the Tests tab with passed, failed and invalid cases, in both themes', async ({ page }) => {
    // e2e/fixtures/tests, opened as a folder: tests.spec.ts checks what the tab says of it.
    const root = join(import.meta.dirname, 'fixtures/tests');
    const files: Record<string, number[]> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else files[relative(root, path)] = Array.from(readFileSync(path));
      }
    };
    walk(root);
    await useOpfsFolder(page);
    await page.goto('/');
    await folderWith(page, files);
    await page
      .getByRole('navigation', { name: 'Source' })
      .getByRole('button', { name: 'Open folder' })
      .click();
    await tab(page, 'Tests').click();
    await expect(page.locator('[data-panel="tests"]').getByRole('status')).toHaveText(/ran as CI on/);
    await expectAxeClean(page, 'light: the Tests tab');
    await darkTheme(page);
    await expectAxeClean(page, 'dark: the Tests tab');
  });

  test('in the Copy as test case dialog at each format', async ({ page }) => {
    await openStarter(page);
    await expectCaseFormatsClean(page, 'light');
  });

  test('with the pin editor open in the Unknowns tab', async ({ page }) => {
    await openStarter(page);
    await tab(page, 'Unknowns').click();
    await unknownRow(page, DETECT).getByRole('button', { name: 'Pin…' }).click();
    await expect(panel(page).getByRole('form', { name: /^Pin build\.detect/ })).toBeVisible();
    await expectAxeClean(page, 'light: the Unknowns tab with the pin editor open');
  });

  test('with what a pin changed open in Details, in both themes', async ({ page }) => {
    await openStarter(page);
    await pinChangedFiles(page);
    await expect(statusLine(page)).toHaveText(PINNED);
    await page.getByRole('contentinfo').getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('dialog', { name: 'What changed' })).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'What changed' }).getByRole('button').first(),
    ).toBeFocused();
    await expectAxeClean(page, 'light: Details open');
    await darkTheme(page);
    await page.getByRole('contentinfo').getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('dialog', { name: 'What changed' })).toBeVisible();
    await expectAxeClean(page, 'dark: Details open');
    // Escape closes it, as the platform's popover does.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'What changed' })).toBeHidden();
  });

  test('in the dark theme, over the graph, the panels and the case dialog', async ({ page }) => {
    await openStarter(page);
    await darkTheme(page);
    await expectTabsClean(page, 'dark');
    await expectCaseFormatsClean(page, 'dark');
  });

  test('in the narrow layout, where the text view is the only one', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await loadStarter(page);
    await expect(viewButton(page, 'Graph')).toBeDisabled();
    await expect(viewButton(page, 'Text')).toHaveAttribute('aria-pressed', 'true');
    await expect(thePlan(page)).toBeVisible();
    await expectAxeClean(page, 'narrow: the text view and the panel under it');
  });
});

/**
 * An input the worker refuses: a commit SHA that is not 7 to 40 lowercase hex digits, under Advanced. The field says
 * so, and the plan on screen is the last good one, stale (synthesis § 10).
 */
async function refuseInput(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Advanced/ }).click();
  const sha = page.getByRole('textbox', { name: /^Commit SHA/ });
  await sha.fill('not-a-sha');
  await expect(sha).toHaveAttribute('aria-invalid', 'true');
}

/** How far each element's text is faded: the product of the opacities from it up to the page; 1 is not at all. */
const fadedBy = (targets: Locator): Promise<number[]> =>
  targets.evaluateAll((els) =>
    els.map((el) => {
      let kept = 1;
      for (let at: Element | null = el; at; at = at.parentElement)
        kept *= Number(getComputedStyle(at).opacity);
      return kept;
    }),
  );

interface Rule {
  style: string;
  width: string;
  color: string;
}

/** The rule a stale canvas draws inside its edge, or undefined while the canvas draws none. */
const staleRule = (page: Page): Promise<Rule | undefined> =>
  page.locator('.sc-canvas').evaluate((el) => {
    const rule = getComputedStyle(el, '::after');
    if (rule.content === 'none') return undefined;
    return { style: rule.borderTopStyle, width: rule.borderTopWidth, color: rule.borderTopColor };
  });

for (const theme of ['light', 'dark'] as const)
  test(`with an input the worker refused, in the ${theme} theme, the last plan is marked stale with every word at full contrast, and axe finds nothing`, async ({
    page,
  }) => {
    await openStarter(page);
    if (theme === 'dark') await darkTheme(page);
    expect(await staleRule(page)).toBeUndefined();
    await refuseInput(page);

    // The graph: a dashed rule inside the canvas and faded edges say stale; the cards keep their colours.
    await expect(page.locator('.sc-canvas')).toHaveAttribute('data-stale', 'inputs');
    const rule = await staleRule(page);
    expect(rule).toMatchObject({ style: 'dashed', width: '2px' });
    await expect
      .poll(() =>
        page.locator('.sc-canvas .react-flow__edges').evaluate((el) => getComputedStyle(el).opacity),
      )
      .toBe('0.4');
    expect(new Set(await fadedBy(canvasOf(page).locator('.sc-card, .sc-scope')))).toEqual(new Set([1]));
    await expectAxeClean(page, `${theme}: the graph with an input refused`);

    // The text view: a dashed rule down its left edge in the same colour, and its text not faded.
    await viewButton(page, 'Text').click();
    await expect(thePlan(page)).toBeVisible();
    const edge = await thePlan(page).evaluate((el): Rule => {
      const style = getComputedStyle(el);
      return { style: style.borderLeftStyle, width: style.borderLeftWidth, color: style.borderLeftColor };
    });
    expect(edge).toEqual(rule);
    expect(await fadedBy(thePlan(page))).toEqual([1]);
    await expectAxeClean(page, `${theme}: the text view with an input refused`);
  });

test('the text view’s plan, a tab stop that fills its section, rings inside its own edge, where the section cannot clip it', async ({
  page,
}) => {
  await openStarter(page);
  await viewButton(page, 'Text').click();
  const plan = thePlan(page);
  await expect(plan).toBeVisible();
  // From the section around it (where the focus goes when a pane closes), the keyboard's way in is a Tab.
  await page.locator('section[data-plan]').focus();
  await page.keyboard.press('Tab');
  await expect(plan).toBeFocused();
  const ring = await plan.evaluate((el: HTMLElement) => {
    const style = getComputedStyle(el);
    return {
      shown: el.matches(':focus-visible') && style.outlineStyle === 'solid',
      fills: el.offsetWidth === el.parentElement?.clientWidth,
      width: parseFloat(style.outlineWidth),
      offset: parseFloat(style.outlineOffset),
    };
  });
  expect(ring).toMatchObject({ shown: true, fills: true, width: 2 });
  // The ring's outer edge is on the plan's own edge or inside it, so none of it lies where the section clips.
  expect(ring.offset).toBeLessThan(0);
  expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
});

/**
 * The element scrolled into view to its nearest edge, as a Tab or a find would, is then wholly in the viewport, and
 * every box that had to scroll for it is one the author can scroll too: none of them hides its overflow. The browser
 * scrolls it, not Playwright, whose scroll rounds an edge at a fraction of a pixel and leaves that fraction out.
 */
async function expectScrollsIntoView(target: Locator, what: string): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await expect(target, `${what} in the viewport`).toBeInViewport({ ratio: 1 });
  const clipped = await target.evaluate((el) => {
    const hides = (v: string): boolean => v === 'hidden' || v === 'clip';
    const boxes: string[] = [];
    for (let box = el.parentElement; box; box = box.parentElement) {
      const style = getComputedStyle(box);
      if ((box.scrollTop > 0 && hides(style.overflowY)) || (box.scrollLeft > 0 && hides(style.overflowX)))
        boxes.push(`${box.tagName.toLowerCase()}.${box.className}`);
    }
    return boxes;
  });
  expect(clipped, `${what} scrolled inside a box the author cannot scroll`).toEqual([]);
}

/**
 * Nothing is wider than the box it sits in: the page than the window, nor `<main>` (which scrolls the stacked
 * columns), any pane or the open tab's panel (which scroll themselves when the columns sit side by side) than itself.
 * Each overflow is named, so a failure says where.
 */
async function expectNoSidewaysScroll(page: Page, view: string): Promise<void> {
  const overflows = await page.evaluate(() => {
    const wider = (el: Element): number => el.scrollWidth - el.clientWidth;
    const boxes: [string, number][] = [['page', document.documentElement.scrollWidth - window.innerWidth]];
    for (const main of document.querySelectorAll('main')) boxes.push(['main', wider(main)]);
    for (const pane of document.querySelectorAll('[data-pane]'))
      boxes.push([`the ${pane.getAttribute('data-pane')} pane`, wider(pane)]);
    for (const open of document.querySelectorAll('[role="tabpanel"]:not([hidden])'))
      boxes.push([`the ${open.getAttribute('data-panel')} tab's panel`, wider(open)]);
    return boxes.filter(([, by]) => by !== 0);
  });
  expect(overflows, `sideways scroll on ${view}`).toEqual([]);
}

/**
 * 200 % zoom in two windows: a 1280 × 800 one is the stacked layout, where `<main>` scrolls everything; a 1920 × 1080
 * one is the md layout, where `<main>` hides its overflow and each pane scrolls itself.
 */
const ZOOMED = [
  { window: '1280 × 800', viewport: { width: 640, height: 400 }, layout: 'the stacked layout' },
  { window: '1920 × 1080', viewport: { width: 960, height: 540 }, layout: 'panes that scroll themselves' },
] as const;

for (const zoomed of ZOOMED)
  test.describe(`at 200 % zoom in a ${zoomed.window} window (${zoomed.viewport.width} × ${zoomed.viewport.height} CSS pixels, ${zoomed.layout})`, () => {
    test.use({ viewport: zoomed.viewport, deviceScaleFactor: 2 });
    const at = `200 % at ${zoomed.viewport.width}`;

    test('axe finds nothing on the empty state, nor on the starter with its panels', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: /^Starter/ })).toBeVisible();
      await expectAxeClean(page, `${at}: the empty state`);
      await page.getByRole('button', { name: /^Starter/ }).click();
      await expect(caseButton(page)).toBeEnabled();
      await openYaml(page);
      for (const name of TABS) {
        await tab(page, name).click();
        await expectAxeClean(page, `${at}: the text view with the ${name} tab and the YAML pane`);
      }
    });

    test('nothing scrolls sideways, and the scenario’s last field, the last unknown and the last YAML line scroll into view', async ({
      page,
    }) => {
      await expectZoomedScrolls(page);
    });
  });

/** The 200 % scroll checks, from the empty state through the starter's Unknowns tab to the YAML pane's last line. */
async function expectZoomedScrolls(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Starter/ })).toBeVisible();
  await expectNoSidewaysScroll(page, 'the empty state');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(caseButton(page)).toBeEnabled();
  // The status line's sentence takes a line the empty status bar did not: the panes are their height once it shows.
  await expect(statusLine(page)).toHaveText(/ triggered; /);
  await expectNoSidewaysScroll(page, 'the starter');

  const fields = page.getByRole('form', { name: 'Scenario' }).locator('[data-field]');
  await expectScrollsIntoView(fields.last(), 'the scenario’s last field');

  await tab(page, 'Unknowns').click();
  await expect(unknownRow(page, CHANGED)).toBeAttached();
  await expectScrollsIntoView(panel(page).locator('li[data-unknown]').last(), 'the Unknowns tab’s last row');

  await openYaml(page);
  // The editor draws only the lines near its view: the wheel over it brings the end of the file.
  const scroller = source(page).locator('.cm-scroller');
  await scroller.hover();
  await page.mouse.wheel(0, 10_000);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
  // The last line by its number: the line itself is as wide as the widest, wider than the pane at this size.
  const last = source(page).locator('.cm-lineNumbers .cm-gutterElement').last();
  await expectScrollsIntoView(last, 'the YAML pane’s last line');
  await expectNoSidewaysScroll(page, 'the starter with the Unknowns tab and the YAML pane');
}

/**
 * From now on, records each transition and CSS animation that starts inside a card, and each `data-flash` set on
 * one: under reduced motion both stay empty, however briefly anything would have run.
 */
async function recordMotion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { motion: string[] };
    w.motion = [];
    const card = (target: EventTarget | null): string | null | undefined =>
      (target as Element | null)?.closest?.('.react-flow__node')?.getAttribute('data-id');
    const note = (e: Event): void => {
      const id = card(e.target);
      if (id === undefined) return;
      const name = e instanceof AnimationEvent ? e.animationName : (e as TransitionEvent).propertyName;
      w.motion.push(`${id}: ${e.type} ${name}`);
    };
    document.addEventListener('transitionrun', note, true);
    document.addEventListener('animationstart', note, true);
    new MutationObserver((records) => {
      for (const r of records) {
        const flash = (r.target as Element).getAttribute('data-flash');
        if (flash !== null) w.motion.push(`${card(r.target)}: data-flash ${flash}`);
      }
    }).observe(document.body, { subtree: true, attributeFilter: ['data-flash'] });
  });
}

const recorded = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { motion: string[] }).motion);

/** The animations and transitions running on the cards now, by node id. */
const cardAnimations = (page: Page): Promise<string[]> =>
  canvasOf(page)
    .locator('.react-flow__node')
    .evaluateAll((nodes) =>
      nodes.flatMap((n) =>
        n.getAnimations({ subtree: true }).map((a) => `${n.getAttribute('data-id')}: ${a.constructor.name}`),
      ),
    );

/** Pins the changed files from the Unknowns tab, as the row's "Set changed files" does. */
async function pinChangedFiles(page: Page): Promise<void> {
  await tab(page, 'Unknowns').click();
  await unknownRow(page, CHANGED).getByRole('button', { name: 'Set changed files' }).click();
  await expect(workflowNode(page)).toHaveAttribute('aria-label', /^skipped CI/);
}

test('with less motion asked for, a selection and a pin move no card, f fits at once, and the pin is still said', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openStarter(page);
  const fitted = await transform(page);
  await recordMotion(page);

  // Off preview's path, deploy fades: its text and border change colour, which would otherwise transition.
  await jobNode(page, 'preview').locator('.sc-card-label').click();
  await expect(jobNode(page, 'deploy').locator('.sc-card')).toHaveAttribute('data-path', 'off');
  expect(await cardAnimations(page)).toEqual([]);
  expect(await recorded(page)).toEqual([]);

  // The plan's sentence comes half a second after the plan, after the first fit: the line it fills was held for it,
  // so the canvas `f` fits is the one fitted at first.
  await expect(statusLine(page)).not.toHaveText('');
  await page.getByRole('button', { name: 'Zoom In' }).click();
  const zoomed = await transform(page);
  expect(zoomed).not.toBe(fitted);
  // `f` from the page itself, where nothing on the way takes the key.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('f');
  await expect.poll(() => transform(page)).not.toBe(zoomed);
  const at = await transform(page);
  await page.waitForTimeout(400);
  expect(await transform(page)).toBe(at);
  expect(at).toBe(fitted);

  await pinChangedFiles(page);
  await expect(statusLine(page)).toHaveText(PINNED);
  expect(await cardAnimations(page)).toEqual([]);
  await expect(page.locator('[data-flash]')).toHaveCount(0);
  expect(await recorded(page)).toEqual([]);
});

test('with motion, the workflow a pin changed flashes once and the status line says what the pin did', async ({
  page,
}) => {
  await openStarter(page);
  await recordMotion(page);
  await pinChangedFiles(page);

  // The flash's attribute and the keyframes it names are running on the CI workflow's card together.
  const scope = workflowNode(page).locator('.sc-scope');
  await expect
    .poll(() =>
      scope.evaluate((el) => {
        const flash = el.getAttribute('data-flash');
        const running = el
          .getAnimations()
          .filter((a) => a instanceof CSSAnimation && a.playState === 'running')
          .map((a) => (a as CSSAnimation).animationName);
        return flash !== null && running.includes(`sc-flash-${flash}`);
      }),
    )
    .toBe(true);
  await expect(statusLine(page)).toHaveText(PINNED);
  // Once: the attribute goes after the pulse, and it was set on that card alone.
  await expect(scope).not.toHaveAttribute('data-flash');
  expect((await recorded(page)).filter((m) => m.includes('data-flash'))).toEqual([
    expect.stringMatching(/^\.github\/workflows\/ci\.yml: data-flash [ab]$/),
  ]);
});

/** Each card's `data-path` by node id: `on`, `off`, or null off any path. */
const cardPaths = (page: Page): Promise<Record<string, string | null>> =>
  canvasOf(page)
    .locator('.react-flow__node')
    .evaluateAll((nodes) =>
      Object.fromEntries(
        nodes.map((n) => [
          n.getAttribute('data-id') ?? '',
          n.querySelector(':scope > .sc-card, :scope > .sc-scope')?.getAttribute('data-path') ?? null,
        ]),
      ),
    );

test('the pointer on an unknown’s affects n dims every card it does not affect, and leaving restores them', async ({
  page,
}) => {
  await openStarter(page);
  await tab(page, 'Unknowns').click();
  const before = await cardPaths(page);
  // The output decides the build's last step: its job card and the workflow around it stay lit.
  const lit = new Set([CI, `${CI}#build`]);
  const dimmed = Object.fromEntries(Object.keys(before).map((id) => [id, lit.has(id) ? 'on' : 'off']));
  expect(Object.keys(before)).toEqual(expect.arrayContaining([...lit, `${CI}#deploy`]));

  await unknownRow(page, DETECT)
    .getByRole('button', { name: /^affects 1: / })
    .hover();
  await expect.poll(() => cardPaths(page)).toEqual(dimmed);
  await expect(canvasOf(page).locator('path.sc-edge:not([data-path="off"])')).toHaveCount(0);

  await page.mouse.move(0, 0);
  await expect.poll(() => cardPaths(page)).toEqual(before);
});

test('a pin from the Unknowns tab puts the focus on the next row, not on its affects n, and dims no card', async ({
  page,
}) => {
  await openStarter(page);
  await tab(page, 'Unknowns').click();
  // The workflow is the selection, and its path dims no card: any card dimmed later is an unknown's doing.
  expect(Object.values(await cardPaths(page))).not.toContain('off');

  await unknownRow(page, DETECT).getByRole('button', { name: 'Pin…' }).click();
  const value = panel(page)
    .getByRole('form', { name: /^Pin build\.detect/ })
    .getByLabel('Value of changed');
  await expect(value).toBeFocused();
  // The pointer goes off the tab, so only the focus could light an unknown; the keys apply the pin.
  await page.mouse.move(0, 0);
  await page.keyboard.type('true');
  await page.keyboard.press('Enter');

  await expect(unknownRow(page, DETECT)).toHaveCount(0);
  const next = unknownRow(page, CHANGED);
  await expect(next).toBeFocused();
  await expect(next).toBeInViewport();
  // Once the pin is said and every transition a dimmed card would play has run out, still no card is dimmed.
  await expect(statusLine(page)).toHaveText(/^pinned; /);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  expect(Object.values(await cardPaths(page))).not.toContain('off');
});

test('Show … in Unknowns in a reason puts the focus on that unknown’s row, in view', async ({ page }) => {
  await openStarter(page);
  await tab(page, 'Unknowns').click();
  // The count selects what the output decides: the build step whose if: reads it.
  await unknownRow(page, DETECT)
    .getByRole('button', { name: /^affects 1: ~npm-run-build;/ })
    .click();
  await tab(page, 'Reasons').click();

  await panel(page).getByRole('button', { name: 'Show build.detect.outputs.changed in Unknowns' }).click();
  await expect(tab(page, 'Unknowns')).toHaveAttribute('aria-selected', 'true');
  const row = unknownRow(page, DETECT);
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
});

test('by the keys alone, edit mode adds a job, sets what it needs and deletes a step, and axe finds nothing in what opens', async ({
  page,
}) => {
  await openStarter(page);
  await page.keyboard.press('e');
  // The canvas offers its gestures once the edit runtime is in.
  await expect(page.getByRole('button', { name: '+ Add job' })).toBeAttached();
  await jobNode(page, 'build').focus();
  await expect(jobNode(page, 'build').locator('.sc-card')).toHaveAttribute('data-selected', 'self');

  await page.keyboard.press('a');
  const add = page.getByRole('dialog', { name: 'Add a job after build' });
  await expect(add.getByRole('textbox', { name: 'Id' })).toBeFocused();
  await expectAxeClean(page, 'Add job');
  await page.keyboard.type('lint');
  await page.keyboard.press('Enter');
  await expect(add).toHaveCount(0);
  await expect(jobNode(page, 'lint')).toBeFocused();

  await page.keyboard.press('n');
  const needs = page.getByRole('dialog', { name: 'What lint needs' });
  await expect(needs.getByRole('combobox', { name: 'Add a need to lint' })).toBeFocused();
  await expectAxeClean(page, 'What it needs');
  await page.keyboard.type('test');
  await page.keyboard.press('Enter');
  await expect(jobNode(page, 'lint')).toHaveAttribute('aria-label', /needs build, test$/, { timeout: 3000 });
  await page.keyboard.press('Escape');
  await expect(needs).toHaveCount(0);
  await expect(jobNode(page, 'lint')).toBeFocused();

  // Delete asks about a job others need; Escape keeps it.
  await jobNode(page, 'build').focus();
  await page.keyboard.press('Delete');
  const ask = page.getByRole('dialog', { name: 'Remove job build?' });
  await expect(ask.getByRole('button', { name: 'Remove build' })).toBeFocused();
  await expectAxeClean(page, 'the question before removing a job');
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(jobNode(page, 'build')).toBeVisible();

  // A step: Space opens build's list, Enter goes to its first step; s opens the palette there, Delete removes it.
  await expect(jobNode(page, 'build')).toBeFocused();
  await page.keyboard.press(' ');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/sel=build\.%231/);
  await page.keyboard.press('s');
  const palette = page.getByRole('dialog', { name: 'Add a step to build' });
  await expect(palette.getByRole('combobox', { name: 'Steps to add' })).toBeFocused();
  await expectAxeClean(page, 'the palette');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  const labels = jobNode(page, 'build').locator('.sc-list-label');
  await expect(labels).toHaveText(['actions/checkout@v4', 'detect', '~npm-run-build']);
  await page.keyboard.press('Delete');
  await expect(labels).toHaveText(['detect', '~npm-run-build'], { timeout: 3000 });
  await expect(
    page.getByRole('status').filter({ hasText: 'Removed step 1 of build (actions/checkout@v4)' }),
  ).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(labels).toHaveText(['actions/checkout@v4', 'detect', '~npm-run-build'], { timeout: 3000 });
});
