/**
 * The read features the query compiler had and the App Studio read path did not pass on:
 * `match: 'any'`, a free `search` over several columns and a case-insensitive `eq` (`ci`).
 * They travel from the binding or the request to the SQL, and a read without them compiles to
 * what it always did.
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
const { validateAppDefinition } = require('./validate');
const studioAppStore = require('../stores/studioAppStore');
const studioAppDbStore = require('../stores/studioAppDbStore');
const { optionalListQuery } = require('../routes/studio/appDataContext');
const { BINDING_READ_EXTRAS } = require('./componentSpecs');

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

test('a server step read resolves a search formula; an empty box leaves the search out', async () => {
    const calls = [];
    const viewer = { id: USER, role: 'owner' };
    const binding = { kind: 'records', tableId: 'tbl_task01', match: 'any', search: { value: { kind: 'formula', expr: 'q' }, fields: ['title'] } };
    await withDb(calls, async () => {
        await resolveDataBinding(APP, model, binding, { viewer, role: 'owner', resolveValue: () => 'needle' });
        await resolveDataBinding(APP, model, binding, { viewer, role: 'owner', resolveValue: () => '' });
    });
    assert.ok(calls[0].params.includes('%needle%'));
    assert.ok(!calls[1].params.some((p) => typeof p === 'string' && p.includes('%')), 'no search when nothing was typed');
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

test('canonicalize keeps match, search and ci on a records binding; an aggregate drops the search', () => {
    const source = {
        kind: 'records', tableId: 'tbl_task01', match: 'any',
        filter: [{ field: 'status', op: 'eq', value: 'x', ci: true }],
        search: { value: { kind: 'formula', expr: 'vars.filters.q' }, fields: ['title', 'note'] },
    };
    const kept = sourceOf(canonicalizeAppDefinition(def(source)).def);
    assert.strictEqual(kept.match, 'any');
    assert.strictEqual(kept.filter[0].ci, true);
    assert.deepStrictEqual(kept.search.fields, ['title', 'note']);
    const agg = sourceOf(canonicalizeAppDefinition(def({ kind: 'aggregate', tableId: 'tbl_task01', search: { value: 'x', fields: ['title'] }, match: 'any' })).def);
    assert.strictEqual(agg.search, undefined);
    assert.strictEqual(agg.match, 'any');
    assert.deepStrictEqual(BINDING_READ_EXTRAS.match.values, ['all', 'any']);
});

test('a binding without the new fields canonicalizes to a source with none of those keys', () => {
    const plain = sourceOf(canonicalizeAppDefinition(def({ kind: 'records', tableId: 'tbl_task01', filter: [{ field: 'status', op: 'eq', value: 'x' }] })).def);
    assert.deepStrictEqual(Object.keys(plain), ['kind', 'tableId', 'filter']);
});

test('the validator accepts a good search and names the bad ones', () => {
    const run = (source) => validateAppDefinition(canonicalizeAppDefinition(def(source)).def, { dataModel: model }).errors.map((e) => e.code);
    const good = { kind: 'records', tableId: 'tbl_task01', match: 'any', search: { value: 'x', fields: ['title'] } };
    assert.deepStrictEqual(run(good).filter((c) => c.startsWith('binding.')), []);
    assert.ok(run({ ...good, match: 'some' }).includes('binding.match_invalid'));
    assert.ok(run({ ...good, search: { value: 'x', fields: [] } }).includes('binding.search_invalid'));
    assert.ok(run({ ...good, search: { value: 'x', fields: ['nope'] } }).includes('binding.unknown_field'));
    assert.ok(run({ ...good, filter: [{ field: 'title', op: 'eq', value: 'a', ci: 'yes' }] }).includes('binding.filter_invalid'));
});
