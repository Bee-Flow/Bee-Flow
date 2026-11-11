/**
 * The read features the query compiler had and the App Studio read path did not pass on:
 * `match: 'any'`, a free `search` over several columns and a case-insensitive `eq` (`ci`).
 * `match` and `search` are request options (the records routes, app_query_data) and marked
 * binding keys (componentSpecs/keys/binding/, proved in bindingKeys.matchSearch.test.js). `ci` on a
 * filter clause is base behaviour (the compiler always honoured it), so a definition using it, or
 * the base operators, measures and buckets the editor now offers, keeps schema version 2.
 *
 * Run: node --test appStudio/dataRead.matchSearch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
const { canonicalizeDataModel } = require('./dataModel');
const { applyQueryData } = require('./builderTools/dataTools');
const { parseQueryArgs } = require('./builderTools/queryDataArgs');
const { resolveDataBinding } = require('./stepDataSource');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { requiredSchemaVersion } = require('./schemaSince.mts');
const studioAppStore = require('../stores/studioAppStore');
const studioAppDbStore = require('../stores/studioAppDbStore');
const { optionalListQuery } = require('../routes/studio/appDataContext');

const USER = 'user-1';
const APP = { id: 'app1', userId: USER };
const model = canonicalizeDataModel({
    tables: [{
        id: 'tbl_task01', key: 'tasks', name: 'Tasks', access: { default: 'owner' },
        fields: [{ id: 'fld_ti01', key: 'title', type: 'text' }, { id: 'fld_no01', key: 'note', type: 'text' }, { id: 'fld_st01', key: 'status', type: 'text' }],
    }],
}).model;
const wrap = () => ({ appId: APP.id, userId: USER, dataModel: model, datasetIds: [] });

async function withDb(calls, fn) {
    const saved = [studioAppStore.getStudioApp, studioAppDbStore.query];
    studioAppStore.getStudioApp = async () => APP;
    studioAppDbStore.query = async (owner, appId, sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
    try { return await fn(); } finally { [studioAppStore.getStudioApp, studioAppDbStore.query] = saved; }
}

test('app_query_data: match, search and ci reach the SQL, bound as values', async () => {
    const calls = [];
    await withDb(calls, async () => {
        const out = await applyQueryData(wrap(), {
            tableId: 'tbl_task01',
            filter: [{ field: 'status', op: 'eq', value: 'Open', ci: true }, { field: 'title', op: 'eq', value: 'a' }],
            match: 'any',
            search: { value: 'foo%', fields: ['title', 'note'] },
        });
        assert.ok(!out.error, JSON.stringify(out));
    });
    const { sql, params } = calls[0];
    assert.match(sql, /"status" (I?LIKE) \? ESCAPE/i);
    assert.match(sql, / OR /);
    assert.ok(params.includes('Open'));
    assert.ok(params.includes('%foo\\%%'), 'the search value is escaped and bound');
    assert.ok(!sql.includes('foo'), 'no value in the SQL text');
});

test('app_query_data without the new fields compiles to the same SQL as before', async () => {
    const plain = [];
    const withUndefined = [];
    await withDb(plain, () => applyQueryData(wrap(), { tableId: 'tbl_task01', filter: [{ field: 'status', op: 'eq', value: 'x' }] }));
    await withDb(withUndefined, () => applyQueryData(wrap(), { tableId: 'tbl_task01', filter: [{ field: 'status', op: 'eq', value: 'x' }], match: null, search: null }));
    assert.deepStrictEqual(plain, withUndefined);
    assert.ok(!/ OR | LIKE /i.test(plain[0].sql));
});

test('app_query_data refuses a bad match or search with a hint', () => {
    assert.match(parseQueryArgs({ tableId: 't', match: 'some' }).error, /match/);
    assert.match(parseQueryArgs({ tableId: 't', search: { value: '', fields: ['a'] } }).error, /search/);
    assert.match(parseQueryArgs({ tableId: 't', search: { value: 'x', fields: [] } }).error, /search/);
    assert.deepStrictEqual(parseQueryArgs({ tableId: 't', match: 'any', search: { value: 'x', fields: ['a'], extra: 1 } }).search, { value: 'x', fields: ['a'] });
});

test('the list route query: match and search are read only when sent', () => {
    assert.deepStrictEqual(optionalListQuery({}), {});
    assert.deepStrictEqual(optionalListQuery({ match: 'any', search: '{"value":"a","fields":["t"]}' }), { match: 'any', search: { value: 'a', fields: ['t'] } });
    assert.deepStrictEqual(optionalListQuery({ search: 'not json' }), {});
});


const def = (source) => ({
    schemaVersion: 2,
    meta: { name: 'T' },
    homeScreenId: 'scr_a',
    screens: [{ id: 'scr_a', name: 'A', sections: [{ id: 'sec_a', children: [{ id: 'cmp_a', type: 'keyValue', props: { source } }] }] }],
});
const sourceOf = (d) => d.screens[0].sections[0].children[0].props.source;

test('ci and the base words the editor now offers keep a definition at schema version 2', () => {
    const records = {
        kind: 'records', tableId: 'tbl_task01',
        filter: [
            { field: 'status', op: 'eq', value: 'x', ci: true },
            { field: 'title', op: 'endsWith', value: 'a' },
            { field: 'note', op: 'notContains', value: 'b' },
            { field: 'status', op: 'notIn', value: ['c'] },
        ],
    };
    const aggregate = {
        kind: 'aggregate', tableId: 'tbl_task01',
        groupBy: [{ field: 'created_at', bucket: 'hour' }],
        aggregates: [{ fn: 'p50', field: 'title' }, { fn: 'p90', field: 'title' }],
    };
    for (const source of [records, aggregate]) {
        const out = canonicalizeAppDefinition(def(source)).def;
        assert.strictEqual(out.schemaVersion, 2);
        assert.strictEqual(requiredSchemaVersion(out), 2);
    }
    assert.strictEqual(sourceOf(canonicalizeAppDefinition(def(records)).def).filter[0].ci, true, 'canonicalize keeps ci as it always did');
});

test('a step read passes a binding\'s match on and its search with the value made literal', async () => {
    const plain = { kind: 'records', tableId: 'tbl_task01', filter: [{ field: 'status', op: 'eq', value: 'x' }] };
    const viewer = { id: USER, role: 'owner' };
    const run = async (binding, resolveValue) => {
        const calls = [];
        await withDb(calls, () => resolveDataBinding(APP, model, binding, { viewer, role: 'owner', resolveValue }));
        return calls[0];
    };
    const base = await run(plain);
    // A search box with nothing typed reads as the binding without a search.
    assert.deepStrictEqual(await run({ ...plain, search: { value: { kind: 'formula', expr: 'vars.q' }, fields: ['title'] } }, () => ''), base);
    const searched = await run({ ...plain, match: 'any', search: { value: { kind: 'formula', expr: 'vars.q' }, fields: ['title', 'note'] } }, () => 'needle');
    assert.match(searched.sql, / OR /);
    assert.ok(searched.params.includes('%needle%'));
    assert.ok(!searched.sql.includes('needle'));
});
