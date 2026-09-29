const test = require('node:test');
const assert = require('node:assert');

const { withRequestId, requestIdFrom } = require('./requestId');
const { currentRequestId } = require('../../telemetry/log');

function fakeRes() {
    const headers = {};
    return { headers, setHeader: (k, v) => { headers[k] = v; } };
}

test('keeps a well-formed incoming X-Request-Id', () => {
    assert.strictEqual(requestIdFrom('abc-123.DEF_456'), 'abc-123.DEF_456');
});

test('replaces anything that does not look like an id', () => {
    for (const bad of [undefined, '', 'has space', 'x'.repeat(129), 'a\nb', '<script>', ['a']]) {
        const id = requestIdFrom(bad);
        assert.match(id, /^[0-9a-f-]{36}$/, `input ${JSON.stringify(bad)} must yield a uuid`);
    }
});

test('stamps req, the response header and the async context', () => {
    const req = { headers: { 'x-request-id': 'req-1' } };
    const res = fakeRes();
    let seen;
    withRequestId(req, res, () => { seen = currentRequestId(); });
    assert.strictEqual(req.id, 'req-1');
    assert.strictEqual(res.headers['X-Request-Id'], 'req-1');
    assert.strictEqual(seen, 'req-1');
});

test('the id survives async hops and is absent outside a request', async () => {
    const req = { headers: {} };
    const res = fakeRes();
    let later;
    await new Promise((resolve) => {
        withRequestId(req, res, () => {
            setTimeout(() => { later = currentRequestId(); resolve(); }, 0);
        });
    });
    assert.strictEqual(later, req.id);
    assert.strictEqual(currentRequestId(), undefined);
});
