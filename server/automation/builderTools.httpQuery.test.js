/**
 * The AI builder and http_request `query`: accepted by the add/update tools,
 * checked by refCheck-style placeholder validation, validated, and a
 * hand-encoded bracket query in the URL is lifted into `query`.
 * Run: node --test automation/builderTools.httpQuery.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

const wrap = () => ({ userId: 'u_test', def: emptyDefinition() });
const OWNER_JSON = '{"builder":[{"orderByDesc":"created_at"},{"with":["categories"]},{"paginate":{{trigger.output.size}}}]}';

async function seeded() {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    return dw;
}

test('the tool schema exposes query', () => {
    const t = TOOL_SCHEMAS.find((x) => x.function.name === 'builder_add_http_request');
    assert.ok(t.function.parameters.properties.query);
});

test('builder_add_http_request stores a json query and the definition validates', async () => {
    const dw = await seeded();
    const r = await applyToolCall('builder_add_http_request', {
        url: 'https://acme.example.nl/api/tickets',
        query: { mode: 'json', json: OWNER_JSON },
    }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(r.added.query.mode, 'json');
    assert.ok(validateDefinition(dw.def).errors.every((e) => !e.code.startsWith('http_request.query')));
});

test('a fields query keeps rows and drops blank keys', async () => {
    const dw = await seeded();
    const r = await applyToolCall('builder_add_http_request', {
        url: 'https://x.example/api',
        query: { mode: 'fields', items: [{ key: 'page', value: '1' }, { key: ' ', value: 'x' }], arrayFormat: 'brackets' },
    }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(r.added.query, { mode: 'fields', items: [{ key: 'page', value: '1' }], arrayFormat: 'brackets' });
});

// The add tool accepts an unknown step in a url too; the validator is what flags
// it (ref.unknown_step), so a query value must reach the same check.
test('a binding to a step that does not exist inside the query is flagged like one in the url', async () => {
    const dw = await seeded();
    const r = await applyToolCall('builder_add_http_request', {
        url: 'https://x.example/api',
        query: { mode: 'fields', items: [{ key: 'page', value: '{{steps.nope.output.n}}' }] },
    }, dw);
    assert.ok(!r.error, r.error);
    const v = validateDefinition(dw.def);
    const codes = [...(v.errors || []), ...(v.warnings || [])].map(e => e.code);
    assert.ok(codes.includes('ref.unknown_step'), `expected ref.unknown_step, got ${codes.join(', ')}`);
});

test('an encoded bracket query in the url is moved into query', async () => {
    const dw = await seeded();
    const r = await applyToolCall('builder_add_http_request', {
        url: 'https://ondernemerskompas.inserve.nl/api/tickets?builder%5B0%5D%5BorderByDesc%5D=created_at&builder%5B1%5D%5Bwith%5D%5B0%5D=categories&builder%5B2%5D%5Bpaginate%5D=5&page=1',
    }, dw);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.added.url, 'https://ondernemerskompas.inserve.nl/api/tickets');
    assert.strictEqual(r.added.query.mode, 'json');
    assert.deepStrictEqual(JSON.parse(r.added.query.json).builder[2], { paginate: '5' });
    assert.ok((r._warnings || []).some((w) => /moved into `query`/.test(w)));
});

test('builder_update_step patches query and lifts a url query', async () => {
    const dw = await seeded();
    const a = await applyToolCall('builder_add_http_request', { url: 'https://x.example/api' }, dw);
    const up = await applyToolCall('builder_update_step', {
        stepId: a.added.id,
        patch: { query: { mode: 'fields', items: [{ key: 'q', value: 'a' }] } },
    }, dw);
    assert.ok(!up.error, up.error);
    const step = dw.def.steps.find((s) => s.id === a.added.id);
    assert.deepStrictEqual(step.query.items, [{ key: 'q', value: 'a' }]);
    const up2 = await applyToolCall('builder_update_step', {
        stepId: a.added.id,
        patch: { url: 'https://x.example/api?f%5B0%5D%5Bk%5D=v', query: null },
    }, dw);
    assert.ok(!up2.error, up2.error);
    const step2 = dw.def.steps.find((s) => s.id === a.added.id);
    assert.strictEqual(step2.url, 'https://x.example/api');
    assert.strictEqual(step2.query.mode, 'json');
});

test('the validator rejects a malformed query', () => {
    const def = emptyDefinition();
    def.steps.push({ id: 'h', type: 'http_request', url: 'https://x.example', query: { mode: 'json', json: '{oops' } });
    const v = validateDefinition(def);
    assert.ok(v.errors.some((e) => e.code === 'http_request.query_json_invalid'));
    def.steps[0].query = { mode: 'fields', items: [{ key: 5 }] };
    assert.ok(validateDefinition(def).errors.some((e) => e.code === 'http_request.query_items_shape'));
    def.steps[0].query = { mode: 'json', json: '{"a": {{trigger.output.x}} }', arrayFormat: 'nope' };
    assert.ok(validateDefinition(def).errors.some((e) => e.code === 'http_request.query_array_format'));
});
