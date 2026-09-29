/**
 * Photograph the PUBLIC intake page (/p/<token>) in a real headless browser —
 * anonymous, no session, exactly what a customer gets. Desktop and phone.
 *
 * Usage (from playwright-tests/, so @playwright/test resolves):
 *   node <this file> <url> <outDir> [step]
 * `step` (1..7) optionally clicks "Start" and advances to that photo step so
 * the wizard cards can be seen too.
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '@playwright/test';

const [url, outDir, stepArg] = process.argv.slice(2);
if (!url || !outDir) { console.error('usage: node shot-public.mjs <url> <outDir> [step]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };

async function shoot(name, viewport) {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'nl-NL' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
    // Not 'networkidle': the Vite dev server keeps its HMR socket open, so
    // that never fires. Wait for the app's own first paint instead.
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('form, [data-testid="public-app"], h1, h2', { timeout: 60000 });
    await page.waitForTimeout(2500); // fonts + the last paint

    const stepNo = Number(stepArg || 0);
    if (stepNo > 0) {
        // The customer's own path: fill the NAW fields, start, walk to the step.
        const fill = async (label, value) => {
            const el = page.getByLabel(label, { exact: false }).first();
            if (await el.count()) await el.fill(value);
        };
        await fill('Naam', 'Testklant');
        await fill('Telefoon', '0612345678');
        await fill('E-mail', 'test@example.com');
        await fill('Adres', 'Teststraat 1');
        await fill('Plaats', 'Pijnacker');
        await page.getByRole('button', { name: /Start/ }).click();
        await page.waitForTimeout(800);
        for (let i = 1; i < stepNo; i++) {
            await page.getByRole('button', { name: /Volgende foto/ }).click();
            await page.waitForTimeout(400);
            // No photo yet → the confirm dialog; accept it to move on.
            const ok = page.getByRole('button', { name: /Toch verder|Doorgaan|Ja/i }).first();
            if (await ok.count()) { await ok.click(); await page.waitForTimeout(400); }
        }
        await page.waitForTimeout(600);
    }

    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    const ground = await page.evaluate(() => {
        const el = document.querySelector('[style*="--app-canvas"]') || document.body;
        return getComputedStyle(el).backgroundColor;
    });
    console.log(`${name}: ${file} | font=${font} | ground=${ground} | errors=${errors.length}`);
    for (const e of errors.slice(0, 12)) console.log('  !', e.slice(0, 220));
    await browser.close();
}

await shoot('desktop', VIEWPORTS.desktop);
await shoot('phone', VIEWPORTS.phone);
