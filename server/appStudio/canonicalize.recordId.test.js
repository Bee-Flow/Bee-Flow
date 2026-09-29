/**
 * `recordId` on a record binding.
 *
 * The guide documents it, the validator accepts it, and until this fix nothing
 * read it — so a binding that named a record fetched the table's FIRST row and
 * rendered it as that record. On a detail screen that showed one customer's
 * name over another customer's data, silently.
 *
 * It has always meant `id == this`, so canonicalisation says so in the one
 * filter grammar the browser and stepDataSource both already honour.
 *
 * Run: node --test appStudio/canonicalize.recordId.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { canonicalizeAppDefinition } = require('./canonicalize');

function defWith(binding) {
    return {
        schemaVersion: 2,
        meta: { name: 'T' },
        homeScreenId: 'scr_a',
        screens: [{
            id: 'scr_a',
            name: 'A',
            sections: [{
                id: 'sec_a',
                children: [{ id: 'cmp_a', type: 'keyValue', props: { source: binding } }],
            }],
        }],
    };
}

function sourceOf(def) {
    return def.screens[0].sections[0].children[0].props.source;
}

test('a literal recordId becomes an id filter', () => {
    const { def } = canonicalizeAppDefinition(defWith({ kind: 'record', tableId: 'tbl_x', recordId: 'rec_42' }));
    const src = sourceOf(def);
    assert.deepStrictEqual(src.filter, [{ field: 'id', op: 'eq', value: 'rec_42' }]);
    assert.strictEqual(src.recordId, undefined, 'the dead field does not survive');
});

test('a formula recordId keeps its formula — it resolves before the fetch', () => {
    const { def } = canonicalizeAppDefinition(defWith({
        kind: 'record', tableId: 'tbl_x', path: 'klantnaam',
        recordId: { kind: 'formula', expr: 'vars.selected' },
    }));
    const src = sourceOf(def);
    assert.deepStrictEqual(src.filter, [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.selected' } }]);
    assert.strictEqual(src.path, 'klantnaam', 'path still selects the column');
});

test("the author's own filters survive, narrowing further", () => {
    const { def } = canonicalizeAppDefinition(defWith({
        kind: 'record', tableId: 'tbl_x', recordId: 'rec_42',
        filter: [{ field: 'status', op: 'eq', value: 'open' }],
    }));
    assert.deepStrictEqual(sourceOf(def).filter, [
        { field: 'id', op: 'eq', value: 'rec_42' },
        { field: 'status', op: 'eq', value: 'open' },
    ]);
});

test('a record binding without recordId is untouched', () => {
    const { def } = canonicalizeAppDefinition(defWith({
        kind: 'record', tableId: 'tbl_x',
        filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.selected' } }],
    }));
    assert.deepStrictEqual(sourceOf(def).filter, [
        { field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.selected' } },
    ]);
});

test('the repair is reported, not silent', () => {
    const { repairs } = canonicalizeAppDefinition(defWith({ kind: 'record', tableId: 'tbl_x', recordId: 'rec_42' }));
    assert.ok(repairs.some((r) => r.code === 'binding.record_id_to_filter'), JSON.stringify(repairs));
});
