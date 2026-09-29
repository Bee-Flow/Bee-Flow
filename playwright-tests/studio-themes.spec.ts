/**
 * Cross-theme QA of the redesigned builder — the one thing 400 unit tests
 * cannot tell you: whether it LOOKS right.
 *
 * The redesign put a family colour on every card (`--type-*`), an 18%
 * `color-mix` tile tint behind every icon and a 22% status ring around every
 * running node. Those percentages were validated against ONE reference
 * surface (see the note at agent-hub/src/index.css:79-82), and the app ships
 * EIGHT themes whose `--bg-card` and `--border-default` differ sharply:
 * light, glass, high-contrast, paper, sepia, dark, glass-dark, obsidian.
 * A tint that reads on `light` can vanish on `paper` and glare on `obsidian`,
 * and nothing in the unit suite would notice.
 *
 * So this spec shoots the three views that carry the colour work — 1a (the
 * canvas), 1d (the canvas with a run banner) and 1h (the step drawer) — in
 * every theme, into `playwright-tests/artifacts/<theme>/`, for a human to
 * flip through. It also asserts the two things a machine CAN judge:
 *   - every `--type-*` / `--kind-*` token resolves to a real colour in every
 *     theme (a token that only exists in `:root` is invisible in the others);
 *   - no canvas surface paints itself with `--accent`, which nodeTypeColors
 *     bans because it defaults to a grey that disappeared on the light themes
 *     (flow/nodeTypeColors.js:25-26).
 *
 * HOW TO RUN — headed, paced, one worker, so it can be watched:
 *
 *   cd playwright-tests
 *   npx playwright test studio-themes.spec.ts --headed --workers=1
 *   # SLOW_MO defaults to 300ms for a headed run; SLOW_MO=0 for full speed.
 *
 * It needs the local stack up (BASE_URL, default http://localhost:5176), a
 * logged-in account (global-setup.ts) and AT LEAST ONE saved routine with at
 * least one step. Point it at a specific one with ROUTINE_ID=<id>; otherwise
 * it opens the first routine in the Studio list.
 *
 * NOTE FOR WHOEVER ADDS IT TO CI: don't. It is a LOOKING tool — the artifacts
 * are the output and a person is the assertion. The two automated checks below
 * are cheap enough to keep, but the value is the folder of PNGs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import { passPostLoginGates } from './support/gates';

/**
 * Every theme the `--type-*` block spans. The four "light family" themes are
 * NOT interchangeable: high-contrast, paper and sepia each move --bg-card and
 * --border-default far enough that a colour-mix validated on `light` is a
 * fresh question on all three.
 */
const THEMES = [
  'light',
  'glass',
  'high-contrast',
  'paper',
  'sepia',
  'dark',
  'glass-dark',
  'obsidian',
] as const;

/** The step-family and Studio-kind tokens the redesign introduced. */
const FAMILY_TOKENS = [
  '--type-trigger', '--type-ai', '--type-app', '--type-branch', '--type-loop',
  '--type-data', '--type-pause', '--type-guard', '--type-end',
  '--kind-skill', '--kind-kb', '--kind-app', '--kind-web', '--kind-meet',
];

const ARTIFACTS = path.join(__dirname, 'artifacts');
// Studio's own address, not the admin dashboard's. The default used to read
// '/app/admin/studio/automations', which pageFromPath matches on its /app/admin/
// branch — so with BUILDER_PATH unset this spec screenshotted Admin and called
// it Studio.
const STUDIO_LIST = process.env.BUILDER_PATH || '/app/studio/automations';
const ROUTINE_ID = process.env.ROUTINE_ID || '';

/** localStorage key ThemeContext bootstraps from before React paints. */
const BOOTSTRAP_KEY = 'beeflow:theme:bootstrap';

/**
 * Force a theme for the whole page life. Two halves, both needed: the
 * localStorage seed makes the pre-React bootstrap script paint the first frame
 * correctly, and the attribute write covers the case where the account's
 * server-side theme lands afterwards and would otherwise win.
 */
async function forceTheme(page: Page, preset: string) {
  await page.addInitScript(
    ([key, value]) => {
      try {
        const raw = window.localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : {};
        window.localStorage.setItem(key, JSON.stringify({ ...parsed, preset: value }));
      } catch {
        /* a private window with no storage still gets the attribute below */
      }
      document.documentElement.setAttribute('data-theme', value);
    },
    [BOOTSTRAP_KEY, preset],
  );
}

/** Re-assert the attribute after the app has settled, then let it repaint. */
async function pinTheme(page: Page, preset: string) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
  }, preset);
  await page.waitForTimeout(250);
}

async function openBuilder(page: Page) {
  if (ROUTINE_ID) {
    await page.goto(`${STUDIO_LIST}/${ROUTINE_ID}`);
  } else {
    await page.goto(STUDIO_LIST);
    await passPostLoginGates(page);
    // The list's rows are links into the builder; the first one is enough.
    const firstRoutine = page.locator('a[href*="/automations/"], [data-testid^="studio-row-"]').first();
    await expect(
      firstRoutine,
      'no routine to screenshot — create one, or pass ROUTINE_ID=<id>',
    ).toBeVisible({ timeout: 30_000 });
    await firstRoutine.click();
  }
  await passPostLoginGates(page);
  // The canvas is the landmark: it is the last thing to paint, and every view
  // below is anchored on it.
  await expect(page.locator('.react-flow__renderer').first()).toBeVisible({ timeout: 60_000 });
  // React Flow's fitView animates; a screenshot taken mid-flight is a blurred
  // graph, which is exactly the artefact nobody can judge.
  await page.waitForTimeout(1_200);
}

async function shoot(page: Page, theme: string, view: string) {
  const dir = path.join(ARTIFACTS, theme);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${view}.png`), fullPage: false });
}

test.describe('builder chrome across every theme', () => {
  // Screenshots are a serial job by nature — the report is a folder someone
  // scrolls through, and parallel workers interleave the console output.
  test.describe.configure({ mode: 'serial' });

  for (const theme of THEMES) {
    test(`${theme} — canvas, run banner and step drawer`, async ({ page }) => {
      await forceTheme(page, theme);
      await openBuilder(page);
      await pinTheme(page, theme);

      // ── the checks a machine can make ────────────────────────────────────
      const resolved = await page.evaluate((tokens) => {
        const cs = getComputedStyle(document.documentElement);
        return Object.fromEntries(tokens.map(t => [t, cs.getPropertyValue(t).trim()]));
      }, FAMILY_TOKENS);
      for (const token of FAMILY_TOKENS) {
        expect(
          resolved[token],
          `${token} resolves to nothing under data-theme="${theme}" — it is defined for one theme only`,
        ).not.toBe('');
      }

      // A card that paints itself with --accent is the straggler this round
      // fixed twice (LoopItemNode, ValueBuilder's two escapes into and out of
      // the raw editor). Assert the ban rather than trusting a grep to stay
      // true.
      //
      // SCOPE, and it is narrower than it looks: this scans inside
      // `.react-flow__renderer` only — the CANVAS. The step drawer is not in
      // that subtree, and it still carries roughly a dozen --accent tints
      // across mapping/ and flow/settings/ (BindingField, JsonTreePicker,
      // ConditionBuilder, LoopOverPicker, ParseJsonFields, routeEditors,
      // setEditors, …). Widening the selector to the drawer would therefore
      // fail on day one on files this round did not own, so the ValueBuilder
      // half is pinned by a test that CAN run instead —
      // Builder/flow/settings/formStyles.test.js, "the visual value editor
      // tints no control with --accent". The rest is open debt, not coverage.
      const accentOnCanvas = await page.evaluate(() => {
        const root = document.querySelector('.react-flow__renderer');
        if (!root) return [];
        const offenders: string[] = [];
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
          const cls = typeof el.className === 'string' ? el.className : '';
          if (/\bvar\(--accent\)|\[var\(--accent\)\]/.test(cls)) offenders.push(cls.slice(0, 120));
        }
        return offenders;
      });
      expect(
        accentOnCanvas,
        'a canvas surface is painted with --accent, which vanishes against the light themes (nodeTypeColors.js:25-26)',
      ).toEqual([]);

      // ── 1a: the canvas at rest ───────────────────────────────────────────
      await shoot(page, theme, '1a-canvas');

      // ── 1d: the canvas with the south bar's run banner, if this routine
      //        has a run to show. Best effort: a routine that has never run
      //        has no banner, and that is not a failure of the theme.
      const banner = page.getByTestId('canvas-run-banner');
      if (await banner.isVisible().catch(() => false)) {
        await banner.scrollIntoViewIfNeeded().catch(() => {});
        await shoot(page, theme, '1d-run-banner');
      }

      // ── 1h: the step drawer, three columns ───────────────────────────────
      // Double-click opens the FULL density (a single click opens the small
      // dialog), which is the view carrying the column chrome 2a/2b describe.
      const firstCard = page.locator('.react-flow__node').nth(1);
      if (await firstCard.isVisible().catch(() => false)) {
        await firstCard.dblclick();
        const drawer = page.getByTestId('ndv-drawer');
        if (await drawer.isVisible({ timeout: 10_000 }).catch(() => false)) {
          await page.waitForTimeout(600);
          await shoot(page, theme, '1h-step-drawer');
          await page.keyboard.press('Escape');
        }
      }
    });
  }
});
