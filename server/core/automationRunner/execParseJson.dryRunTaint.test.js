// @typecheck
/**
 * RM-7 (second half): parse_json behind a dry-run placeholder.
 *
 * A dry run simulates an http_request POST (or an authenticated GET), and a
 * parse_json behind it used to throw "source is not valid JSON" / "source is
 * null" on the placeholder: the run went red on a step that works live. Now:
 *   - the http placeholder is `{}`-shaped JSON, so the common case parses
 *     (execHttpRequest.dryRunShape.test.js);
 *   - a parse_json whose source is SIMULATED data and still cannot be read
 *     returns a labelled synthetic skip with a run warning (amber, never red,
 *     never green);
 *   - on REAL data the same failure still fails, in a dry run as live.
 *
 * Run: node --test core/automationRunner/execParseJson.dryRunTaint.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
/** Results are read loosely here: each case asserts the fields it is about. */
const anyOf = (/** @type {any} */ v) => v;
const { execParseJson } = require('./execData');

const fields = [{ name: 'id', path: 'id' }, { name: 'status', path: 'status' }];
const pj = (over = {}) => ({ id: 'p', type: 'parse_json', sourceRef: 'steps.h.output.body', fields, ...over });
const state = (h, synthesised) => ({ steps: { h: { output: h, ...(synthesised ? { synthesised: true } : {}) } }, _templateWarnings: [] });
const OLD_PLACEHOLDER = { status: 200, ok: true, headers: {}, body: '', data: null, _dryRun: true };

test('parse_json after a dry-run POST does not fail: the {} placeholder parses', async () => {
    const rs = state({ status: 200, ok: true, headers: {}, body: '{}', data: {}, _dryRun: true }, true);
    const out = anyOf(await execParseJson(pj(), {}, rs, 'dry_run'));
    assert.deepEqual(out.output, { id: null, status: null });
});

test('a simulated source that cannot be read is a labelled synthetic skip with a warning', async () => {
    const rs = state(OLD_PLACEHOLDER, true);
    const out = anyOf(await execParseJson(pj(), {}, rs, 'dry_run'));
    assert.equal(out.skippedReason, 'synthetic_source');
    assert.equal(out.dryRunSynthesised, true);
    assert.equal(out.output.id, null);
    assert.match(out.output.skipped, /simulated data/);
    assert.match(rs._templateWarnings.join('\n'), /^p: parse_json could not read the simulated data/);

    const items = anyOf(await execParseJson(pj({ sourceRef: 'steps.h.output.data', itemsRef: 'rows' }), {}, state(OLD_PLACEHOLDER, true), 'dry_run'));
    assert.deepEqual({ items: items.output.items, count: items.output.count }, { items: [], count: 0 });
});

test('without a Source path, a simulated upstream step counts too', async () => {
    const ctx = { definition: { edges: [{ from: 'h', to: 'p' }] } };
    const out = anyOf(await execParseJson(pj({ sourceRef: '' }), ctx, state('not json', true), 'dry_run'));
    assert.equal(out.skippedReason, 'synthetic_source');
});

test('REAL data that is not JSON still fails, in a dry run as live', async () => {
    for (const mode of ['dry_run', 'live']) {
        await assert.rejects(() => execParseJson(pj(), {}, state({ body: '<html>error</html>' }, false), mode), /not valid JSON/);
    }
});

test('a live run never takes the synthetic exit, even on a marked step', async () => {
    await assert.rejects(() => execParseJson(pj(), {}, state(OLD_PLACEHOLDER, true), 'live'), /not valid JSON|source is/);
});
