import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OUT_REL, SPEC_REL, operationsOf, render, run, toTs } from './gen-api-types.mjs';

const spec = (paths) => ({ openapi: '3.1.0', paths });
const jsonBody = (schema) => ({ content: { 'application/json': { schema } }, required: true });

test('toTs writes the JSON Schema shapes zod produces as TypeScript', () => {
    assert.strictEqual(toTs({ type: 'string', maxLength: 3 }), 'string');
    assert.strictEqual(toTs({ type: 'integer' }), 'number');
    assert.strictEqual(toTs({ type: ['string', 'null'] }), 'string | null');
    assert.strictEqual(toTs({ enum: ['a', "it's"] }), "'a' | 'it\\'s'");
    assert.strictEqual(toTs({ const: 3 }), '3');
    assert.strictEqual(toTs({ anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'string' }] }), 'string | null');
    assert.strictEqual(toTs({ type: 'array', items: { type: 'boolean' } }), 'Array<boolean>');
    assert.strictEqual(toTs({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] }), '[string, number]');
    assert.strictEqual(toTs({ type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'number' } }), 'Record<string, number>');
    assert.strictEqual(toTs({ type: 'object', propertyNames: { enum: ['x', 'y'] }, additionalProperties: { type: 'string' } }), "Partial<Record<'x' | 'y', string>>");
    assert.strictEqual(toTs({ type: 'object', additionalProperties: false }), 'Record<string, never>');
    assert.strictEqual(toTs({ not: {} }), 'unknown');
    assert.strictEqual(toTs({ anyOf: [{ type: 'string' }, {}] }), 'unknown', 'a union with unknown in it is unknown');
    assert.strictEqual(toTs({ description: 'Recursive schema; the shape is defined in the route source.' }), 'unknown');
});

test('a closed object names its keys; a loose one also takes others', () => {
    const closed = toTs({ type: 'object', properties: { b: { type: 'string' }, 'a-b': { type: 'number' } }, required: ['b'], additionalProperties: false });
    assert.strictEqual(closed, "{\n    'a-b'?: number;\n    b: string;\n}");
    const loose = toTs({ type: 'object', properties: { b: { type: 'string' } } });
    assert.match(loose, /b\?: string;\n {4}\[key: string\]: unknown;/);
});

test('each operation is keyed METHOD + path template, with params, query and body, and the empty parts left to the defaults', () => {
    const out = render(spec({
        '/api/x/{id}': {
            patch: {
                parameters: [
                    { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
                    { in: 'query', name: 'force', required: false, schema: { enum: ['1'] } },
                ],
                requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }),
            },
            get: { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }] },
        },
        '/api/a': { post: { requestBody: jsonBody({ type: 'object', properties: {}, additionalProperties: false }) }, get: {} },
    }));
    assert.match(out, /^\/\/ GENERATED from docs\/static\/openapi\.json by scripts\/gen-api-types\.mjs, do not edit\./);
    assert.match(out, /'GET \/api\/a': Op;/);
    assert.match(out, /'POST \/api\/a': Op<NoParams, UndeclaredQuery, Record<string, never>>;/);
    assert.match(out, /'GET \/api\/x\/\{id\}': Op<\{ id: string \| number \}>;/);
    assert.match(out, /'PATCH \/api\/x\/\{id\}': Op<\{ id: string \| number \}, \{\n {8}force\?: '1';\n {4}\}, \{\n {8}name: string;\n {4}\}>;/);
    assert.match(out, /export type ApiOperationKey = keyof ApiOperations;/);
});

test('operations are sorted by path, then by method, so the output is the same on every run', () => {
    const keys = operationsOf(spec({ '/b': { delete: {}, get: {} }, '/a': { post: {}, get: {} } })).map((o) => o.key);
    assert.deepStrictEqual(keys, ['GET /a', 'POST /a', 'GET /b', 'DELETE /b']);
});

test('--check fails on a stale or missing file and passes once it is written', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-api-types-'));
    try {
        fs.mkdirSync(path.join(root, path.dirname(SPEC_REL)), { recursive: true });
        fs.mkdirSync(path.join(root, path.dirname(OUT_REL)), { recursive: true });
        fs.writeFileSync(path.join(root, SPEC_REL), JSON.stringify(spec({ '/a': { get: {} } })));
        const quiet = { log: () => {}, error: () => {} };
        assert.strictEqual(run({ root, check: true, ...quiet }), 1, 'missing file');
        assert.strictEqual(run({ root, ...quiet }), 0);
        assert.strictEqual(run({ root, check: true, ...quiet }), 0);
        fs.appendFileSync(path.join(root, OUT_REL), '// edited by hand\n');
        const errors = [];
        assert.strictEqual(run({ root, check: true, log: () => {}, error: (m) => errors.push(m) }), 1, 'hand edit');
        assert.match(errors[0], /npm run gen:api-types/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the committed file matches the committed spec', () => {
    assert.strictEqual(run({ check: true, log: () => {}, error: () => {} }), 0, 'run `npm run gen:api-types`');
});
