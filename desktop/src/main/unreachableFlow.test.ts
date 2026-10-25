import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ServerProbeResult } from '../shared/types.ts';
import { UnreachableFlow, type UnreachableHost } from './unreachableFlow.ts';

const OK = { ok: true, url: 'https://bee.example' } as ServerProbeResult;
const DOWN = { ok: false, code: 'refused', error: 'nothing is listening' } as ServerProbeResult;

function setup(overrides: Partial<UnreachableHost> = {}) {
    const loads: string[] = [];
    const adopted: string[] = [];
    const warnings: string[] = [];
    let probes = 0;
    let probeResult: ServerProbeResult = DOWN;
    let windowUrl: string | null = 'https://bee.example/chat';
    let release: (() => void) | null = null;
    const host: UnreachableHost = {
        serverUrl: () => 'https://bee.example',
        mainWindowUrl: () => windowUrl,
        probe: async () => {
            probes += 1;
            if (release === null) return probeResult;
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return probeResult;
        },
        load: (url) => void loads.push(url),
        unreachablePage: (server, error, code, target) => `page:${server}|${error}|${code}|${target ?? ''}`,
        setServer: async (url) => void adopted.push(url),
        isServerNavigation: (url) => url.startsWith('https://bee.example'),
        warn: (_tag, message) => void warnings.push(message),
        ...overrides,
    };
    return {
        flow: new UnreachableFlow(host),
        loads,
        adopted,
        warnings,
        probes: () => probes,
        setProbe: (result: ServerProbeResult) => {
            probeResult = result;
        },
        setWindow: (url: string | null) => {
            windowUrl = url;
        },
        hold: () => {
            release = () => {};
        },
        letGo: () => release?.(),
    };
}

test('a server that does not answer gets the unreachable page', async () => {
    const t = setup();
    await t.flow.show('ERR_CONNECTION_REFUSED');
    assert.deepEqual(t.loads, ['page:https://bee.example|nothing is listening|refused|']);
});

test('a server that answers the probe gets one quiet retry, then the page', async () => {
    const t = setup();
    t.setProbe(OK);
    await t.flow.show('blip');
    assert.deepEqual(t.loads, ['https://bee.example']);
    await t.flow.show('blip again');
    assert.equal(t.loads.length, 2);
    assert.match(t.loads[1] ?? '', /^page:/);
});

test('a finished load of the server gives the retry budget back', async () => {
    const t = setup();
    t.setProbe(OK);
    await t.flow.show('blip');
    t.flow.loaded('https://bee.example/chat');
    await t.flow.show('blip');
    assert.deepEqual(t.loads, ['https://bee.example', 'https://bee.example']);
});

test('a load of another host does not give the retry budget back', async () => {
    const t = setup();
    t.setProbe(OK);
    await t.flow.show('blip');
    t.flow.loaded('https://idp.example/login');
    await t.flow.show('blip');
    assert.match(t.loads[1] ?? '', /^page:/);
});

test('nothing happens without a server, a window, or on the error page itself', async () => {
    const noServer = setup({ serverUrl: () => '' });
    await noServer.flow.show('x');
    assert.deepEqual([noServer.loads, noServer.probes()], [[], 0]);

    const noWindow = setup();
    noWindow.setWindow(null);
    await noWindow.flow.show('x');
    assert.deepEqual([noWindow.loads, noWindow.probes()], [[], 0]);

    const onErrorPage = setup();
    onErrorPage.setWindow('file:///app/shell/unreachable.html');
    await onErrorPage.flow.show('x');
    assert.deepEqual([onErrorPage.loads, onErrorPage.probes()], [[], 0]);
});

test('a verdict about a page nobody is looking at any more is dropped', async () => {
    const t = setup();
    t.hold();
    const pending = t.flow.show('slow');
    t.flow.navigationStarted('https://bee.example/other');
    t.letGo();
    await pending;
    assert.deepEqual(t.loads, []);
});

test('a window that went away during the probe gets nothing', async () => {
    const t = setup();
    t.hold();
    const pending = t.flow.show('slow');
    t.setWindow(null);
    t.letGo();
    await pending;
    assert.deepEqual(t.loads, []);
});

test('two failures close together share one flight', async () => {
    const t = setup();
    const first = t.flow.show('a');
    const second = t.flow.show('b');
    assert.equal(first, second);
    await first;
    assert.equal(t.probes(), 1);
    await t.flow.show('c');
    assert.equal(t.probes(), 2, 'a later failure starts a new flight');
});

test('a redirect to the same server is adopted through setServer', () => {
    const t = setup();
    t.flow.navigationStarted('https://bee.example/');
    assert.equal(t.flow.redirectRefused('https://bee.example:8443/'), true);
    assert.deepEqual(t.adopted, ['https://bee.example:8443']);
    assert.deepEqual(t.loads, []);
});

test('a redirect that downgrades to http shows the page that names the new address', () => {
    const t = setup();
    t.flow.navigationStarted('https://bee.example/');
    assert.equal(t.flow.redirectRefused('http://elsewhere.example/'), true);
    assert.deepEqual(t.adopted, []);
    assert.equal(t.loads.length, 1);
    assert.match(t.loads[0] ?? '', /redirected\|http:\/\/elsewhere\.example\//);
    assert.match(t.warnings[0] ?? '', /now redirects to/);
});

test('a refused redirect that did not start at the server is not ours to handle', () => {
    const t = setup();
    t.flow.navigationStarted('https://idp.example/start');
    assert.equal(t.flow.redirectRefused('https://other.example/'), false);
    assert.deepEqual([t.adopted, t.loads], [[], []]);
});
