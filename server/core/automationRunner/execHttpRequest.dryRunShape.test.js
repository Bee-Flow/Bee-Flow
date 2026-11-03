// @typecheck
/**
 * RM-7: what a dry-run http_request write (or authenticated GET) hands on.
 *
 * It used to be `{ body: '', data: null }`, and a parse_json behind it failed
 * the dry run on a step that works live. Now the placeholder has the SHAPE of
 * the last real answer this step gave in a recent run of the automation (keys
 * and types with sample values, never an older run's data), or `{}` when it
 * never answered for real. Either way it is marked synthesised. A malformed
 * URL is refused as live, unless the URL is built from simulated data.
 *
 * Run: node --test core/automationRunner/execHttpRequest.dryRunShape.test.js
 */
'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
/** Results are read loosely here: each case asserts the fields it is about. */
const anyOf = (/** @type {any} */ v) => v;
const httpDryRun = require('./httpDryRun');
const { execHttpRequest } = require('./execHttpRequest');
const { execParseJson } = require('./execData');

// The run history comes in through httpDryRun's seam, not the module system.
const store = { runs: /** @type {any[]} */ ([]), rows: /** @type {any[]} */ ([]) };
httpDryRun._setDepsForTests({
    runStore: () => ({
        getRunsForAutomation: async () => store.runs,
        getRunStepsForRuns: async (ids) => store.rows.filter((r) => ids.includes(r.runId)),
    }),
});
after(() => httpDryRun._setDepsForTests());

beforeEach(() => { store.runs = []; store.rows = []; });

const post = { id: 'h', type: 'http_request', method: 'POST', url: 'https://api.example.com/orders', body: '{"a":1}' };
const ctx = { automationId: 'a1', userId: 'u1' };
const state = () => ({ steps: {}, trigger: { output: {} }, _templateWarnings: [] });

test('no earlier real answer: a {} placeholder, marked synthesised', async () => {
    const out = anyOf(await execHttpRequest(post, ctx, state(), 'dry_run'));
    assert.equal(out.dryRunSynthesised, true);
    assert.equal(out.output.body, '{}');
    assert.deepEqual(out.output.data, {});
    assert.equal(out.output._dryRunShape, 'empty');
});

test('the newest real answer gives the shape, with sample values only', async () => {
    store.runs = [
        { id: 'r-dry', mode: 'dry_run' },
        { id: 'r-new', mode: 'live' },
        { id: 'r-old', mode: 'live' },
    ];
    store.rows = [
        { runId: 'r-dry', stepId: 'h', status: 'success', output: { status: 200, data: { fake: true } } },
        { runId: 'r-new', stepId: 'h', status: 'success', output: { status: 201, headers: { 'content-type': 'application/json' }, body: '{"id":"ord_123","status":"open","lines":[{"sku":"A","qty":2}]}' } },
        { runId: 'r-old', stepId: 'h', status: 'success', output: { status: 200, data: { old: 'x' } } },
    ];
    const out = anyOf(await execHttpRequest(post, ctx, state(), 'dry_run'));
    assert.equal(out.output._dryRunShape, 'last_live_run');
    assert.equal(out.output.status, 201);
    assert.deepEqual(out.output.data, { id: 'sample', status: 'sample', lines: [{ sku: 'sample', qty: 0 }] });
    assert.doesNotMatch(out.output.body, /ord_123/, 'never an older run\'s values');
    assert.deepEqual(JSON.parse(out.output.body), out.output.data);
});

test('a caller-mode run of somebody else does not lend its shape', async () => {
    store.runs = [{ id: 'r1', mode: 'live', connectionsMode: 'caller', startedByUserId: 'someone-else' }];
    store.rows = [{ runId: 'r1', stepId: 'h', status: 'success', output: { status: 200, data: { secret: 'x' } } }];
    const out = anyOf(await execHttpRequest(post, ctx, state(), 'dry_run'));
    assert.equal(out.output._dryRunShape, 'empty');
});

test('parse_json after a dry-run POST does not fail', async () => {
    store.runs = [{ id: 'r1', mode: 'live' }];
    store.rows = [{ runId: 'r1', stepId: 'h', status: 'success', output: { status: 200, body: '{"id":"x","status":"ok"}' } }];
    const rs = state();
    const h = anyOf(await execHttpRequest(post, ctx, rs, 'dry_run'));
    rs.steps.h = { output: h.output, synthesised: true };
    const p = anyOf(await execParseJson({ id: 'p', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ name: 'id', path: 'id' }] }, ctx, rs, 'dry_run'));
    assert.deepEqual(p.output, { id: 'sample' });
});

test('a malformed URL is refused in a dry run, as live', async () => {
    await assert.rejects(() => execHttpRequest({ ...post, url: 'ftp://example.com/x' }, ctx, state(), 'dry_run'), /unsupported URL scheme/);
    await assert.rejects(() => execHttpRequest({ ...post, url: 'not a url' }, ctx, state(), 'dry_run'), /invalid URL/);
});

test('a URL built from simulated data is not refused for the sample\'s sake', async () => {
    const rs = { ...state(), steps: { up: { output: { url: '' }, synthesised: true } } };
    const out = anyOf(await execHttpRequest({ ...post, url: '{{steps.up.output.url}}' }, ctx, rs, 'dry_run'));
    assert.equal(out.dryRunSynthesised, true);
});
