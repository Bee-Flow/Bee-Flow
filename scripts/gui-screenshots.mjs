#!/usr/bin/env node
/**
 * One screenshot per screen of the signed-in web client, for the before/after
 * comparison of plan phase 2 ("with every module present the GUI stays exactly as
 * it is"). The screens are the addresses of the GUI inventory goldens
 * (agent-hub `*.inventory.golden.json`, read by tree path over every root):
 * the app's pages, the Settings tabs, every Studio section, every admin
 * dashboard tab and rail row, and every section of the Organisation tab.
 *
 * It needs a running stack, the one the e2e suite uses (e2e/README.md): the app at
 * BASE_URL (default http://localhost:5176) with a server behind it and a
 * password account ADMIN_USER (default admin) / ADMIN_PASSWORD (a platform
 * admin, so every admin tab opens). It signs in through the login form as
 * e2e/tests/global-setup.ts does, or reuses a Playwright storage state
 * (STORAGE_STATE=<file>). Viewport 1440x900, animations off (CSS transitions and
 * animations disabled, `animations: 'disabled'`, reduced motion), one PNG per
 * address in OUT (default e2e/artifacts/gui-screenshots/, which git ignores),
 * plus index.json (address -> file, and the ones that failed).
 *
 *   node scripts/gui-screenshots.mjs --list          the addresses only, no browser
 *   ADMIN_PASSWORD=… node scripts/gui-screenshots.mjs [--out <dir>] [--only <text>]
 *
 * Playwright: the `playwright` package where Node resolves it, else e2e's
 * `@playwright/test` (cd e2e && npm install).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveTreePath } from './lib/roots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDENS = {
    routes: 'src/authedApp/appRoutes.inventory.golden.json',
    settings: 'src/authedApp/settingsRoutes.inventory.golden.json',
    studio: 'src/components/admin/Studio/studioSections.inventory.golden.json',
    admin: 'src/components/admin/dashboard/adminTabs.inventory.golden.json',
    org: 'src/components/admin/organisation/orgSections.inventory.golden.json',
};

/** A golden by tree path, from whichever web root holds it. */
export function readGolden(treePath, resolve = (p) => resolveTreePath('agent-hub', p)) {
    const abs = resolve(treePath);
    if (!abs) throw new Error(`${treePath} is in no web root: run the inventory tests first (cd agent-hub && npx vitest run inventory)`);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/**
 * Every address to photograph, in inventory order, without repeats: the pages
 * with an address of their own (not a forwarding one), the Settings tabs, the
 * Studio sections, the admin tabs and their rail rows, the Organisation sections.
 */
export function inventoryRoutes(golden = readGolden) {
    const routes = golden(GOLDENS.routes);
    const settings = golden(GOLDENS.settings);
    const studio = golden(GOLDENS.studio);
    const admin = golden(GOLDENS.admin);
    const org = golden(GOLDENS.org);
    const forwarded = new Set(routes.routes.filter((r) => r.redirect).map((r) => r.pattern));
    const out = [
        ...routes.pages.filter((p) => p.path && !forwarded.has(p.path)).map((p) => p.path),
        ...settings.topLevel.map((t) => t.path),
        `/app/studio/${studio.start.urlSegment}`,
        ...studio.sections.map((s) => `/app/studio/${s.urlSegment}`),
        ...admin.tabs.filter((t) => t.id !== 'organisation').map((t) => `/app/admin/${t.id}`),
        ...Object.entries(admin.railRows).flatMap(([tab, rows]) => rows.map((r) => `/app/admin/${tab}/${r.section}`)),
        ...org.sections.map((s) => `/app/admin/organisation/${s.id}`),
    ];
    return [...new Set(out)];
}

/** The file name of an address: `/app/admin/security/sso` -> `app__admin__security__sso.png`. */
export const shotName = (address) => `${address.replace(/^\/+|\/+$/g, '').replace(/\//g, '__') || 'root'}.png`;

const NO_MOTION = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';

function loadPlaywright() {
    const req = createRequire(import.meta.url);
    try { return req('playwright'); } catch { /* not installed globally */ }
    return createRequire(path.join(ROOT, 'e2e', 'package.json'))('@playwright/test');
}

async function signIn(page, baseURL, user, password) {
    await page.goto(`${baseURL}/app`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('username').fill(user, { timeout: 30_000 });
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit-button').click();
    await page.getByTestId('sidebar').waitFor({ timeout: 60_000 });
}

async function shoot(page, baseURL, address, file) {
    await page.goto(`${baseURL}${address}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.addStyleTag({ content: NO_MOTION });
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
}

async function main(argv) {
    const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
    const only = flag('--only');
    const addresses = inventoryRoutes().filter((a) => !only || a.includes(only));
    if (argv.includes('--list')) { console.log(addresses.join('\n')); return 0; }
    const baseURL = (process.env.BASE_URL || 'http://localhost:5176').replace(/\/+$/, '');
    const out = path.resolve(flag('--out') || path.join(ROOT, 'e2e', 'artifacts', 'gui-screenshots'));
    if (!process.env.STORAGE_STATE && !process.env.ADMIN_PASSWORD) {
        console.error('ADMIN_PASSWORD (or STORAGE_STATE) is not set: no way to sign in. See the header of this script.');
        return 2;
    }
    fs.mkdirSync(out, { recursive: true });
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch();
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce',
        ...(process.env.STORAGE_STATE ? { storageState: process.env.STORAGE_STATE } : {}),
    });
    const page = await context.newPage();
    const index = { baseURL, shots: {}, failed: {} };
    try {
        if (!process.env.STORAGE_STATE) await signIn(page, baseURL, process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD);
        for (const address of addresses) {
            const name = shotName(address);
            try {
                await shoot(page, baseURL, address, path.join(out, name));
                index.shots[address] = name;
            } catch (err) {
                index.failed[address] = String(err?.message || err).split('\n')[0];
            }
        }
    } finally {
        await browser.close();
        fs.writeFileSync(path.join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    }
    console.log(`${Object.keys(index.shots).length} screenshots in ${out}, ${Object.keys(index.failed).length} failed (index.json)`);
    return Object.keys(index.failed).length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
