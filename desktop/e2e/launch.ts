/**
 * Start the desktop app the way a user would, in a profile of its own.
 *
 * `BEEFLOW_E2E_APP` points at a packaged build — `release/linux-unpacked/beeflow`,
 * an installed `Bee Flow.exe`, `Bee Flow.app/Contents/MacOS/Bee Flow` — so CI
 * tests the artefact people download rather than the source tree. Unset, the
 * tests run `electron dist/main/index.js` from this checkout (`npm run build`
 * first).
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { hostKind } from '../src/main/server/url.ts';

const DESKTOP = path.resolve(__dirname, '..');

export interface Launched {
    readonly app: ElectronApplication;
    /** The throwaway userData directory this launch runs in. */
    readonly profile: string;
    /** The workspace window: the welcome page on a first run, the server's SPA after. */
    window(): Promise<Page>;
    settings(): Record<string, unknown>;
    close(): Promise<void>;
}

export interface LaunchOptions {
    /** Seed `settings.json` before the app starts, e.g. with a saved server. */
    settings?: Record<string, unknown>;
    /** Reuse a profile from an earlier launch instead of a fresh one. */
    profile?: string;
}

export async function launch(options: LaunchOptions = {}): Promise<Launched> {
    const profile = options.profile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-e2e-'));
    if (options.settings) {
        fs.writeFileSync(path.join(profile, 'settings.json'), `${JSON.stringify(options.settings, null, 4)}\n`);
    }

    const packaged = process.env.BEEFLOW_E2E_APP;
    const app = await electron.launch({
        executablePath: packaged || electronBinary(),
        args: packaged ? [] : [path.join(DESKTOP, 'dist/main/index.js')],
        // Playwright adds --no-sandbox on Linux unless told otherwise, which
        // would make every Linux run prove nothing about the sandbox. CI legs
        // that install a package able to set it up ask for it explicitly.
        chromiumSandbox: sandboxRequired(),
        env: {
            ...process.env,
            BEEFLOW_USER_DATA_DIR: profile,
            // A packaged build would otherwise ask GitHub for updates in the
            // middle of a test. Port 9 is discard: the check fails at once.
            BEEFLOW_UPDATE_FEED_URL: 'https://127.0.0.1:9/',
            ELECTRON_ENABLE_LOGGING: '1',
        },
        timeout: 60_000,
    });

    return {
        app,
        profile,
        async window() {
            const first = await app.firstWindow();
            await first.waitForLoadState('domcontentloaded');
            return first;
        },
        settings() {
            // No file yet is a real state: the app writes settings only once
            // something was saved, and a refused server saves nothing.
            const file = path.join(profile, 'settings.json');
            return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
        },
        async close() {
            await app.close().catch(() => undefined);
        },
    };
}

function electronBinary(): string {
    const relative = fs.readFileSync(path.join(DESKTOP, 'node_modules/electron/path.txt'), 'utf8').trim();
    return path.join(DESKTOP, 'node_modules/electron/dist', relative);
}

/**
 * A private IPv4 address of this machine (10/8, 172.16/12, 192.168/16, …), if
 * it has one — the kind of address a LAN server is reached at. Loopback and
 * public addresses do not count: the behaviour under test is specific to
 * private ones. `BEEFLOW_E2E_LAN_ADDRESS` names one explicitly.
 */
export function lanAddress(): string | null {
    const explicit = process.env.BEEFLOW_E2E_LAN_ADDRESS;
    if (explicit) return explicit;
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && hostKind(address.address) === 'private') return address.address;
        }
    }
    return null;
}

/** CI sets this where the installed package must be able to run Chromium's sandbox. */
export function sandboxRequired(): boolean {
    return process.env.BEEFLOW_E2E_SANDBOX === '1';
}

/**
 * Replace shell.openExternal in the app with a recorder, so a test can see
 * what would have been handed to the browser — and no browser opens.
 */
export async function recordExternalOpens(app: ElectronApplication): Promise<() => Promise<string[]>> {
    await app.evaluate(({ shell }) => {
        const opened: string[] = [];
        (globalThis as unknown as { __opened: string[] }).__opened = opened;
        shell.openExternal = async (url: string) => {
            opened.push(url);
        };
    });
    return () => app.evaluate(() => [...(globalThis as unknown as { __opened: string[] }).__opened]);
}

/** Type an address on the welcome page and press Connect. */
export async function connect(page: Page, address: string): Promise<void> {
    await page.locator('#server').fill(address);
    await page.locator('#connect').click();
}
