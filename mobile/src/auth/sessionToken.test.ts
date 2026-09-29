/**
 * Tests for the SSO bridge token.
 *
 * Every case here is the shape of a real defect rather than a spec check:
 *
 *   - The token was claimed and then dropped, so single sign-on completed on
 *     the server and did nothing in the app. That is what `adoptSessionToken`
 *     installing a header on the NEXT request proves.
 *   - The server drops a bridge token after an hour and there is no cookie to
 *     fall back on, so a token that is never re-minted signs the user out
 *     mid-morning.
 *   - A token minted by one server being offered to another is a credential
 *     leak, not just a failed request.
 */

import * as SecureStore from 'expo-secure-store';

import {
    adoptSessionToken,
    clearSessionToken,
    currentSessionToken,
    isExpired,
    isStale,
    parseStored,
    primeSessionToken,
    refreshSessionToken,
    renewIfStale,
    staleAfter,
    BRIDGE_TTL_MS,
    MAX_TTL_MS,
    REFRESH_AFTER_MS,
} from './sessionToken';
import { api, getSessionToken } from '../api/client';
import { setServerUrl } from '../api/server';

const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }));

function jsonOnce(body: unknown, status = 200) {
    mockExpoFetch.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
    });
}

/** The headers the last request actually went out with. */
function lastHeaders(): Record<string, string> {
    const call = mockExpoFetch.mock.calls.at(-1) as [string, { headers: Record<string, string> }];
    return call[1].headers;
}

const SERVER = 'https://beeflow.example';

beforeEach(async () => {
    mockExpoFetch.mockReset();
    await setServerUrl(SERVER);
    await clearSessionToken();
});

describe('parseStored', () => {
    it('rejects anything that is not a usable entry', () => {
        expect(parseStored(null)).toBeNull();
        expect(parseStored('not json')).toBeNull();
        expect(parseStored('{}')).toBeNull();
        expect(parseStored(JSON.stringify({ token: 'a' }))).toBeNull();
        expect(parseStored(JSON.stringify({ server: SERVER }))).toBeNull();
        expect(parseStored(JSON.stringify({ token: '', server: SERVER, mintedAt: 1 }))).toBeNull();
    });

    it('treats a missing timestamp as ancient rather than fresh', () => {
        // The safe direction: an unknown age forces a refresh instead of being
        // trusted for another hour.
        const entry = parseStored(JSON.stringify({ token: 'a', server: SERVER }));
        expect(entry).not.toBeNull();
        expect(isStale(entry!)).toBe(true);
    });
});

describe('staleness', () => {
    const hourly = { token: 'a', server: SERVER, mintedAt: 1_000_000, ttlMs: BRIDGE_TTL_MS };
    const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
    const native = { token: 'a', server: SERVER, mintedAt: 1_000_000, ttlMs: THIRTY_DAYS };

    it('renews well before the server would drop the token', () => {
        expect(REFRESH_AFTER_MS).toBeLessThan(BRIDGE_TTL_MS / 2);
        expect(isStale(hourly, hourly.mintedAt + REFRESH_AFTER_MS - 1)).toBe(false);
        expect(isStale(hourly, hourly.mintedAt + REFRESH_AFTER_MS)).toBe(true);
        expect(isExpired(hourly, hourly.mintedAt + REFRESH_AFTER_MS)).toBe(false);
        expect(isExpired(hourly, hourly.mintedAt + BRIDGE_TTL_MS)).toBe(true);
    });

    it('leaves three chances to renew, whatever the TTL', () => {
        // The property the docstring promises. It has to hold for a 30-day
        // token as much as an hourly one, or a native client renews on a
        // schedule built for a different lifetime.
        expect(staleAfter(hourly)).toBe(BRIDGE_TTL_MS / 4);
        expect(staleAfter(native)).toBe(THIRTY_DAYS / 4);
    });

    it('does not treat a 30-day token as expired after an hour', () => {
        // The regression that would have signed every SSO user out anyway:
        // the server grants thirty days, the client hard-codes one hour, and
        // primeSessionToken throws away a token with 29 days left on it.
        expect(isExpired(native, native.mintedAt + BRIDGE_TTL_MS + 1)).toBe(false);
        expect(isStale(native, native.mintedAt + BRIDGE_TTL_MS + 1)).toBe(false);
        expect(isExpired(native, native.mintedAt + THIRTY_DAYS)).toBe(true);
    });

    it('assumes the old hour for an entry written before TTLs were stored', () => {
        const entry = parseStored(
            JSON.stringify({ token: 'a', server: SERVER, mintedAt: 1_000_000 }),
        );
        expect(entry!.ttlMs).toBe(BRIDGE_TTL_MS);
    });
});

describe('adoptSessionToken', () => {
    it('puts the token on every subsequent request', async () => {
        // The upgrade below fires first and finds no queued response, which is
        // the failure case on purpose: the pickup token must survive it.
        await adoptSessionToken('tok-1');
        expect(getSessionToken()).toBe('tok-1');

        mockExpoFetch.mockReset();
        jsonOnce({ ok: true });
        await api.get('/api/anything');
        expect(lastHeaders()['X-Session-Token']).toBe('tok-1');
    });

    it('survives a cold start', async () => {
        await adoptSessionToken('tok-1');
        // A relaunch: nothing in memory, everything in the keystore.
        await relaunch();
        expect(getSessionToken()).toBeNull();

        await primeSessionToken(SERVER);
        expect(getSessionToken()).toBe('tok-1');
    });

    it('is dropped when the app is pointed at a different server', async () => {
        await adoptSessionToken('tok-1');
        await setServerUrl('https://other.example');
        await primeSessionToken('https://other.example');
        expect(getSessionToken()).toBeNull();
        expect(currentSessionToken()).toBeNull();
    });
});

describe('adopting a pickup token trades it in immediately', () => {
    it('swaps the bridge hour for whatever the server grants a native client', async () => {
        const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
        jsonOnce({ token: 'tok-native', expiresIn: THIRTY_DAYS / 1000 });

        await adoptSessionToken('tok-pickup');

        // Why this matters: the OAuth callback deposits the generic one-hour
        // token. Sign in, close the app, come back after lunch and that token
        // is gone — which is exactly the sign-out being fixed. The upgrade has
        // to happen at sign-in, not at the next staleness check fifteen
        // minutes later, because the app may not be open in fifteen minutes.
        expect(getSessionToken()).toBe('tok-native');
        expect(currentSessionToken()?.ttlMs).toBe(THIRTY_DAYS);
    });

    it('keeps the pickup token when the upgrade cannot be made', async () => {
        jsonOnce({ error: 'boom' }, 500);
        await adoptSessionToken('tok-pickup');
        expect(getSessionToken()).toBe('tok-pickup');
        expect(currentSessionToken()?.ttlMs).toBe(BRIDGE_TTL_MS);
    });
});

describe('refreshSessionToken', () => {
    it('mints a replacement and installs it', async () => {
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();
        jsonOnce({ token: 'tok-2' });

        await expect(refreshSessionToken()).resolves.toBe(true);
        expect(getSessionToken()).toBe('tok-2');
        // Minted THROUGH the old token — that is what makes the bridge roll
        // forward without another trip to the identity provider.
        expect(mockExpoFetch.mock.calls[0]?.[0]).toContain('/api/session-token');
    });

    it('clears the token when the server will not mint one', async () => {
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();
        jsonOnce({ error: 'Not authenticated' }, 401);

        await expect(refreshSessionToken()).resolves.toBe(false);
        expect(getSessionToken()).toBeNull();
    });

    it('KEEPS the token when the network fails — the sign-out this fixes', async () => {
        // The old code cleared on any throw. A ten-second timeout on a train
        // destroyed a token with fifty minutes left on it, and the promise of
        // "three chances to renew" was never kept: the first failure was
        // fatal. A transport failure says nothing about the session.
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();
        mockExpoFetch.mockRejectedValueOnce(new TypeError('Network request failed'));

        await expect(refreshSessionToken()).resolves.toBe(false);
        expect(getSessionToken()).toBe('tok-1');
    });

    it('keeps the token through a 403 — entitlement is not identity', async () => {
        // A 403 on this route is a licence gate, a proxy or a WAF answering.
        // Treating it as "your session is over" would destroy a token that had
        // just been claimed and was working perfectly.
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();
        jsonOnce({ error: 'Forbidden' }, 403);

        await expect(refreshSessionToken()).resolves.toBe(false);
        expect(getSessionToken()).toBe('tok-1');
    });

    it('clamps an absurd expiresIn to the longest lifetime worth believing', async () => {
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();
        jsonOnce({ token: 'tok-2', expiresIn: 60 * 60 * 24 * 365 * 100 });

        await expect(refreshSessionToken()).resolves.toBe(true);
        expect(currentSessionToken()?.ttlMs).toBe(MAX_TTL_MS);
    });

    it('does not resurrect a token cleared while the request was in flight', async () => {
        // Sign out mid-refresh. Installing the replacement afterwards would
        // sign the user back in behind their own back.
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();
        mockExpoFetch.mockImplementationOnce(async () => {
            await clearSessionToken();
            return {
                ok: true,
                status: 200,
                headers: { get: () => 'application/json' },
                json: async () => ({ token: 'tok-zombie', expiresIn: 3600 }),
            };
        });

        await expect(refreshSessionToken()).resolves.toBe(false);
        expect(getSessionToken()).toBeNull();
        expect(currentSessionToken()).toBeNull();
    });

    it('keeps the token through a 500 — a deploy is not a logout', async () => {
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();
        jsonOnce({ error: 'bad gateway' }, 502);

        await expect(refreshSessionToken()).resolves.toBe(false);
        expect(getSessionToken()).toBe('tok-1');
    });
});

describe('renewIfStale', () => {
    it('says nothing to the server while the token is young', async () => {
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();

        await renewIfStale();
        expect(mockExpoFetch).not.toHaveBeenCalled();
        expect(getSessionToken()).toBe('tok-1');
    });

    it('renews once the token is stale', async () => {
        await adoptSessionToken('tok-1');
        await relaunch(REFRESH_AFTER_MS + 1);
        await primeSessionToken(SERVER).catch(() => undefined);
        mockExpoFetch.mockReset();
        jsonOnce({ token: 'tok-3', expiresIn: 3600 });

        await renewIfStale();
        expect(getSessionToken()).toBe('tok-3');
    });

    it('does nothing without a token — a password session must not be touched', async () => {
        await expect(refreshSessionToken()).resolves.toBe(false);
        expect(mockExpoFetch).not.toHaveBeenCalled();
    });
});

describe('primeSessionToken', () => {
    it('renews a stale token before the first real request', async () => {
        await adoptSessionToken('tok-1');
        await relaunch(REFRESH_AFTER_MS + 1);
        mockExpoFetch.mockReset();
        jsonOnce({ token: 'tok-2' });

        await primeSessionToken(SERVER);
        expect(getSessionToken()).toBe('tok-2');
    });

    it('does not spend a request on a token that is still young', async () => {
        await adoptSessionToken('tok-1');
        mockExpoFetch.mockReset();
        await primeSessionToken(SERVER);
        expect(mockExpoFetch).not.toHaveBeenCalled();
        expect(getSessionToken()).toBe('tok-1');
    });

    it('discards an expired token instead of asking the server about it', async () => {
        await adoptSessionToken('tok-1');
        await relaunch(BRIDGE_TTL_MS + 1);
        mockExpoFetch.mockReset();

        await primeSessionToken(SERVER);
        expect(getSessionToken()).toBeNull();
        expect(mockExpoFetch).not.toHaveBeenCalled();
    });
});

// ── Simulating the two things a test cannot wait for ─────────────────────────
// The module caches the entry in memory (staleness has to be a synchronous
// check), so both a relaunch and the passage of an hour have to be staged
// through the keystore. `clearSessionToken` drops BOTH halves; writing the
// stored half back afterwards leaves exactly the state of a cold start.

const STORE_KEY = 'beeflow.auth.sessionToken';

async function relaunch(ageMs = 0): Promise<void> {
    const raw = await SecureStore.getItemAsync(STORE_KEY);
    const stored = JSON.parse(raw as string) as { mintedAt: number; ttlMs: number };
    stored.mintedAt -= ageMs;
    await clearSessionToken();
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(stored));
}
