import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    NOT_BATCHED,
    MAX_BATCH_READS,
    queueRead,
    unwrapReadResult,
    isBatchingAvailable,
    requestsForBindings,
    subscribeBatchAvailability,
    __resetBatchClient,
} from './dataBatchClient';

/**
 * The coalescer's job is to spend fewer requests. Its RISK is that a batch
 * endpoint the other side does not serve answers 404 — which is also what a
 * missing table answers, and which the single-request path deliberately reads
 * as "no rows". Two of this codebase's transports fail closed with exactly that
 * status (publicAppTransport for a suffix the anonymous router does not serve,
 * the demo transport for a route with no fixture), and so does any server older
 * than this change.
 *
 * So the tests that matter are not the ones about batching working. They are
 * the ones proving that when it does NOT work, nothing renders as empty.
 */

vi.mock('../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
}));


import { authFetch } from '../../../../../utils/helpers';

const APP = 'app_1';
const read = (id, extra = {}) => ({ id, kind: 'records', tableId: 'tbl_a', ...extra });

/** A Response-shaped stub — the client only uses status, headers.get and json. */
function reply(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k] ?? null },
        json: async () => {
            if (body === undefined) throw new Error('not json');
            return body;
        },
    };
}

const results = (...rows) => reply(200, { results: rows });
const okRow = (id, data) => ({ id, ok: true, data });

/** Let the 8ms coalescing window close and the in-flight promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
    __resetBatchClient();
    authFetch.mockReset();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('coalescing', () => {
    it('sends reads that start together as one request, and routes each answer back by id', async () => {
        authFetch.mockResolvedValue(results(
            okRow('a', { records: [{ id: 'r1' }] }),
            okRow('b', { rows: [{ n: 2 }] }),
        ));

        const [a, b] = await Promise.all([
            queueRead(APP, read('a')),
            queueRead(APP, read('b', { kind: 'aggregate' })),
        ]);

        expect(authFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = authFetch.mock.calls[0];
        expect(url).toBe(`/api/studio-apps/${APP}/data/batch`);
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body).reads.map((r) => r.id)).toEqual(['a', 'b']);
        expect(a.result.data.records).toEqual([{ id: 'r1' }]);
        expect(b.result.data.rows).toEqual([{ n: 2 }]);
    });

    it('two callers asking for the same binding share one read', async () => {
        authFetch.mockResolvedValue(results(okRow('a', { records: [] })));
        const [first, second] = await Promise.all([queueRead(APP, read('a')), queueRead(APP, read('a'))]);
        expect(JSON.parse(authFetch.mock.calls[0][1].body).reads).toHaveLength(1);
        expect(first.result.ok).toBe(true);
        expect(second.result.ok).toBe(true);
    });

    it('splits past the per-batch cap instead of sending one oversized request', async () => {
        authFetch.mockImplementation(async (_url, opts) => results(
            ...JSON.parse(opts.body).reads.map((r) => okRow(r.id, { records: [] })),
        ));
        const many = Array.from({ length: MAX_BATCH_READS + 1 }, (_, i) => queueRead(APP, read(`r${i}`)));
        const answers = await Promise.all(many);
        expect(authFetch).toHaveBeenCalledTimes(2);
        expect(answers.every((a) => a.result.ok)).toBe(true);
    });

    it('splits on the byte budget too, so a batch never trips the 64KB body cap', async () => {
        authFetch.mockImplementation(async (_url, opts) => results(
            ...JSON.parse(opts.body).reads.map((r) => okRow(r.id, { records: [] })),
        ));
        const fat = 'x'.repeat(30 * 1024);
        await Promise.all([
            queueRead(APP, read('a', { filters: [{ value: fat }] })),
            queueRead(APP, read('b', { filters: [{ value: fat }] })),
        ]);
        expect(authFetch).toHaveBeenCalledTimes(2);
    });
});

describe('a batch-level failure is never data', () => {
    for (const status of [404, 405, 501]) {
        it(`a ${status} means "cannot batch", not "no rows"`, async () => {
            authFetch.mockResolvedValue(reply(status, { error: 'nope' }));
            const answer = await queueRead(APP, read('a'));
            expect(answer).toBe(NOT_BATCHED);
            expect(isBatchingAvailable(APP)).toBe(false);
        });
    }

    it('a fail-closed transport downgrades the app once, then stops asking', async () => {
        // Exactly what publicAppTransport does for a suffix it does not serve,
        // and what the demo transport does for a route with no fixture.
        authFetch.mockResolvedValue(reply(404, { error: 'Not available on a public page' }));
        expect(await queueRead(APP, read('a'))).toBe(NOT_BATCHED);
        expect(await queueRead(APP, read('b'))).toBe(NOT_BATCHED);
        await settle();
        expect(authFetch).toHaveBeenCalledTimes(1);
    });

    it('a 200 that is not a batch answer is refused too — an SPA shell is not data', async () => {
        authFetch.mockResolvedValue(reply(200, { hello: 'world' }));
        expect(await queueRead(APP, read('a'))).toBe(NOT_BATCHED);
        expect(isBatchingAvailable(APP)).toBe(false);
    });

    it('a read the server did not answer for goes back to the single path, not to []', async () => {
        authFetch.mockResolvedValue(results(okRow('a', { records: [{ id: 'r1' }] })));
        const [a, b] = await Promise.all([queueRead(APP, read('a')), queueRead(APP, read('b'))]);
        expect(a.result.ok).toBe(true);
        expect(b).toBe(NOT_BATCHED);
        expect(isBatchingAvailable(APP)).toBe(true); // one gap is not a broken route
    });

    it('downgrading is per app — another app keeps batching', async () => {
        authFetch.mockResolvedValue(reply(404, {}));
        await queueRead(APP, read('a'));
        expect(isBatchingAvailable(APP)).toBe(false);
        expect(isBatchingAvailable('app_2')).toBe(true);
    });
});

describe('a real failure stays a failure', () => {
    it('a 429 rejects with its status and the wait the server named — no downgrade', async () => {
        authFetch.mockResolvedValue(reply(429, { error: 'Too many requests' }, { 'Retry-After': '7' }));
        await expect(queueRead(APP, read('a'))).rejects.toMatchObject({ status: 429, retryAfter: 7 });
        expect(isBatchingAvailable(APP)).toBe(true);
    });

    it('a 500 is surfaced rather than replayed as N single requests', async () => {
        authFetch.mockResolvedValue(reply(500, { error: 'Data request failed' }));
        await expect(queueRead(APP, read('a'))).rejects.toMatchObject({ status: 500 });
        expect(isBatchingAvailable(APP)).toBe(true);
    });

    it('a network failure reaches every waiting read', async () => {
        authFetch.mockRejectedValue(new Error('offline'));
        const both = Promise.allSettled([queueRead(APP, read('a')), queueRead(APP, read('b'))]);
        const settled = await both;
        expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
        expect(isBatchingAvailable(APP)).toBe(true);
    });
});

describe('unwrapReadResult', () => {
    it('degrades a per-read 404 to whatever that binding calls empty', () => {
        expect(unwrapReadResult({ ok: false, status: 404 }, [])).toEqual([]);
        expect(unwrapReadResult({ ok: false, status: 404 }, null)).toBe(null);
    });

    it('throws every other refusal, carrying the status and the message', () => {
        expect(() => unwrapReadResult({ ok: false, status: 403, error: 'Forbidden' }, []))
            .toThrow(/Forbidden/);
        try {
            unwrapReadResult({ ok: false, status: 403, error: 'Forbidden' }, []);
        } catch (err) {
            expect(err.status).toBe(403);
        }
    });

    it('passes a successful read through untouched', () => {
        const data = { records: [{ id: 'r1' }], nextCursor: null };
        expect(unwrapReadResult({ ok: true, data }, [])).toBe(data);
    });
});

describe('the polling interval follows the request count', () => {
    it('counts batches while batching works, and bindings once it does not', async () => {
        expect(requestsForBindings(APP, 0)).toBe(0);
        expect(requestsForBindings(APP, 19)).toBe(2);

        const seen = vi.fn();
        const unsubscribe = subscribeBatchAvailability(seen);
        authFetch.mockResolvedValue(reply(404, {}));
        await queueRead(APP, read('a'));

        expect(seen).toHaveBeenCalled();
        expect(requestsForBindings(APP, 19)).toBe(19);
        unsubscribe();
    });
});
