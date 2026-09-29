/**
 * Connecting to a server, end to end, in the real app.
 *
 * Every test here stands for a way "connect to my server" has actually failed:
 * a preload the sandbox refused (so Connect did nothing at all), an address
 * typed without `http://`, a redirect, the API port instead of the web app, a
 * server that does not accept the address it is reached at, a server that is
 * down when the app starts, and a single sign-on that left the window.
 *
 * `@smoke` marks the three that prove a package works at all — it starts, its
 * pages have the bridge, it connects — and are run against every installed
 * format in CI, where the full suite runs once per OS.
 */

import { expect, test } from '@playwright/test';

import { startFakeServer, type FakeServer } from './fakeServer.ts';
import { connect, lanAddress, launch, recordExternalOpens, sandboxRequired, type Launched } from './launch.ts';

const servers: FakeServer[] = [];
let running: Launched | null = null;

async function server(options: Parameters<typeof startFakeServer>[0] = {}): Promise<FakeServer> {
    const started = await startFakeServer(options);
    servers.push(started);
    return started;
}

async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
    running = await launch(options);
    return running;
}

test.afterEach(async () => {
    await running?.close();
    running = null;
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

test('the first-run page has the desktop bridge', { tag: '@smoke' }, async () => {
    const app = await start();
    const page = await app.window();
    await expect(page).toHaveURL(/welcome\.html/);
    expect(await page.evaluate(() => typeof window.beeflow)).toBe('object');
    expect(await page.evaluate(() => window.beeflow?.version ?? '')).not.toBe('');
    if (sandboxRequired()) {
        // This package claims it can run Chromium's sandbox here; hold it to that.
        expect(await app.app.evaluate(({ app: electronApp }) => electronApp.commandLine.hasSwitch('no-sandbox'))).toBe(false);
    }
});

test('an address typed without http:// connects to a plain-http server', { tag: '@smoke' }, async () => {
    const bee = await server();
    const app = await start();
    const page = await app.window();

    await connect(page, `127.0.0.1:${bee.port}`);

    await page.waitForURL(`${bee.origin}/**`);
    expect(await page.evaluate(() => (window as unknown as { __e2e: { hasBridge: boolean } }).__e2e.hasBridge)).toBe(true);
    expect((app.settings().server as { url: string }).url).toBe(bee.origin);
    // The client names itself to its own server, and only there.
    expect(bee.requests.some((r) => r.client === 'desktop')).toBe(true);
});

test('a server that redirects is saved at the address it redirected to', async () => {
    const target = await server();
    const front = await server({ redirectTo: target.origin });
    const app = await start();
    const page = await app.window();

    await connect(page, front.origin);

    await page.waitForURL(`${target.origin}/**`);
    expect((app.settings().server as { url: string }).url).toBe(target.origin);
});

test('the API port is recognised and the right port suggested', async () => {
    const api = await server({ spa: false });
    const app = await start();
    const page = await app.window();

    await connect(page, api.origin);

    await expect(page.locator('#status')).toContainText(/API/);
    await expect(page).toHaveURL(/welcome\.html/);
    expect((app.settings().server as { url: string } | undefined)?.url ?? '').toBe('');
});

test('a server that refuses this address says which setting to change', async () => {
    const bee = await server({ allowedOrigins: ['http://localhost:5176'] });
    const app = await start();
    const page = await app.window();

    await connect(page, bee.origin);

    await expect(page.locator('#status')).toContainText(/CORS_ORIGIN|CLIENT_PUBLIC_HOST/);
    await expect(page).toHaveURL(/welcome\.html/);
});

test('a server that is down at launch shows why, and the app recovers when it is back', async () => {
    // Find a free port, then leave it free.
    const probe = await startFakeServer();
    const { port, origin } = probe;
    await probe.close();

    const app = await start({ settings: { server: { url: origin, recent: [] } } });
    const page = await app.window();
    await page.waitForURL(/unreachable\.html/);

    // The rest of the app finished starting even though the first load
    // failed: a settings change made now is still applied.
    await page.evaluate(() => window.beeflow?.settings.patch({ appearance: { theme: 'dark' } }));
    await expect.poll(() => app.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');

    await server({ port });
    await page.locator('#retry').click();
    await page.waitForURL(`${origin}/**`);
});

// Behaviour, not a code path: Electron reports a replaced navigation without
// did-fail-load, so this guards the outcome (the workspace stays) whichever
// way a future Electron reports it.
test('a navigation the page replaces does not throw the workspace away', async () => {
    const bee = await server();
    const app = await start({ settings: { server: { url: bee.origin, recent: [] } } });
    const page = await app.window();
    await page.waitForURL(`${bee.origin}/**`);

    await page.evaluate(() => {
        window.location.href = '/slow';
        setTimeout(() => {
            window.location.href = '/?second=1';
        }, 300);
    });

    await page.waitForURL(`${bee.origin}/?second=1`);
    await page.waitForTimeout(3_000);
    await expect(page).toHaveURL(`${bee.origin}/?second=1`);
});

test('a saved server that now sends people elsewhere says where, instead of a blank window', async () => {
    // 127.0.0.1 → localhost is another host as far as the app is concerned,
    // and a move to another host over plain http is not followed by itself.
    const movedOptions: Parameters<typeof startFakeServer>[0] = {};
    const moved = await server(movedOptions);
    const movedOrigin = `http://localhost:${moved.port}`;
    // Configured for the address it is reached at, as a real server would be.
    movedOptions.allowedOrigins = [movedOrigin];
    const old = await server({ redirectTo: movedOrigin });
    const app = await start({ settings: { server: { url: old.origin, recent: [] } } });
    const page = await app.window();
    const opened = await recordExternalOpens(app.app);

    await page.waitForURL(/unreachable\.html/);
    await expect(page.locator('#use-target')).toBeVisible();
    await expect(page.locator('#use-target')).toContainText(movedOrigin);
    expect(await opened()).toEqual([]);

    await page.locator('#use-target').click();
    await page.waitForURL(`${movedOrigin}/**`);
    expect((app.settings().server as { url: string }).url).toBe(movedOrigin);
    expect(await opened()).toEqual([]);
});

test('app commands reach the workspace page', { tag: '@smoke' }, async () => {
    const bee = await server();
    const app = await start({ settings: { server: { url: bee.origin, recent: [] } } });
    const page = await app.window();
    await page.waitForURL(`${bee.origin}/**`);
    await page.waitForFunction(() => Boolean((window as unknown as { __e2e?: unknown }).__e2e));

    await app.app.evaluate(({ Menu }) => {
        const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
            for (const item of items) {
                if (item.label === 'New Chat') return item;
                const inner = item.submenu ? find(item.submenu.items) : undefined;
                if (inner) return inner;
            }
            return undefined;
        };
        const item = find(Menu.getApplicationMenu()?.items ?? []);
        item?.click();
    });

    await expect
        .poll(() => page.evaluate(() => (window as unknown as { __e2e: { commands: Array<{ kind: string }> } }).__e2e.commands.map((c) => c.kind)))
        .toContain('new-chat');
});

test('single sign-on through the server API address stays in the app', async () => {
    // The real SPA starts sign-on at SERVER_PUBLIC_HOST — a second origin that
    // /auth/setup-status reports — and the provider hop ends back on the SPA.
    const apiOptions: Parameters<typeof startFakeServer>[0] = {};
    const api = await server(apiOptions);
    const spa = await server({ ssoServerUrl: api.origin });
    apiOptions.ssoReturnTo = `${spa.origin}/?signed-in=1`;

    const app = await start();
    const page = await app.window();
    await connect(page, spa.origin);
    await page.waitForURL(`${spa.origin}/**`);

    await page.evaluate((target) => {
        window.location.href = `${target}/auth/login/google`;
    }, api.origin);

    await page.waitForURL(`${spa.origin}/?signed-in=1`);
    expect(api.requests.some((r) => r.path === '/auth/login/google')).toBe(true);
});

test('a plain-http server on the local network is a secure context', async () => {
    const address = lanAddress();
    test.skip(!address, 'this machine has no private IPv4 address (set BEEFLOW_E2E_LAN_ADDRESS to name one)');

    const bee = await server({ host: address! });
    const app = await start({ settings: { server: { url: bee.origin, recent: [] } } });
    const page = await app.window();
    await page.waitForURL(`${bee.origin}/**`);

    const context = await page.evaluate(() => (window as unknown as { __e2e: { secureContext: boolean; subtle: boolean } }).__e2e);
    expect(context.secureContext).toBe(true);
    expect(context.subtle).toBe(true);
});
