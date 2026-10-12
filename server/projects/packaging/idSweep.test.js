/**
 * The raw-id sweep, and the one repair it allows.
 *
 * The registry rewrites the pointers it knows. This sweep is what catches the
 * ones it does not: an id typed into a code step, a template, a page's script.
 * In a stage that id would still resolve to the Dev part. Whole tokens only, in
 * both directions: a sweep that matched inside longer strings would block
 * releases over nothing, and a substitution that did would corrupt code.
 *
 * Pure: no store, no module mocking.
 *
 * Run: cd server && node --test projects/packaging/idSweep.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sweepRawIds, substituteTableTokens, isTableToken } = require('./idSweep');

test('the sweep finds a member id inside a code step', () => {
    const entities = {
        automations: [{
            ref: 'aut_1',
            definition: { steps: [{ id: 's1', type: 'code', inputs: { code: { kind: 'literal', value: "await call('aut_live_42');" } } }] },
        }],
    };
    assert.deepStrictEqual(sweepRawIds(entities, ['aut_live_42']), [
        { ref: 'aut_1', path: 'definition.steps[0].inputs.code.value', id: 'aut_live_42' },
    ]);
});

test('only a whole token is a hit', () => {
    const entities = [{ ref: 'app_1', definition: { note: 'aut_live_421 xaut_live_42 aut_live_42_old' } }];
    assert.deepStrictEqual(sweepRawIds(entities, ['aut_live_42']), []);
});

test('an id used as an object key is a hit too', () => {
    const entities = [{ ref: 'app_1', definition: { byTable: { tbl_0123456789ab: { mode: 'read' } } } }];
    const hits = sweepRawIds(entities, ['tbl_0123456789ab']);
    assert.strictEqual(hits.length, 1);
    assert.match(hits[0].path, /#key$/);
});

test('every hit names the entity it sits in; the ref field itself is never one', () => {
    const entities = {
        webpages: [{ ref: 'web_1', files: { js: 'beeflowTables.read("tbl_0123456789ab")' } }],
        datatables: [{ ref: 'dt_1', key: 'invoices' }],
    };
    const hits = sweepRawIds(entities, ['tbl_0123456789ab', 'dt_1']);
    assert.deepStrictEqual(hits, [{ ref: 'web_1', path: 'files.js', id: 'tbl_0123456789ab' }]);
});

test('no member ids, malformed input: nothing found, nothing thrown', () => {
    assert.deepStrictEqual(sweepRawIds({ automations: [{ ref: 'aut_1' }] }, []), []);
    assert.deepStrictEqual(sweepRawIds(null, ['abc']), []);
    assert.deepStrictEqual(sweepRawIds({ automations: 'nope' }, ['abc']), []);
});

test('token substitution is whole-token only', () => {
    const map = new Map([['tbl_0123456789ab', 'tbl_ffffffffffff']]);
    const source = [
        'read("tbl_0123456789ab")',     // replaced
        'tbl_0123456789ab.rows',          // replaced: a dot ends the token
        'tbl_0123456789abc',              // longer token: untouched
        'xtbl_0123456789ab',              // embedded: untouched
        'tbl_0123456789ab_backup',        // embedded: untouched
        'tbl_aaaaaaaaaaaa',               // not in the map: untouched
    ].join('\n');
    const { text, substitutions } = substituteTableTokens(source, map);
    assert.deepStrictEqual(text.split('\n'), [
        'read("tbl_ffffffffffff")',
        'tbl_ffffffffffff.rows',
        'tbl_0123456789abc',
        'xtbl_0123456789ab',
        'tbl_0123456789ab_backup',
        'tbl_aaaaaaaaaaaa',
    ]);
    assert.deepStrictEqual(substitutions, [{ from: 'tbl_0123456789ab', to: 'tbl_ffffffffffff', count: 2 }]);
});

test('substitution takes a plain object too, and survives a non-string', () => {
    assert.strictEqual(substituteTableTokens('tbl_0123456789ab', { tbl_0123456789ab: 'tbl_111111111111' }).text, 'tbl_111111111111');
    assert.deepStrictEqual(substituteTableTokens(null, {}), { text: null, substitutions: [] });
});

test('isTableToken is the exact minted shape', () => {
    assert.strictEqual(isTableToken('tbl_0123456789ab'), true);
    assert.strictEqual(isTableToken('tbl_0123'), false);
    assert.strictEqual(isTableToken('tbl_0123456789AB'), false);
});
