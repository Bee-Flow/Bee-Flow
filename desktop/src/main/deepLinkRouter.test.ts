import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EVENT } from '../shared/ipc.ts';
import { type DeepLinkHost, routeDeepLink } from './deepLinkRouter.ts';

function setup(confirm = true, serverUrl = 'https://bee.example') {
    const calls: string[] = [];
    const prompts: { title: string; detail: string }[] = [];
    const host: DeepLinkHost = {
        info: () => {},
        confirm: (prompt) => {
            prompts.push(prompt);
            return confirm;
        },
        showMain: () => void calls.push('showMain'),
        serverUrl: () => serverUrl,
        loadMain: (url) => void calls.push(`load ${url}`),
        quickAsk: (text) => void calls.push(`quickAsk ${text}`),
        setServer: async (url) => void calls.push(`setServer ${url}`),
        pairNextcloud: async (server) => void calls.push(`pair ${server}`),
        revealPath: (path) => void calls.push(`reveal ${path}`),
        broadcast: (channel, payload) => void calls.push(`broadcast ${channel} ${String(payload)}`),
    };
    return { host, calls, prompts };
}

test('a navigation link shows the window and loads the path on the saved server', () => {
    const { host, calls, prompts } = setup();
    routeDeepLink('beeflow://chat/42', host);
    assert.equal(calls[0], 'showMain');
    assert.match(calls[1] ?? '', /^load https:\/\/bee\.example\/.*42/);
    assert.equal(prompts.length, 0, 'a plain navigation asks nothing');
    assert.equal(calls.at(-1), `broadcast ${EVENT.deepLink} beeflow://chat/42`);
});

test('without a saved server a navigation loads nothing', () => {
    const { host, calls } = setup(true, '');
    routeDeepLink('beeflow://chat/42', host);
    assert.ok(!calls.some((c) => c.startsWith('load ')));
});

test('a link that repoints the app asks first, and Cancel stops everything', () => {
    const { host, calls, prompts } = setup(false);
    routeDeepLink('beeflow://server/set?url=https%3A%2F%2Fother.example', host);
    assert.equal(prompts.length, 1);
    assert.deepEqual(calls, [], 'no server change, no broadcast');
});

test('confirmed set-server and pair-nextcloud links run their flows', () => {
    const a = setup(true);
    routeDeepLink('beeflow://server/set?url=https%3A%2F%2Fother.example', a.host);
    assert.ok(a.calls.some((c) => c.startsWith('setServer ')));
    const b = setup(true);
    routeDeepLink('beeflow://nextcloud/pair?server=https%3A%2F%2Fbee.example', b.host);
    assert.ok(b.calls.some((c) => c.startsWith('pair ')));
});

test('an unknown link does nothing at all', () => {
    const { host, calls, prompts } = setup();
    routeDeepLink('https://not-ours.example/', host);
    assert.deepEqual([calls, prompts], [[], []]);
});
