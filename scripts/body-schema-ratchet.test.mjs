/**
 * The body-schema ratchet is a gate, so it has to REFUSE: a new mutating route
 * without a body schema past the budget, and an --update that would raise it.
 * It counts from the generated spec, so it has to read that the way
 * gen-api-reference writes it: POST, PUT and PATCH count, an operation with a
 * `requestBody` has a schema, GET and DELETE are not counted.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main, measure, SPEC_REL, BUDGET_REL } from './body-schema-ratchet.mjs';

const op = (withBody) => (withBody ? { requestBody: { content: {} } } : {});

function sandbox(paths, budget) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'body-schema-ratchet-'));
    fs.mkdirSync(path.dirname(path.join(root, SPEC_REL)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, BUDGET_REL)), { recursive: true });
    fs.writeFileSync(path.join(root, SPEC_REL), JSON.stringify({ paths }));
    if (budget !== undefined) fs.writeFileSync(path.join(root, BUDGET_REL), JSON.stringify({ budget }));
    const lines = { out: '', err: '' };
    const run = (...argv) => main(argv, { root, out: (s) => { lines.out += s; }, err: (s) => { lines.err += s; } });
    return { root, run, lines, budget: () => JSON.parse(fs.readFileSync(path.join(root, BUDGET_REL), 'utf8')).budget };
}

const SPEC = {
    '/api/a': { get: op(false), post: op(true), delete: op(false) },
    '/api/a/{id}': { put: op(false), patch: op(true) },
    '/api/b': { post: op(false) },
};

test('counts the mutating operations without a requestBody, per method', () => {
    const m = measure({ paths: SPEC });
    assert.deepStrictEqual(m.missing, ['POST /api/b', 'PUT /api/a/{id}']);
    assert.deepStrictEqual(m.perMethod, { POST: { total: 2, withSchema: 1 }, PUT: { total: 1, withSchema: 0 }, PATCH: { total: 1, withSchema: 1 } });
});

test('passes at or under the budget, fails above it and names what to do', () => {
    assert.strictEqual(sandbox(SPEC, 2).run(), 0);
    const over = sandbox(SPEC, 1);
    assert.strictEqual(over.run(), 1);
    assert.match(over.lines.err, /2 mutating routes without a body schema, the budget is 1/);
});

test('--update lowers the budget and never raises it', () => {
    const lower = sandbox(SPEC, 5);
    assert.strictEqual(lower.run('--update'), 0);
    assert.strictEqual(lower.budget(), 2);
    const raise = sandbox(SPEC, 1);
    assert.strictEqual(raise.run('--update'), 1);
    assert.strictEqual(raise.budget(), 1);
});

test('a missing budget file is a failure, not a pass', () => {
    const s = sandbox(SPEC);
    assert.strictEqual(s.run(), 1);
    assert.match(s.lines.err, /missing/);
});

test('--list prints the routes and the coverage per method', () => {
    const s = sandbox(SPEC, 2);
    assert.strictEqual(s.run('--list'), 0);
    assert.match(s.lines.out, /^POST \/api\/b$/m);
    assert.match(s.lines.out, /PUT: 0\/1 with a body schema \(0\.0%\)/);
});

test('the committed spec is within the committed budget', () => {
    assert.strictEqual(main([], { out: () => {}, err: () => {} }), 0);
});
