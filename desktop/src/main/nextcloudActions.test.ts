import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EVENT } from '../shared/ipc.ts';
import type { NextcloudStatus } from '../shared/types.ts';
import type { LoginFlowCredential } from './nextcloud/loginFlow.ts';
import { type BridgeLike, NextcloudActions, type NextcloudHost } from './nextcloudActions.ts';

const CREDENTIAL = { server: 'https://cloud.example', loginName: 'ada', appPassword: 'app-pw' } as LoginFlowCredential;

function status(folder?: string): NextcloudStatus {
    return {
        installed: true,
        running: true,
        accounts: [{ id: '0', url: 'https://cloud.example', user: 'ada', folders: folder ? [{ localPath: folder }] : [] }],
    } as unknown as NextcloudStatus;
}

function setup(overrides: Partial<NextcloudHost> = {}) {
    const events: string[] = [];
    const sent: { url: string; init: unknown }[] = [];
    let logins: string[] = [];
    const bridge: BridgeLike = {
        refresh: async () => status('/home/ada/Nextcloud'),
        login: async (server, openExternal) => {
            logins = [...logins, server];
            await openExternal('https://cloud.example/login/v2/flow/abc');
            return CREDENTIAL;
        },
    };
    const host: NextcloudHost = {
        log: {
            info: (_s, m) => void events.push(`info ${m}`),
            warn: (_s, m) => void events.push(`warn ${m}`),
            debug: (_s, m) => void events.push(`debug ${m}`),
        },
        bridge,
        storeAppPassword: async (pw) => {
            events.push(`store ${pw}`);
            return true;
        },
        serverUrl: () => 'https://bee.example',
        mainSessionFetch: () => async (url, init) => {
            sent.push({ url, init });
            return { ok: true, status: 200 };
        },
        openExternal: async (url) => void events.push(`browser ${url}`),
        openPath: async (path) => void events.push(`openPath ${path}`),
        showMessage: (message) => void events.push(`message ${message.title}`),
        statusChanged: () => void events.push('statusChanged'),
        broadcast: (channel) => void events.push(`broadcast ${channel}`),
        ...overrides,
    };
    return { actions: new NextcloudActions(host), events, sent, logins: () => logins };
}

test('a new status is remembered, refreshes the tray and reaches the pages', () => {
    const { actions, events } = setup();
    actions.onStatus(status('/x'));
    assert.equal(actions.status.accounts.length, 1);
    assert.deepEqual(events, ['statusChanged', `broadcast ${EVENT.ncStatusChanged}`]);
});

test('refresh asks the bridge and logs a summary', async () => {
    const { actions, events } = setup();
    const result = await actions.refresh();
    assert.equal(result.installed, true);
    assert.match(events[0] ?? '', /^info /);
});

test('openFolder opens the first sync folder, or explains that there is none', async () => {
    const withFolder = setup();
    withFolder.actions.onStatus(status('/home/ada/Nextcloud'));
    withFolder.events.length = 0;
    await withFolder.actions.openFolder();
    assert.deepEqual(withFolder.events, ['openPath /home/ada/Nextcloud']);

    const without = setup();
    await without.actions.openFolder();
    assert.deepEqual(without.events, ['message No Nextcloud folder']);
});

test('pair logs in, keeps the password, hands it to the server through the window session', async () => {
    const t = setup();
    t.actions.onStatus(status());
    t.events.length = 0;
    const result = await t.actions.pair();
    assert.deepEqual(result, { ok: true, server: 'https://cloud.example', loginName: 'ada', storedOnServer: true });
    assert.deepEqual(t.logins(), ['https://cloud.example']);
    assert.ok(t.events.includes('browser https://cloud.example/login/v2/flow/abc'));
    assert.ok(t.events.includes('store app-pw'));
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0]?.url ?? '', /^https:\/\/bee\.example\//);
});

test('without a live main window the credential is not handed over', async () => {
    const t = setup({ mainSessionFetch: () => null });
    t.actions.onStatus(status());
    const result = await t.actions.pair();
    assert.deepEqual(result, { ok: true, server: 'https://cloud.example', loginName: 'ada', storedOnServer: false });
    assert.equal(t.sent.length, 0);
});

test('without a known Nextcloud pairing explains what to do', async () => {
    const t = setup();
    const result = await t.actions.pair();
    assert.equal(result.ok, false);
});
