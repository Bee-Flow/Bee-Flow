import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INVOKE } from '../../shared/ipc.ts';
import type { SenderTrust } from '../security/policy.ts';
import { CHANNEL_TRUST, RefusedError, gatedHandle, isAllowed, requiredTrust, type GateEvent } from './trust.ts';

type Listener = (event: GateEvent, ...args: unknown[]) => unknown;

/** A stand-in for Electron's ipcMain that records what was registered. */
function stubIpcMain() {
    const listeners = new Map<string, Listener>();
    return {
        listeners,
        handle(channel: string, listener: Listener) {
            assert.ok(!listeners.has(channel), `${channel} registered twice`);
            listeners.set(channel, listener);
        },
    };
}

const URL_OF: Record<SenderTrust, string> = {
    shell: 'file:///app/shell/settings.html',
    server: 'https://bee.example.com/app',
    other: 'https://idp.example.org/login',
};

/** Register a recording body for every channel through the gate, as handlers.ts does. */
function registerAll() {
    const ipcMain = stubIpcMain();
    const warnings: string[] = [];
    const ran: string[] = [];
    const handle = gatedHandle<GateEvent>({
        ipcMain,
        trustOf: (event) => (Object.keys(URL_OF) as SenderTrust[]).find((trust) => URL_OF[trust] === event.senderFrame?.url) ?? 'other',
        log: { warn: (_scope, message) => warnings.push(message) },
    });
    for (const channel of Object.values(INVOKE)) {
        handle(channel, () => {
            ran.push(channel);
            return 'ok';
        });
    }
    const invoke = (channel: string, trust: SenderTrust | null, ...args: unknown[]) => {
        const listener = ipcMain.listeners.get(channel);
        assert.ok(listener, `${channel} was not registered`);
        return Promise.resolve(listener(trust ? { senderFrame: { url: URL_OF[trust] } } : { senderFrame: null }, ...args));
    };
    return { ipcMain, warnings, ran, invoke };
}

describe('CHANNEL_TRUST', () => {
    it('classifies every invoke channel, and nothing else', () => {
        assert.deepEqual(Object.keys(CHANNEL_TRUST).sort(), Object.keys(INVOKE).sort());
        for (const channel of Object.values(INVOKE)) assert.ok(requiredTrust(channel), channel);
        assert.equal(requiredTrust('app:not-a-channel'), undefined);
    });

    it('maps every channel name to exactly one key', () => {
        const names = Object.values(INVOKE);
        assert.equal(new Set(names).size, names.length);
    });

    it('keeps the privileged channels shell-only', () => {
        for (const key of ['relaunch', 'settingsPatch', 'serverProbe', 'serverSet', 'serverForget', 'serverChoose', 'updateInstall', 'ncWatchUpdate', 'ncWatchRemove'] as const) {
            assert.equal(CHANNEL_TRUST[key], 'shell', key);
        }
    });
});

describe('isAllowed', () => {
    it('lets the shell do everything, the server only trusted work, and others nothing', () => {
        assert.equal(isAllowed('shell', 'shell'), true);
        assert.equal(isAllowed('shell', 'server'), false);
        assert.equal(isAllowed('shell', 'other'), false);
        assert.equal(isAllowed('trusted', 'shell'), true);
        assert.equal(isAllowed('trusted', 'server'), true);
        assert.equal(isAllowed('trusted', 'other'), false);
    });
});

describe('gatedHandle', () => {
    it('registers every channel', () => {
        const { ipcMain } = registerAll();
        assert.deepEqual([...ipcMain.listeners.keys()].sort(), Object.values(INVOKE).sort());
    });

    it('refuses a sender of "other" trust on every channel, before the body runs', async () => {
        const { invoke, ran, warnings } = registerAll();
        for (const channel of Object.values(INVOKE)) {
            await assert.rejects(invoke(channel, 'other'), RefusedError, channel);
            await assert.rejects(invoke(channel, null), RefusedError, `${channel} from an unknown frame`);
        }
        assert.deepEqual(ran, []);
        assert.ok(warnings.every((line) => line.startsWith('refused ')));
        assert.equal(warnings.length, Object.values(INVOKE).length * 2);
    });

    it('refuses the server page on shell-only channels and lets it through on the rest', async () => {
        const { invoke, ran } = registerAll();
        for (const [key, channel] of Object.entries(INVOKE) as Array<[keyof typeof INVOKE, string]>) {
            if (CHANNEL_TRUST[key] === 'shell') await assert.rejects(invoke(channel, 'server'), RefusedError, channel);
            else assert.equal(await invoke(channel, 'server'), 'ok');
        }
        assert.deepEqual(
            ran.sort(),
            (Object.entries(INVOKE) as Array<[keyof typeof INVOKE, string]>)
                .filter(([key]) => CHANNEL_TRUST[key] === 'trusted')
                .map(([, channel]) => channel)
                .sort(),
        );
    });

    it('lets our own pages call every channel and passes the arguments through', async () => {
        const ipcMain = stubIpcMain();
        const handle = gatedHandle<GateEvent>({ ipcMain, trustOf: () => 'shell', log: { warn: () => {} } });
        handle(INVOKE.serverSet, (_event, url: string) => `set ${url}`);
        assert.equal(await ipcMain.listeners.get(INVOKE.serverSet)?.({ senderFrame: { url: URL_OF.shell } }, 'https://b.example'), 'set https://b.example');
    });

    it('logs and rethrows a failure inside a handler', async () => {
        const ipcMain = stubIpcMain();
        const warnings: string[] = [];
        const handle = gatedHandle<GateEvent>({ ipcMain, trustOf: () => 'shell', log: { warn: (_scope, message) => warnings.push(message) } });
        handle(INVOKE.relaunch, () => {
            throw new Error('boom');
        });
        await assert.rejects(Promise.resolve(ipcMain.listeners.get(INVOKE.relaunch)?.({ senderFrame: { url: URL_OF.shell } })), /boom/);
        assert.deepEqual(warnings, ['app:relaunch failed: boom']);
    });

    it('refuses to register a channel that has no trust entry', () => {
        const handle = gatedHandle<GateEvent>({ ipcMain: stubIpcMain(), trustOf: () => 'shell', log: { warn: () => {} } });
        assert.throws(() => handle('app:not-a-channel' as never, () => undefined), /no entry in CHANNEL_TRUST/);
    });
});
