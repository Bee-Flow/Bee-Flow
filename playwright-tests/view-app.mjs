/**
 * Open an App Studio app in a real browser and photograph every screen.
 *
 * Not a test — a viewer. The specs in tests/ assert; this exists so a change to
 * an app can be LOOKED at, which is the only way to catch what validation
 * cannot: spans that wrapped past 12 columns, a region rendered empty because a
 * binding returned nothing, cramped or clipped text.
 *
 * It ATTACHES to a browser you already have open and reuses its session. An
 * unpublished app is visible to its owner alone, so this is the way in that
 * does not involve handing a password to anything. Start your browser with
 * remote debugging first — closing it completely, because an already-running
 * instance ignores the flag:
 *
 *   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 *
 * Your normal profile comes back with it, so you are still logged in as you.
 *
 * It opens ONE new tab, works in it, and closes only that tab; your other tabs
 * and the browser itself are left alone.
 *
 * Plain .mjs on purpose — no tsx, no ts-node, nothing added to package.json.
 *
 * USAGE
 *   cd playwright-tests
 *   APP_ID=<uuid> node view-app.mjs
 *   APP_ID=<uuid> SHOTS=./shots node view-app.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_ID = process.env.APP_ID;
const BASE_URL = process.env.BASE_URL || 'http://localhost:5176';
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const SHOT_DIR = path.resolve(process.env.SHOTS || path.join(__dirname, 'shots'));
// Below 768px the Agent Hub switches to mobile mode and redirects most routes.
const VIEWPORT = { width: 1600, height: 1000 };

if (!APP_ID) {
    console.error('APP_ID is required. e.g. APP_ID=c1640f4f-… node view-app.mjs');
    process.exit(2);
}

const slug = (s, fallback) =>
    (s || '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || fallback;

async function main() {
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    let browser;
    try {
        browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
        console.error(`\nCould not attach to a browser at ${CDP_URL}: ${e.message}\n`);
        console.error('Close Chrome COMPLETELY, then reopen it with:');
        console.error('  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    if (!context) {
        console.error('Attached, but the browser exposes no context to work in.');
        process.exit(1);
    }

    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT);
    console.log(`Attached to your browser at ${CDP_URL} — using your session.`);

    // Runtime errors are the most useful signal and are invisible in a
    // screenshot, so collect them alongside the images.
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    const url = `${BASE_URL}/app/apps/${APP_ID}`;
    console.log(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);

    if (/\/login/i.test(page.url())) {
        console.error(`\nThat browser is not logged in (landed on ${page.url()}).`);
        console.error('Log in as the app owner in it, then run this again.');
        await page.close();
        await browser.close();
        process.exit(1);
    }

    const shot = async (label) => {
        const file = path.join(SHOT_DIR, `${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`  shot ${file}`);
    };

    await shot('00-home');

    // Walk the app's OWN navigation rather than a screen list hard-coded here,
    // which would rot the moment a screen is added.
    const nav = page.locator('[data-app-nav] button, [data-app-nav] a, nav[aria-label*="app" i] button');
    const count = await nav.count().catch(() => 0);
    console.log(`Nav items found: ${count}`);

    for (let i = 0; i < count; i++) {
        const item = nav.nth(i);
        const name = slug(await item.textContent().catch(() => ''), `screen-${i}`);
        await item.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1200);
        await shot(`${String(i + 1).padStart(2, '0')}-${name}`);
    }

    if (pageErrors.length) console.log('\nRuntime errors:\n- ' + pageErrors.join('\n- '));
    if (consoleErrors.length) console.log('\nConsole errors:\n- ' + consoleErrors.slice(0, 15).join('\n- '));
    if (!pageErrors.length && !consoleErrors.length) console.log('\nNo runtime or console errors.');

    // Leave the browser as we found it — close only our own tab.
    await page.close();
    await browser.close();
    console.log(`\nScreens saved to ${SHOT_DIR}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
