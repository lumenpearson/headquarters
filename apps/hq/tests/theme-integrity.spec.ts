import { expect, test, type Page } from '@playwright/test';

/**
 * R14: switching theme and style without breaking the interface.
 *
 * "Without breaking" is not a feeling, so this suite fixes what it means and
 * checks it for every declared value rather than for the one pair a spot check
 * would reach. Four claims, each of which has failed somewhere in this
 * repository before:
 *
 * 1. The page does not scroll. R26 is the property the whole layout is built
 *    around, and a theme that changes a font metric can break it (C26 found 55
 *    scrolling route/size pairs out of 64).
 * 2. The workspace keeps the box it had. A theme changing the shell's geometry
 *    means the layout resolver is being handed different room, which is how a
 *    tile silently moves to its own screen.
 * 3. Text stays legible against what is behind it. Two of the eight themes are
 *    light, and a token that a light theme forgot to redefine is exactly the
 *    defect nobody sees until a light theme is chosen on set.
 * 4. Nothing overflows its panel.
 */
const themes = [
  'terminal-red',
  'terminal-green',
  'amber-crt',
  'cold-cyan',
  'monochrome',
  'high-contrast-dark',
  'high-contrast-light',
  'light-operations',
] as const;

const accents = ['orange', 'green', 'amber', 'cyan', 'red'] as const;
const styles = ['strict-terminal', 'dense-mainframe', 'tactical-grid', 'minimal-terminal'] as const;

const viewport = { width: 1920, height: 1080 } as const;

async function seed(page: Page, values: Record<string, unknown>): Promise<void> {
  await page.addInitScript((stored: Record<string, unknown>) => {
    window.localStorage.setItem(
      'gremuchaya-hq:operations:v3',
      JSON.stringify({
        version: 5,
        ui: {},
        production: {},
        personalization: {
          published: { revision: 0, values: {} },
          draft: {
            baseRevision: 0,
            values: stored,
            changedIds: Object.keys(stored),
            history: [],
          },
          history: [],
          undoStack: [],
          redoStack: [],
        },
      }),
    );
  }, values);
}

interface ShellMeasurement {
  readonly workspace: { readonly width: number; readonly height: number };
  readonly pageScrolls: boolean;
  readonly contrast: number;
  readonly overflowing: number;
}

async function measure(page: Page): Promise<ShellMeasurement> {
  return page.evaluate(() => {
    const workspaceElement = document.querySelector('.ops-workspace');
    if (workspaceElement === null) throw new Error('the workspace is not laid out');
    const workspace = workspaceElement.getBoundingClientRect();

    const luminance = (colour: string): number => {
      const parts = colour.match(/[\d.]+/gu)?.map(Number) ?? [];
      const [red = 0, green = 0, blue = 0] = parts;
      const channel = (value: number): number => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };

    /** The shell's own text against the background it is actually drawn on. */
    const shell = document.querySelector('.ops-shell');
    let contrast = 0;
    if (shell !== null) {
      const style = window.getComputedStyle(shell);
      const front = luminance(style.color);
      // The shell paints a gradient over a flat colour; the flat colour is the
      // last stop and the one a glyph sits on.
      const backElement = document.querySelector('.ops-panel') ?? shell;
      const back = luminance(window.getComputedStyle(backElement).backgroundColor);
      const lighter = Math.max(front, back);
      const darker = Math.min(front, back);
      contrast = (lighter + 0.05) / (darker + 0.05);
    }

    const overflowing = Array.from(document.querySelectorAll('.ops-panel__body')).filter(
      (body) => body.scrollWidth > body.clientWidth + 1,
    ).length;

    return {
      workspace: { width: Math.round(workspace.width), height: Math.round(workspace.height) },
      pageScrolls:
        document.documentElement.scrollHeight > window.innerHeight + 1 ||
        document.documentElement.scrollWidth > window.innerWidth + 1,
      contrast,
      overflowing,
    };
  });
}

test('R14: every declared theme leaves the interface bounded, legible and unmoved', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize(viewport);
  await page.goto('/overview');
  await expect(page.locator('.ops-panel').first()).toBeVisible();
  const reference = await measure(page);

  for (const theme of themes) {
    await seed(page, { 'themes.id': theme });
    await page.reload();
    await expect(page.locator('.ops-shell')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.ops-panel').first()).toBeVisible();
    const measured = await measure(page);

    expect(measured.pageScrolls, `${theme} scrolls the page`).toBe(false);
    expect(measured.workspace, `${theme} changed the workspace box`).toEqual(reference.workspace);
    // 3:1 is the floor for large text in WCAG terms. Two of these themes are
    // light, and a token a light theme forgot to redefine shows up here and
    // nowhere else until someone picks it on set.
    expect(measured.contrast, `${theme} draws text on too close a background`).toBeGreaterThan(3);
    expect(measured.overflowing, `${theme} overflows ${measured.overflowing} panels`).toBe(0);
  }
});

test('R14: every accent and every style leaves the interface bounded and unmoved', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize(viewport);
  await page.goto('/overview');
  await expect(page.locator('.ops-panel').first()).toBeVisible();
  const reference = await measure(page);

  for (const accent of accents) {
    await seed(page, { 'colors.accent': accent });
    await page.reload();
    await expect(page.locator('.ops-shell')).toHaveAttribute('data-accent', accent);
    const measured = await measure(page);
    expect(measured.pageScrolls, `accent ${accent} scrolls the page`).toBe(false);
    expect(measured.workspace, `accent ${accent} changed the workspace box`).toEqual(
      reference.workspace,
    );
  }

  for (const style of styles) {
    await seed(page, { 'styles.mode': style });
    await page.reload();
    await expect(page.locator('.ops-shell')).toHaveAttribute('data-style-mode', style);
    await expect(page.locator('.ops-panel').first()).toBeVisible();
    const measured = await measure(page);
    expect(measured.pageScrolls, `style ${style} scrolls the page`).toBe(false);
    expect(measured.overflowing, `style ${style} overflows a panel`).toBe(0);
  }
});
