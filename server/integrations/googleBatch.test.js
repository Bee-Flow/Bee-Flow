'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    googleBatch, partError, buildBatchBody, parseBatchResponse, isRetryablePart, GMAIL_BATCH_ENDPOINT,
} = require('./googleBatch');

/**
 * A batch answer the way Google writes one: its own boundary, a CRLF before the
 * first delimiter, `response-<id>` Content-IDs, and an embedded HTTP response
 * whose JSON body ends in a bare LF.
 */
function batchAnswer(parts, boundary = 'batch_xyz') {
    let body = '\r\n';
    for (const p of parts) {
        const json = p.body === undefined ? '' : `${JSON.stringify(p.body)}\n`;
        const extra = p.retryAfter ? `Retry-After: ${p.retryAfter}\r\n` : '';
        body += `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${p.id}>\r\n\r\n`
            + `HTTP/1.1 ${p.status} X\r\nContent-Type: application/json; charset=UTF-8\r\n${extra}\r\n${json}\r\n`;
    }
    body += `--${boundary}--\r\n`;
    return { ok: true, status: 200, headers: new Headers({ 'content-type': `multipart/mixed; boundary=${boundary}` }), text: async () => body };
}

/** The parts of a request body we sent, as [{ id, requestLine }]. */
function sentParts(init) {
    const boundary = /boundary=(\S+)/.exec(init.headers['Content-Type'])[1];
    return init.body.split(`--${boundary}`).slice(1).filter(c => !c.startsWith('--')).map(c => ({
        id: /Content-ID: <([^>]+)>/.exec(c)[1],
        requestLine: c.split('\r\n\r\n')[1].split('\r\n')[0],
    }));
}

const noSleep = async () => {};

test('the request body: one application/http part per call, ids as Content-ID, JSON bodies typed', () => {
    const body = buildBatchBody([
        { id: 'a', path: '/gmail/v1/users/me/messages/a?format=full' },
        { id: 'm', method: 'post', path: '/gmail/v1/users/me/messages/batchModify', body: { ids: ['a'] } },
    ], 'B');
    assert.match(body, /^--B\r\nContent-Type: application\/http\r\nContent-ID: <a>\r\n\r\nGET \/gmail\/v1\/users\/me\/messages\/a\?format=full\r\n\r\n/);
    assert.match(body, /POST \/gmail\/v1\/users\/me\/messages\/batchModify\r\nContent-Type: application\/json; charset=UTF-8\r\n\r\n\{"ids":\["a"\]\}/);
    assert.ok(body.endsWith('--B--\r\n'));
});

test('the answer: read with ITS boundary, matched by Content-ID, JSON parsed', async () => {
    const answer = batchAnswer([{ id: 'a', status: 200, body: { id: 'a' } }, { id: 'b', status: 404, body: { error: { message: 'Not Found' } } }], 'batch_other');
    const parts = parseBatchResponse(answer.headers.get('content-type'), await answer.text());
    assert.deepEqual(parts.get('a'), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' }, body: { id: 'a' } });
    assert.equal(parts.get('b').status, 404);
    assert.equal(partError(parts.get('b')), 'Not Found');
    assert.throws(() => parseBatchResponse('application/json', '{}'), /not a multipart batch/);
});

test('throttled and failing parts are retryable; a plain 403 or a 404 is final', () => {
    assert.equal(isRetryablePart({ status: 429, headers: {}, body: {} }), true);
    assert.equal(isRetryablePart({ status: 503, headers: {}, body: {} }), true);
    assert.equal(isRetryablePart({ status: 403, headers: {}, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }), true);
    assert.equal(isRetryablePart({ status: 403, headers: {}, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }), true);
    assert.equal(isRetryablePart({ status: 403, headers: {}, body: { error: { errors: [{ reason: 'insufficientPermissions' }] } } }), false);
    assert.equal(isRetryablePart({ status: 404, headers: {}, body: {} }), false);
    assert.equal(isRetryablePart(undefined), true);
});

test('120 calls go out as three batches of at most 50, to the Gmail batch endpoint, with the bearer token', async () => {
    const posts = [];
    const fetchImpl = async (url, init) => {
        posts.push({ url, init });
        return batchAnswer(sentParts(init).map(p => ({ id: p.id, status: 200, body: { id: p.id } })));
    };
    const requests = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, path: `/gmail/v1/users/me/messages/m${i}?format=full` }));
    const out = await googleBatch({ accessToken: 'tok' }, requests, { fetchImpl, sleepImpl: noSleep });
    assert.deepEqual(posts.map(p => sentParts(p.init).length), [50, 50, 20]);
    assert.ok(posts.every(p => p.url === GMAIL_BATCH_ENDPOINT && p.init.method === 'POST' && p.init.headers.Authorization === 'Bearer tok'));
    assert.equal(out.size, 120);
    assert.deepEqual(out.get('m119').body, { id: 'm119' });
});

test('only the throttled parts go again, after the longest Retry-After; a part that keeps failing comes back as is', async () => {
    let round = 0;
    const waits = [];
    const fetchImpl = async (_url, init) => {
        round++;
        const ids = sentParts(init).map(p => p.id);
        if (round === 1) {
            assert.deepEqual(ids, ['a', 'b', 'c']);
            return batchAnswer([
                { id: 'a', status: 200, body: { id: 'a' } },
                { id: 'b', status: 429, retryAfter: '3', body: { error: { message: 'Too many' } } },
                { id: 'c', status: 500, body: { error: { message: 'Backend' } } },
            ]);
        }
        assert.deepEqual(ids.sort(), ['b', 'c']);
        return batchAnswer([{ id: 'b', status: 200, body: { id: 'b' } }, { id: 'c', status: 500, body: { error: { message: 'Backend' } } }]);
    };
    const out = await googleBatch({ accessToken: 't' }, ['a', 'b', 'c'].map(id => ({ id, path: `/x/${id}` })), {
        fetchImpl, maxAttempts: 2, sleepImpl: async (ms) => { waits.push(ms); },
    });
    assert.equal(round, 2);
    assert.deepEqual(waits, [3000]);
    assert.equal(out.get('a').status, 200);
    assert.equal(out.get('b').status, 200);
    assert.equal(out.get('c').status, 500, 'out of attempts: the last answer stands');
});

test('an expired token refreshes once and only the 401 parts go again', async () => {
    const session = { accessToken: 'old', refreshToken: 'r' };
    const refreshes = [];
    const refreshImpl = async (s) => { refreshes.push(s); s.accessToken = 'new'; };
    const tokens = [];
    const fetchImpl = async (_url, init) => {
        tokens.push(init.headers.Authorization);
        const ids = sentParts(init).map(p => p.id);
        if (init.headers.Authorization === 'Bearer old') return batchAnswer(ids.map(id => ({ id, status: id === 'a' ? 200 : 401, body: { id } })));
        assert.deepEqual(ids, ['b']);
        return batchAnswer([{ id: 'b', status: 200, body: { id: 'b' } }]);
    };
    const out = await googleBatch(session, [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], { fetchImpl, sleepImpl: noSleep, refreshImpl });
    assert.deepEqual(tokens, ['Bearer old', 'Bearer new']);
    assert.deepEqual(refreshes, [session]);
    assert.equal(out.get('a').status, 200);
    assert.equal(out.get('b').status, 200);
    // A second 401 after the one refresh is final, and a failed refresh is NOT_CONNECTED.
    const stale = await googleBatch({ accessToken: 'x' }, [{ id: 'c', path: '/c' }], {
        fetchImpl: async (_u, init) => batchAnswer(sentParts(init).map(p => ({ id: p.id, status: 401, body: {} }))),
        sleepImpl: noSleep, refreshImpl: async () => {},
    });
    assert.equal(stale.get('c').status, 401);
    await assert.rejects(googleBatch({ accessToken: 'x' }, [{ id: 'c', path: '/c' }], {
        fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers(), text: async () => '' }),
        refreshImpl: async () => { throw new Error('no refresh token'); },
    }), /NOT_CONNECTED/);
});

test('a whole-batch error carries Google\'s message; no token is NOT_CONNECTED', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, headers: new Headers(), text: async () => JSON.stringify({ error: { message: 'Inner request count exceeds the limit' } }) });
    await assert.rejects(googleBatch({ accessToken: 't' }, [{ id: 'a', path: '/a' }], { fetchImpl, sleepImpl: noSleep }), /Inner request count exceeds the limit/);
    await assert.rejects(googleBatch({}, [{ id: 'a', path: '/a' }], { fetchImpl }), /NOT_CONNECTED/);
});

test('a value from a run can never end the request line: ids and paths are checked', async () => {
    const fetchImpl = async () => { throw new Error('must not send'); };
    const bad = [
        [{ id: 'a b', path: '/a' }],
        [{ id: 'a', path: '/a\r\nBcc: x' }],
        [{ id: 'a', path: '/a b' }],
        [{ id: 'a', path: 'https://evil.example/a' }],
        [{ id: 'a', path: '/a' }, { id: 'a', path: '/b' }],
        [{ id: 'a', method: 'TRACE', path: '/a' }],
    ];
    for (const requests of bad) {
        await assert.rejects(googleBatch({ accessToken: 't' }, requests, { fetchImpl }), /googleBatch: /);
    }
});

test('a cancelled run stops before the next batch', async () => {
    const ac = new AbortController();
    let posts = 0;
    const fetchImpl = async (_url, init) => {
        posts++;
        ac.abort();
        return batchAnswer(sentParts(init).map(p => ({ id: p.id, status: 200, body: {} })));
    };
    const requests = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, path: `/m${i}` }));
    await assert.rejects(googleBatch({ accessToken: 't' }, requests, { fetchImpl, partsPerBatch: 1, signal: ac.signal }), /Run cancelled/);
    assert.equal(posts, 1);
});

test('beforePart is called for every part that is sent, again on a resend', async () => {
    const charged = [];
    let round = 0;
    const fetchImpl = async (_url, init) => {
        round++;
        return batchAnswer(sentParts(init).map(p => ({ id: p.id, status: round === 1 && p.id === 'b' ? 429 : 200, body: {} })));
    };
    await googleBatch({ accessToken: 't' }, [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], {
        fetchImpl, sleepImpl: noSleep, beforePart: (r) => { charged.push(r.id); },
    });
    assert.deepEqual(charged, ['a', 'b', 'b']);
});
