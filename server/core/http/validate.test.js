const test = require('node:test');
const assert = require('node:assert');
const { z } = require('zod');

const { validate } = require('./validate');
const { HttpError } = require('./errors');

const Body = z.object({
    title: z.string().trim().min(1, 'Title is required'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

function run(mw, req) {
    return new Promise((resolve) => mw(req, {}, (err) => resolve(err)));
}

test('replaces the part with the parsed value: trimmed, coerced, defaults applied', async () => {
    const req = { body: { title: '  Hello ', limit: '5' } };
    const err = await run(validate({ body: Body }), req);
    assert.strictEqual(err, undefined);
    assert.deepStrictEqual(req.body, { title: 'Hello', limit: 5 });
});

test('a failing part becomes a 400 HttpError with the schema message and every issue', async () => {
    const req = { body: { title: '   ', limit: 'many', extra: 1 } };
    const err = await run(validate({ body: Body }), req);
    assert.ok(err instanceof HttpError);
    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.code, 'invalid_request');
    assert.strictEqual(err.message, 'Title is required');
    assert.deepStrictEqual(err.details.map((d) => d.path).sort(), ['body', 'body.limit', 'body.title']);
});

test('query is validated too, even though Express defines it as a getter', async () => {
    const proto = { get query() { return { page: '2' }; } };
    const req = Object.create(proto);
    const err = await run(validate({ query: z.object({ page: z.coerce.number().int() }) }), req);
    assert.strictEqual(err, undefined);
    assert.deepStrictEqual(req.query, { page: 2 });
});

test('parts are checked in order and the first failure ends the request', async () => {
    const req = { params: { id: 'x' }, body: {} };
    const err = await run(validate({ params: z.object({ id: z.string().uuid('id must be a uuid') }), body: Body }), req);
    assert.strictEqual(err.message, 'id must be a uuid');
    assert.deepStrictEqual(req.body, {}, 'the body was not touched');
});
