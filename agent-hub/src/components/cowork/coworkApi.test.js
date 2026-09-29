/**
 * Characterisation of coworkApi — the wire contract of the Cowork surface.
 *
 * Pinned here because CW-11 adds a stats route next to these calls: the URLs,
 * the methods, the headers, the exact shape of the body that leaves, and the
 * translation of the server's `{schedules, maxSchedules}` into the
 * `{items, maxItems}` every caller reads. Warts are pinned as warts.
 *
 * Run: cd agent-hub && npx vitest run src/components/cowork/coworkApi.test.js
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

import {
    listCowork, createCowork, updateCowork, toggleCowork, runCoworkNow,
    deleteCowork, composeCowork, listCoworkRuns, listCoworkAgents, getCoworkStats,
} from './coworkApi';

/** A 2xx response whose json() yields `body`. */
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
/** A non-2xx response whose json() yields `body`. */
const fail = (status, body) => ({ ok: false, status, json: async () => body });
/** A response whose body is not JSON at all (an HTML error page, a 502). */
const notJson = (isOk = false) => ({
    ok: isOk,
    status: isOk ? 200 : 502,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
});

/** Run `fn` with a stubbed browser timezone. */
async function withBrowserTimezone(timeZone, fn) {
    const spy = vi.spyOn(Intl, 'DateTimeFormat')
        .mockImplementation(() => ({ resolvedOptions: () => ({ timeZone }) }));
    try {
        return await fn();
    } finally {
        spy.mockRestore();
    }
}

const url = (call = 0) => authFetch.mock.calls[call][0];
const init = (call = 0) => authFetch.mock.calls[call][1];
const sentBody = (call = 0) => JSON.parse(init(call).body);

beforeEach(() => { authFetch.mockReset(); });

describe('listCowork', () => {
    it('GETs /api/cowork with no options at all — no method, no headers', async () => {
        authFetch.mockResolvedValue(ok({ schedules: [], maxSchedules: 10 }));
        await listCowork();
        expect(authFetch).toHaveBeenCalledWith('https://host.example/api/cowork');
    });

    it('renames the server\'s schedules/maxSchedules into items/maxItems', async () => {
        authFetch.mockResolvedValue(ok({ schedules: [{ id: 'w1' }, { id: 'w2' }], maxSchedules: 25 }));
        expect(await listCowork()).toEqual({ items: [{ id: 'w1' }, { id: 'w2' }], maxItems: 25 });
    });

    it('falls back to an empty list and a ceiling of 10 when the server says neither', async () => {
        authFetch.mockResolvedValue(ok({}));
        expect(await listCowork()).toEqual({ items: [], maxItems: 10 });
    });

    it('turns a server ceiling of 0 into 10 (wart: `||` cannot tell "no slots" from "not sent")', async () => {
        // A workspace whose quota really is zero is handed the default instead,
        // so the page shows ten free slots and lets the create call 4xx.
        authFetch.mockResolvedValue(ok({ schedules: [], maxSchedules: 0 }));
        expect((await listCowork()).maxItems).toBe(10);
    });

    it('throws the server\'s own error message when it sends one', async () => {
        authFetch.mockResolvedValue(fail(403, { error: 'Your licence does not include cowork' }));
        await expect(listCowork()).rejects.toThrow('Your licence does not include cowork');
    });

    it('falls back to a hard-coded English sentence when the body has no error (wart: untranslated)', async () => {
        authFetch.mockResolvedValue(fail(500, {}));
        await expect(listCowork()).rejects.toThrow('Could not load your work');
        authFetch.mockResolvedValue(notJson());
        await expect(listCowork()).rejects.toThrow('Could not load your work');
    });
});

describe('createCowork', () => {
    it('POSTs the payload as JSON to /api/cowork', async () => {
        authFetch.mockResolvedValue(ok({ id: 'new' }));
        const payload = { title: 'Weekly digest', prompt: 'Summarise', repeatInterval: 'weekly' };

        expect(await createCowork(payload)).toEqual({ id: 'new' });
        expect(url()).toBe('https://host.example/api/cowork');
        expect(init()).toEqual({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    });

    it('forwards whatever the caller put on the object — there is no allow-list (wart)', async () => {
        authFetch.mockResolvedValue(ok({ id: 'new' }));
        await createCowork({ title: 'x', prompt: 'y', internalNote: 'not part of the API' });
        expect(sentBody()).toEqual({ title: 'x', prompt: 'y', internalNote: 'not part of the API' });
    });

    it('reports a create failure with the server\'s message, or the English fallback', async () => {
        authFetch.mockResolvedValue(fail(400, { error: 'Maximum number of cowork items reached (10).' }));
        await expect(createCowork({})).rejects.toThrow('Maximum number of cowork items reached (10).');
        authFetch.mockResolvedValue(fail(500, {}));
        await expect(createCowork({})).rejects.toThrow('Could not create this work');
    });

    it('lets a JSON parse error escape raw on a 2xx (wart: only the error path is guarded)', async () => {
        // The `.catch(() => ({}))` sits in readError, so a 200 with a truncated
        // body rejects with the parser's own words instead of a usable message.
        authFetch.mockResolvedValue(notJson(true));
        await expect(createCowork({})).rejects.toThrow(/Unexpected token/);
    });
});

describe('updateCowork', () => {
    it('PUTs the patch to /api/cowork/<id>', async () => {
        authFetch.mockResolvedValue(ok({ success: true }));
        await updateCowork('w1', { title: 'Monthly digest' });
        expect(url()).toBe('https://host.example/api/cowork/w1');
        expect(init()).toEqual({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Monthly digest' }),
        });
    });

    it('escapes the id instead of pasting it into the path', async () => {
        authFetch.mockResolvedValue(ok({}));
        await updateCowork('../users/42', {});
        // Used to be '/api/cowork/../users/42', which the browser resolved to
        // /api/users/42 before the request ever left.
        expect(url()).toBe('https://host.example/api/cowork/..%2Fusers%2F42');
        await updateCowork('w1?admin=1', {});
        expect(url(1)).toBe('https://host.example/api/cowork/w1%3Fadmin%3D1');
    });

    it('uses its own English fallback message', async () => {
        authFetch.mockResolvedValue(fail(500, {}));
        await expect(updateCowork('w1', {})).rejects.toThrow('Could not save this work');
    });
});

describe('toggleCowork / runCoworkNow / deleteCowork', () => {
    it('POSTs to /toggle with a method and nothing else — no headers, no body', async () => {
        authFetch.mockResolvedValue(ok({ success: true, isActive: false }));
        expect(await toggleCowork('w1')).toEqual({ success: true, isActive: false });
        expect(url()).toBe('https://host.example/api/cowork/w1/toggle');
        expect(init()).toEqual({ method: 'POST' });
    });

    it('POSTs to /run-now the same bodyless way', async () => {
        authFetch.mockResolvedValue(ok({ success: true }));
        await runCoworkNow('w1');
        expect(url()).toBe('https://host.example/api/cowork/w1/run-now');
        expect(init()).toEqual({ method: 'POST' });
    });

    it('DELETEs /api/cowork/<id>', async () => {
        authFetch.mockResolvedValue(ok({ success: true }));
        await deleteCowork('w1');
        expect(url()).toBe('https://host.example/api/cowork/w1');
        expect(init()).toEqual({ method: 'DELETE' });
    });

    it('each carries its own English failure sentence', async () => {
        authFetch.mockResolvedValue(fail(500, {}));
        await expect(toggleCowork('w1')).rejects.toThrow('Could not pause/resume this work');
        await expect(runCoworkNow('w1')).rejects.toThrow('Could not start this work');
        await expect(deleteCowork('w1')).rejects.toThrow('Could not delete this work');
    });
});

describe('the id never leaves its own path segment', () => {
    // The ids in play today all come from our own list response, so none of
    // this is reachable from outside. The property is pinned at the place the
    // URL is built rather than at the caller, because the next route added
    // beside these inherits the guard only if it lives here.

    /** Every call that puts an id in the path, plus the sub-path it appends. */
    const idCalls = [
        ['updateCowork', (id) => updateCowork(id, {}), null],
        ['toggleCowork', (id) => toggleCowork(id), 'toggle'],
        ['runCoworkNow', (id) => runCoworkNow(id), 'run-now'],
        ['deleteCowork', (id) => deleteCowork(id), null],
        ['listCoworkRuns', (id) => listCoworkRuns(id), 'runs'],
    ];

    /** Ids that would each mean something else if pasted into a URL raw. */
    const hostileIds = [
        '../users/42',        // climbs out of /api/cowork
        '..%2Fusers%2F42',    // pre-encoded, so a single decode still climbs
        'w1/../../admin',     // climbs from deeper in
        'w1?admin=1',         // grafts on a query string
        'w1#/elsewhere',      // cuts the path short with a fragment
        'w1&limit=9999',      // extra parameter, once a query exists
        'a b',                // a raw space, which is not a legal URL character
        'ïd-ünicode',         // non-ASCII, to prove nothing else is mangled
    ];

    /** The parts of the URL a call sent, as the browser would read them. */
    const partsOfSentUrl = (call = 0) => {
        const parsed = new URL(url(call));
        expect(parsed.origin).toBe('https://host.example');
        expect(parsed.pathname.startsWith('/api/cowork/')).toBe(true);
        return {
            segments: parsed.pathname.slice('/api/cowork/'.length).split('/'),
            search: parsed.search,
        };
    };

    for (const [name, call, suffix] of idCalls) {
        it(`${name} keeps a hostile id inside /api/cowork/<id>`, async () => {
            for (const id of hostileIds) {
                authFetch.mockReset();
                authFetch.mockResolvedValue(ok({}));
                await call(id);

                const { segments, search } = partsOfSentUrl();
                // One segment for the id, one more for the sub-path — never a
                // third, and never a shorter path than that.
                expect(segments).toHaveLength(suffix ? 2 : 1);
                if (suffix) expect(segments[1]).toBe(suffix);
                // The server reads back exactly the id we were handed.
                expect(decodeURIComponent(segments[0])).toBe(id);
                // Only listCoworkRuns has a query string, and it is its own.
                expect(search).toBe(suffix === 'runs' ? '?limit=25&offset=0' : '');
            }
        });
    }

    it('leaves an ordinary id readable — the escaping is not blanket encoding', async () => {
        authFetch.mockResolvedValue(ok({}));
        await toggleCowork('w1');
        expect(url()).toBe('https://host.example/api/cowork/w1/toggle');
    });
});

describe('composeCowork', () => {
    it('POSTs the brief plus the browser timezone to /api/cowork/compose', async () => {
        authFetch.mockResolvedValue(ok({ title: 'Weekly digest' }));
        await withBrowserTimezone('Europe/Amsterdam', () => composeCowork('elke maandag een samenvatting'));

        expect(url()).toBe('https://host.example/api/cowork/compose');
        expect(init().method).toBe('POST');
        expect(init().headers).toEqual({ 'Content-Type': 'application/json' });
        expect(sentBody()).toEqual({
            brief: 'elke maandag een samenvatting',
            timezone: 'Europe/Amsterdam',
        });
    });

    it('lets an explicitly passed timezone win over the browser\'s', async () => {
        authFetch.mockResolvedValue(ok({}));
        await withBrowserTimezone('Europe/Amsterdam', () => composeCowork('x', { timezone: 'Pacific/Auckland' }));
        expect(sentBody().timezone).toBe('Pacific/Auckland');
    });

    it('treats an empty timezone as "not given" and falls back (wart: `||`, not `??`)', async () => {
        authFetch.mockResolvedValue(ok({}));
        await withBrowserTimezone('Europe/Amsterdam', () => composeCowork('x', { timezone: '' }));
        expect(sentBody().timezone).toBe('Europe/Amsterdam');
    });

    it('falls back to UTC when the browser cannot name its timezone', async () => {
        authFetch.mockResolvedValue(ok({}));
        await withBrowserTimezone(undefined, () => composeCowork('x'));
        expect(sentBody().timezone).toBe('UTC');
    });

    it('sends no brief key at all when the brief is undefined (wart: no validation before the call)', async () => {
        authFetch.mockResolvedValue(ok({}));
        await withBrowserTimezone('UTC', () => composeCowork(undefined));
        expect(sentBody()).toEqual({ timezone: 'UTC' });
        expect(Object.keys(sentBody())).not.toContain('brief');
    });

    it('reports a compose failure in English', async () => {
        authFetch.mockResolvedValue(fail(500, {}));
        await expect(composeCowork('x')).rejects.toThrow('Could not work out what to schedule');
    });
});

describe('listCoworkRuns', () => {
    it('GETs /runs with limit=25 and offset=0 by default, in that order', async () => {
        authFetch.mockResolvedValue(ok({ runs: [], total: 0 }));
        await listCoworkRuns('w1');
        expect(authFetch).toHaveBeenCalledWith('https://host.example/api/cowork/w1/runs?limit=25&offset=0');
    });

    it('passes a caller\'s paging through as strings', async () => {
        authFetch.mockResolvedValue(ok({ runs: [], total: 0 }));
        await listCoworkRuns('w1', { limit: 5, offset: 10 });
        expect(url()).toBe('https://host.example/api/cowork/w1/runs?limit=5&offset=10');
    });

    it('returns runs and total, defaulting both when the server omits them', async () => {
        authFetch.mockResolvedValue(ok({ runs: [{ id: 'r1' }], total: 7 }));
        expect(await listCoworkRuns('w1')).toEqual({ runs: [{ id: 'r1' }], total: 7 });
        authFetch.mockResolvedValue(ok({}));
        expect(await listCoworkRuns('w1')).toEqual({ runs: [], total: 0 });
    });

    it('reports a history failure in English', async () => {
        authFetch.mockResolvedValue(fail(404, {}));
        await expect(listCoworkRuns('w1')).rejects.toThrow('Could not load the run history');
    });
});

describe('listCoworkAgents', () => {
    it('reads /agents/all — the shared agent list, NOT an /api/cowork route', async () => {
        authFetch.mockResolvedValue(ok([{ id: 'a1', name: 'Scout' }]));
        expect(await listCoworkAgents()).toEqual([{ id: 'a1', name: 'Scout' }]);
        expect(authFetch).toHaveBeenCalledWith('https://host.example/agents/all');
    });

    it('unwraps an { agents: [...] } envelope as well as a bare array', async () => {
        authFetch.mockResolvedValue(ok({ agents: [{ id: 'a1' }] }));
        expect(await listCoworkAgents()).toEqual([{ id: 'a1' }]);
        authFetch.mockResolvedValue(ok({}));
        expect(await listCoworkAgents()).toEqual([]);
    });

    it('swallows every failure into an empty list — a 401 looks exactly like "beta is off" (wart/security)', async () => {
        // The picker simply disappears. There is no error, no retry and no
        // sign that the session expired rather than the feature being absent.
        for (const status of [401, 403, 500]) {
            authFetch.mockResolvedValue(fail(status, { error: 'Session expired' }));
            expect(await listCoworkAgents()).toEqual([]);
        }
        authFetch.mockResolvedValue(notJson(true));
        expect(await listCoworkAgents()).toEqual([]);
    });

    it('rejects when the network itself is down — the one failure it does not swallow (wart: no catch around authFetch)', async () => {
        // The only path that is NOT swallowed: a thrown fetch. Callers all wrap
        // this in their own .catch(), which is why nobody has noticed.
        authFetch.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(listCoworkAgents()).rejects.toThrow('Failed to fetch');
    });
});

describe('getCoworkStats', () => {
    it('GETs /stats for one item, with the id escaped like every other item URL', async () => {
        authFetch.mockResolvedValue(ok({}));
        await getCoworkStats('w1');
        expect(authFetch).toHaveBeenCalledWith('https://host.example/api/cowork/w1/stats');

        authFetch.mockClear();
        authFetch.mockResolvedValue(ok({}));
        await getCoworkStats('../users/42');
        expect(url()).toBe('https://host.example/api/cowork/..%2Fusers%2F42/stats');
    });

    it('hands the server\'s figures through unchanged', async () => {
        authFetch.mockResolvedValue(ok({
            total: 12, success: 10, failed: 2, avgDurationMs: 72000,
            runCount: 42, createdAt: '2026-07-08T06:00:00.000Z',
        }));
        expect(await getCoworkStats('w1')).toEqual({
            total: 12, success: 10, failed: 2, avgDurationMs: 72000,
            runCount: 42, createdAt: '2026-07-08T06:00:00.000Z',
        });
    });

    it('keeps "never measured" as null instead of turning it into 0 ms', async () => {
        // A brand-new item has no finished run yet. "0m 00s per keer" would be
        // a measurement nobody took; null lets the card say nothing.
        authFetch.mockResolvedValue(ok({ total: 1, success: 0, failed: 0, avgDurationMs: null }));
        const stats = await getCoworkStats('w1');
        expect(stats.avgDurationMs).toBeNull();
        expect(stats).toEqual({
            total: 1, success: 0, failed: 0, avgDurationMs: null, runCount: 0, createdAt: null,
        });
    });

    it('keeps a measured 0 ms as 0, not as "never measured"', async () => {
        // The other side of the same coin, and the one nothing was holding:
        // a sub-millisecond run really did finish, so its average is a
        // measurement of zero. Written with `||` instead of `??` the two
        // become one answer, and the card silently loses the difference
        // between "we measured nothing" and "we measured nothing yet".
        authFetch.mockResolvedValue(ok({ total: 3, success: 3, failed: 0, avgDurationMs: 0 }));
        const stats = await getCoworkStats('w1');
        expect(stats.avgDurationMs).toBe(0);
        expect(stats.avgDurationMs).not.toBeNull();
    });

    it('defaults every count to 0 when the server omits it — the caller never branches on undefined', async () => {
        authFetch.mockResolvedValue(ok({}));
        expect(await getCoworkStats('w1')).toEqual({
            total: 0, success: 0, failed: 0, avgDurationMs: null, runCount: 0, createdAt: null,
        });
    });

    it('reports a figures failure in English', async () => {
        authFetch.mockResolvedValue(fail(403, {}));
        await expect(getCoworkStats('w1')).rejects.toThrow('Could not load the figures for this work');
        authFetch.mockResolvedValue(fail(500, { error: 'Boom' }));
        await expect(getCoworkStats('w1')).rejects.toThrow('Boom');
    });
});
