import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchServerNextcloudUrl, INVALID_PAIRING_ADDRESS, NO_PAIRING_TARGET, parseNextcloudUrl, pairNextcloud, resolvePairingTarget, sendAppPasswordToServer, type PairingDeps, type SessionFetch } from './pairing.ts';
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

describe('parseNextcloudUrl', () => {
    it('accepts https, adds https to a bare host, drops query, hash and trailing slash', () => {
        assert.equal(parseNextcloudUrl('https://cloud.example.com/'), 'https://cloud.example.com');
        assert.equal(parseNextcloudUrl(' cloud.example.com/nextcloud/?a=1#x '), 'https://cloud.example.com/nextcloud');
    });
    it('accepts http only for this computer and private networks', () => {
        assert.equal(parseNextcloudUrl('http://localhost:8080'), 'http://localhost:8080');
        assert.equal(parseNextcloudUrl('http://192.168.1.5/nc'), 'http://192.168.1.5/nc');
        assert.equal(parseNextcloudUrl('http://cloud.example.com'), null);
    });
    it('rejects other schemes, credentials, empty and non-text input', () => {
        for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://cloud.example.com', 'https://user:pw@cloud.example.com', '', '   ', 'https://', 42, null, undefined]) {
            assert.equal(parseNextcloudUrl(bad), null, String(bad));
        }
    });
});

describe('resolvePairingTarget', () => {
    const accounts = [{ url: 'https://known.example.com' }];
    const server = async () => 'https://server.example.com';

    it('takes the hint first', async () => {
        assert.deepEqual(await resolvePairingTarget('asked.example.com', accounts, '', server), { ok: true, url: 'https://asked.example.com', source: 'hint' });
    });
    it('does not fall back when the hint is unusable', async () => {
        assert.deepEqual(await resolvePairingTarget('javascript:alert(1)', accounts, '', server), { ok: false, error: INVALID_PAIRING_ADDRESS });
    });
    it('then the first usable desktop-client account', async () => {
        assert.deepEqual(await resolvePairingTarget(undefined, [{ url: 'ftp://x' }, ...accounts], '', server), { ok: true, url: 'https://known.example.com', source: 'desktop-client' });
    });
    it('then the address saved in Settings, before the server lookup', async () => {
        let asked = false;
        const spy = async () => ((asked = true), 'https://server.example.com');
        assert.deepEqual(await resolvePairingTarget(undefined, [], 'cloud.example.org/', spy), { ok: true, url: 'https://cloud.example.org', source: 'saved' });
        assert.equal(asked, false);
        assert.deepEqual(await resolvePairingTarget(undefined, accounts, 'cloud.example.org', spy), { ok: true, url: 'https://known.example.com', source: 'desktop-client' });
        assert.deepEqual(await resolvePairingTarget(undefined, [], 'ftp://bad', server), { ok: true, url: 'https://server.example.com', source: 'server' });
    });
    it('then the Nextcloud of the Bee Flow server', async () => {
        assert.deepEqual(await resolvePairingTarget('', [], '', server), { ok: true, url: 'https://server.example.com', source: 'server' });
    });
    it('rejects an unusable or failing server answer and then has no target', async () => {
        const none = { ok: false, error: NO_PAIRING_TARGET };
        assert.deepEqual(await resolvePairingTarget(undefined, [], '', async () => 'http://public.example.com'), none);
        assert.deepEqual(await resolvePairingTarget(undefined, [], '', async () => null), none);
        assert.deepEqual(await resolvePairingTarget(undefined, [], '', async () => Promise.reject(new Error('x'))), none);
    });
    it('does not ask the server when an earlier source answered', async () => {
        let asked = false;
        await resolvePairingTarget(undefined, accounts, '', async () => ((asked = true), null));
        assert.equal(asked, false);
    });
});

describe('fetchServerNextcloudUrl', () => {
    const log = { warn: () => undefined };
    it('reads nextcloudUrl from the status endpoint over the session', async () => {
        const seen: string[] = [];
        const url = await fetchServerNextcloudUrl('https://bee.example', async (u, init) => {
            seen.push(`${init.method} ${u} ${init.credentials}`);
            return { ok: true, status: 200, json: async () => ({ hasAppPassword: true, nextcloudUrl: 'https://cloud.example.com' }) };
        }, log);
        assert.equal(url, 'https://cloud.example.com');
        assert.deepEqual(seen, ['GET https://bee.example/auth/app-password-status include']);
    });
    it('is null on an empty url, a refusal or a network error', async () => {
        assert.equal(await fetchServerNextcloudUrl('https://bee.example', async () => ({ ok: true, status: 200, json: async () => ({ nextcloudUrl: '' }) }), log), null);
        assert.equal(await fetchServerNextcloudUrl('https://bee.example', async () => ({ ok: false, status: 401 }), log), null);
        assert.equal(await fetchServerNextcloudUrl('https://bee.example', async () => Promise.reject(new Error('down')), log), null);
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
        assert.equal(requests[0]?.init.credentials, 'include', 'without it the session cookie stays home and the server answers 401');
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
