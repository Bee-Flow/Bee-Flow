/**
 * A miss inside JSON text does not parse the body again for every item.
 *
 * A path into JSON text (`steps.http.output.body.data.x`, body being text)
 * is parsed once per run: path.mjs caches the parse on the run's `steps`
 * object, which every per-binding and per-item scope shares. Describing a
 * MISS for the binding log used to parse the same body twice more (what was
 * there, and how long the list was) without that cache, once per item of a
 * forEach: on a multi-megabyte body, seconds of blocked event loop.
 *
 * Run: node --test automation/bind.jsonCache.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveValue, withBindingLog } = require('./bind');

/** Run `fn` and count the JSON.parse calls that parse exactly `text`. */
function countParses(text, fn) {
    const real = JSON.parse;
    let n = 0;
    JSON.parse = function (s, ...rest) {
        if (s === text) n++;
        return real.call(this, s, ...rest);
    };
    try { fn(); } finally { JSON.parse = real; }
    return n;
}

test('a miss inside a JSON-text body is described without parsing the body again per item', () => {
    const body = JSON.stringify({ data: { items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item ${i}` })) } });
    assert.ok(body.length >= 256, 'precondition: long enough to be cached');
    const run = { trigger: { output: {} }, steps: { http: { output: { body } } }, vars: {}, loop: {}, secrets: {} };
    const entries = [];
    const parses = countParses(body, () => withBindingLog(entries, () => {
        for (let i = 0; i < 25; i++) {
            const scope = { ...run, loop: { item: i } };
            assert.equal(resolveValue({ kind: 'ref', path: 'steps.http.output.body.nope' }, scope), undefined);
            assert.equal(resolveValue({ kind: 'ref', path: 'steps.http.output.body.data.items.nope' }, scope), undefined);
        }
    }));
    assert.equal(parses, 1, 'one parse for the whole run');
    const atBody = entries.find(e => e.path === 'steps.http.output.body.nope');
    assert.equal(atBody.found, 'record');
    assert.equal(atBody.count, 25);
    const atList = entries.find(e => e.path === 'steps.http.output.body.data.items.nope');
    assert.equal(atList.found, 'list');
    assert.equal(atList.size, 40);
});
