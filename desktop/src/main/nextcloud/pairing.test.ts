import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_PAIRING_TARGET, pairingTarget, pairNextcloud, sendAppPasswordToServer, type PairingDeps, type SessionFetch } from './pairing.ts';
import type { LoginFlowCredential } from './loginFlow.ts';

const credential: LoginFlowCredential = { server: 'https://cloud.example.com', loginName: 'ada', appPassword: 'app-pw-123' };

function recorder() {
    const lines: string[] = [];
    return {
        lines,
        log: {
            info: (scope: string, message: string) => lines.push(`info ${scope}: ${message}`),
            warn: (scope: string, message: string) => lines.push(`warn ${scope}: ${message}`),
        },
    };
}

function deps(overrides: Partial<PairingDeps> = {}) {
    const { lines, log } = recorder();
    const calls: string[] = [];
    const base: PairingDeps = {
        login: async (target) => {
            calls.push(`login ${target}`);
            return credential;
        },
        persistAppPassword: async (password) => {
            calls.push(`persist ${password}`);
            return true;
        },
        sendToServer: async (sent) => {
            calls.push(`send ${sent.loginName}`);
            return true;
        },
        log,
    };
    return { deps: { ...base, ...overrides }, calls, lines };
}

describe('pairingTarget', () => {
    it('takes the hint, then the first known account, then nothing', () => {
        assert.equal(pairingTarget('https://asked.example.com', [{ url: 'https://known.example.com' }]), 'https://asked.example.com');
        assert.equal(pairingTarget(undefined, [{ url: 'https://known.example.com' }]), 'https://known.example.com');
        assert.equal(pairingTarget('', []), '');
    });
});

describe('pairNextcloud', () => {
    it('asks for an address before starting without one', async () => {
        const { deps: injected, calls } = deps();
        assert.deepEqual(await pairNextcloud('', injected), { ok: false, error: NO_PAIRING_TARGET });
        assert.deepEqual(calls, []);
    });

    it('logs in, keeps the password, hands it to the server, in that order', async () => {
        const { deps: injected, calls, lines } = deps();
        assert.deepEqual(await pairNextcloud('https://cloud.example.com', injected), {
            ok: true,
            server: 'https://cloud.example.com',
            loginName: 'ada',
            storedOnServer: true,
        });
        assert.deepEqual(calls, ['login https://cloud.example.com', 'persist app-pw-123', 'send ada']);
        assert.deepEqual(lines, ['info Nextcloud: linked ada at https://cloud.example.com']);
    });

    it('carries on without the keyring, and says so', async () => {
        const { deps: injected, lines } = deps({ persistAppPassword: async () => false, sendToServer: async () => false });
        const result = await pairNextcloud('https://cloud.example.com', injected);
        assert.deepEqual(result, { ok: true, server: 'https://cloud.example.com', loginName: 'ada', storedOnServer: false });
        assert.ok(lines.includes('warn Nextcloud: the app password is held for this session only'));
    });

    it('turns a failed login into an answer, never a throw', async () => {
        const { deps: injected, calls, lines } = deps({
            login: async () => {
                throw new Error('The sign-in timed out.');
            },
        });
        assert.deepEqual(await pairNextcloud('https://cloud.example.com', injected), { ok: false, error: 'The sign-in timed out.' });
        assert.deepEqual(calls, []);
        assert.deepEqual(lines, ['warn Nextcloud: pairing failed: The sign-in timed out.']);
    });
});

describe('sendAppPasswordToServer', () => {
    it('posts the credential to the server as the desktop client', async () => {
        const requests: Array<{ url: string; init: Parameters<SessionFetch>[1] }> = [];
        const fetch: SessionFetch = async (url, init) => {
            requests.push({ url, init });
            return { ok: true, status: 200 };
        };
        const { log } = recorder();
        assert.equal(await sendAppPasswordToServer(credential, 'https://bee.example.com', fetch, log), true);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.url, 'https://bee.example.com/auth/save-app-password');
        assert.equal(requests[0]?.init.method, 'POST');
        assert.deepEqual(requests[0]?.init.headers, { 'Content-Type': 'application/json', 'X-Beeflow-Client': 'desktop' });
        assert.deepEqual(JSON.parse(requests[0]?.init.body ?? ''), { username: 'ada', password: 'app-pw-123', url: 'https://cloud.example.com' });
    });

    it('reports a refusal and an unreachable server as false, with a log line', async () => {
        const { lines, log } = recorder();
        assert.equal(await sendAppPasswordToServer(credential, 'https://bee.example.com', async () => ({ ok: false, status: 403 }), log), false);
        assert.equal(
            await sendAppPasswordToServer(
                credential,
                'https://bee.example.com',
                async () => {
                    throw new Error('offline');
                },
                log,
            ),
            false,
        );
        assert.deepEqual(lines, [
            'warn Nextcloud: the Bee Flow server refused the app password (HTTP 403)',
            'warn Nextcloud: could not reach the Bee Flow server to store the app password: Error: offline',
        ]);
    });
});
