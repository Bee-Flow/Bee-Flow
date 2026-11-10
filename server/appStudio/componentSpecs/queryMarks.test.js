// @typecheck
/**
 * queryMarks.js: the key-mark families of a data read. `keys/binding/<key>.js` marks a key a
 * binding newly takes, `keys/queryShape/<key>.<name>.js` a form the value under a key newly takes.
 *
 * The mechanism is proved with directories written per test and with the test-only fixtures
 * (testUtils/appCatalogExtensions.testkit.js); the registries ship empty.
 * Run: node --test appStudio/componentSpecs/queryMarks.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadKeyMarks, KEY_MARKS } = require('./keyMarks');
const marks = require('./queryMarks');

/** @type {string[]} */
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

/** A registry directory holding `files` ({ 'family/name.js': the source of the exported object }). */
function registry(/** @type {Record<string, string>} */ files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-query-marks-'));
    made.push(dir);
    for (const [name, body] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `module.exports = ${body};\n`);
    }
    return dir;
}

const SEARCH = `{ since: 3, kinds: ['record', 'records'], shape: 'string ≤200', description: 'Free text matched against every text column.', clean: (v) => (typeof v === 'string' ? v.slice(0, 200) : undefined) }`;
const NESTED = `{ since: 3, shape: '{ all: […] }', description: 'Groups inside groups.', uses: (list) => Array.isArray(list) && list.some((e) => e !== null && typeof e === 'object' && Array.isArray(e.all)) }`;
const RELATED = `{ since: 4, entryKey: true, shape: 'string', description: 'Groups by a field of the related row.', clean: (v) => (typeof v === 'string' && v ? v : undefined) }`;

test('the registries ship empty', () => {
    assert.deepEqual(Object.keys(KEY_MARKS.binding), []);
    assert.deepEqual(Object.keys(KEY_MARKS.queryShape), []);
});

test('loads a binding key and both kinds of query shape, the file name being the name the index lists', () => {
    const loaded = loadKeyMarks(registry({
        'binding/search.js': SEARCH,
        'queryShape/filter.nestedGroups.js': NESTED,
        'queryShape/groupBy.relatedField.js': RELATED,
    }));
    assert.deepEqual(Object.keys(loaded.binding), ['search']);
    assert.deepEqual(Object.keys(loaded.queryShape), ['filter.nestedGroups', 'groupBy.relatedField']);
    assert.equal(/** @type {any} */ (loaded.binding.search).clean('x'.repeat(300)).length, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(marks.bindingKeysSince(loaded.binding))), { record: { search: 3 }, records: { search: 3 } });
    const { since, tests } = marks.queryShapeIndex(/** @type {any} */ (loaded.queryShape), loaded.binding);
    assert.deepEqual(JSON.parse(JSON.stringify(since)), {
        filter: { 'filter.nestedGroups': 3 }, replaceWhere: { 'filter.nestedGroups': 3 }, groupBy: { 'groupBy.relatedField': 4 },
    });
    assert.equal(tests.filter['filter.nestedGroups']([{ all: [] }]), true);
    assert.equal(tests.replaceWhere['filter.nestedGroups']([{ any: [] }]), false);
    assert.equal(tests.groupBy['groupBy.relatedField']([{ field: 'owner', relatedField: 'name' }]), true);
    assert.equal(tests.groupBy['groupBy.relatedField']([{ field: 'owner' }]), false);
    assert.equal(tests.groupBy['groupBy.relatedField']({ kind: 'formula', expr: 'x' }), false);
});

test('a binding key without kinds is marked on all four; one that holds a clause list is read like a filter', () => {
    assert.deepEqual(Object.keys(marks.bindingKeysSince({ expand: { since: 3 } })), [...marks.QUERY_BINDING_KINDS]);
    const { since } = marks.queryShapeIndex({ 'filter.nested': { since: 3, shape: 's', description: 'd.', uses: () => false } }, { groupFilter: { holds: 'filter' }, search: {} });
    assert.deepEqual(Object.keys(since), ['filter', 'replaceWhere', 'groupFilter']);
});

test('refuses a mark that is incomplete or sits in the wrong place, and says what to fix', () => {
    /** @type {Array<[Record<string, string>, RegExp]>} */
    const cases = [
        [{ 'binding/search.js': `{ since: 3, shape: 's', description: 'd.' }` }, /"clean" is the function the canonicalizer keeps the key with/],
        [{ 'binding/search.js': `{ since: 2, shape: 's', description: 'd.', clean: (v) => v }` }, /integer "since" of 3 or more/],
        [{ 'binding/search.js': `{ since: 3, description: 'd.', clean: (v) => v }` }, /"shape" gives the value's shape/],
        [{ 'binding/search.js': `{ since: 3, shape: 's', description: ' ', clean: (v) => v }` }, /"description" says in one sentence/],
        [{ 'binding/search.js': `{ since: 3, valuesSince: { a: 3 }, shape: 's', description: 'd.', clean: (v) => v }` }, /"valuesSince" is not read here/],
        [{ 'binding/filter.js': `{ since: 3, shape: 's', description: 'd.', clean: (v) => v }` }, /"filter" is a base key of record bindings; a new form of its value is a keys\/queryShape\/filter\.<name>\.js file/],
        [{ 'binding/groupBy.js': `{ since: 3, kinds: ['aggregate'], shape: 's', description: 'd.', clean: (v) => v }` }, /a base key of aggregate bindings/],
        [{ 'binding/search.js': `{ since: 3, kinds: ['formula'], shape: 's', description: 'd.', clean: (v) => v }` }, /"formula" is not a binding kind a key can be marked on \(record, records, aggregate, dataset\)/],
        [{ 'binding/search.js': `{ since: 3, kinds: [], shape: 's', description: 'd.', clean: (v) => v }` }, /"kinds" lists the binding kinds/],
        [{ 'binding/search.js': `{ since: 3, holds: 'rows', shape: 's', description: 'd.', clean: (v) => v }` }, /"holds" names the base key the value is read like/],
        [{ 'binding/my-key.js': SEARCH }, /named after the key/],
        [{ 'binding/search.js': 'null' }, /must export an object/],
        [{ 'queryShape/nested.js': NESTED }, /named <key>\.<name>\.js, <key> being the key the form sits under \(filter, sort, groupBy, aggregates, params\)/],
        [{ 'queryShape/rows.nested.js': NESTED }, /named <key>\.<name>\.js/],
        [{ 'queryShape/filter.a.b.js': NESTED }, /named <key>\.<name>\.js/],
        [{ 'queryShape/filter.nested.js': `{ since: 3, shape: 's', description: 'd.' }` }, /"uses" is the predicate/],
        [{ 'queryShape/filter.nested.js': `{ since: 3, shape: 's', description: 'd.', uses: (list) => list.length > 0 }` }, /"uses" threw for undefined/],
        [{ 'queryShape/filter.nested.js': `{ since: 3, shape: 's', description: 'd.', uses: (list) => Array.isArray(list) }` }, /"uses" answered true for \[\]; it answers false for what is not the form/],
        [{ 'queryShape/filter.nested.js': `{ since: 3, shape: 's', description: 'd.', uses: () => undefined }` }, /"uses" answered undefined for undefined/],
        [{ 'queryShape/filter.nested.js': `{ since: 3, shape: 's', description: 'd.', uses: () => false, clean: (v) => v }` }, /"clean" goes with "entryKey: true"/],
        [{ 'queryShape/filter.other.js': `{ since: 3, entryKey: true, shape: 's', description: 'd.', clean: (v) => v }` }, /"entryKey: true" marks a key of the entries of groupBy or aggregates/],
        [{ 'queryShape/groupBy.bucket.js': `{ since: 3, entryKey: true, shape: 's', description: 'd.', clean: (v) => v }` }, /"bucket" is a base key of a groupBy entry/],
        [{ 'queryShape/groupBy.step.js': `{ since: 3, entryKey: true, shape: 's', description: 'd.' }` }, /"clean" is the function the canonicalizer keeps the entry key with/],
        [{ 'queryShape/groupBy.step.js': `{ since: 3, entryKey: true, shape: 's', description: 'd.', clean: (v) => v, uses: () => false }` }, /an entry key has no "uses"/],
    ];
    for (const [files, message] of cases) {
        assert.throws(() => loadKeyMarks(registry(files)), message, JSON.stringify(Object.keys(files)));
    }
});

test('the base keys of each binding kind and of each rebuilt entry are the keys the canonicalizer has always written', () => {
    const { cleanBinding } = require('../canonicalize/bindings');
    const filter = [{ field: 'a', op: 'eq', value: 1 }];
    const query = { tableId: 'tbl_x', filter, sort: [{ field: 'a', dir: 'asc' }], limit: 5, pick: { row: 'first', column: 'a' }, zz_unknown: 1 };
    /** @type {Record<string, Record<string, unknown>>} */
    const full = {
        record: { kind: 'record', path: 'a', ...query },
        records: { kind: 'records', ...query },
        aggregate: { kind: 'aggregate', ...query, groupBy: [{ field: 'd', bucket: 'month', as: 'm', zz_unknown: 1 }], aggregates: [{ fn: 'sum', field: 'a', as: 's', zz_unknown: 1 }] },
        dataset: { kind: 'dataset', datasetId: 'ds_x', params: { a: 1 }, pick: { row: 'first' }, zz_unknown: 1 },
    };
    assert.deepEqual(Object.keys(full), [...marks.QUERY_BINDING_KINDS]);
    for (const kind of marks.QUERY_BINDING_KINDS) {
        const out = cleanBinding(full[kind], 'p', () => {});
        const base = marks.BINDING_BASE_KEYS[/** @type {keyof typeof marks.BINDING_BASE_KEYS} */ (kind)];
        // Every key written is a base key, and every base key but the folded `recordId` is written.
        assert.deepEqual(Object.keys(out).filter((k) => !base.includes(k)), [], kind);
        assert.deepEqual(base.filter((k) => !Object.hasOwn(out, k)), kind === 'record' ? ['recordId'] : [], kind);
    }
    const aggregate = cleanBinding(full.aggregate, 'p', () => {});
    assert.deepEqual(Object.keys(aggregate.groupBy[0]), [...marks.ENTRY_BASE_KEYS.groupBy]);
    assert.deepEqual(Object.keys(aggregate.aggregates[0]), [...marks.ENTRY_BASE_KEYS.aggregates]);
    // recordId is read (and folded into the filter), so it is a base key of a record binding too.
    assert.deepEqual(cleanBinding({ kind: 'record', tableId: 'tbl_x', recordId: 'r1' }, 'p', () => {}).filter, [{ field: 'id', op: 'eq', value: 'r1' }]);
    // The keys a shape can sit under are base keys of a binding that reads rows.
    const everyBase = Object.values(marks.BINDING_BASE_KEYS).flat();
    for (const key of marks.QUERY_SHAPE_KEYS) assert.ok(everyBase.includes(key), key);
    for (const list of Object.keys(marks.ENTRY_BASE_KEYS)) assert.ok(marks.QUERY_SHAPE_KEYS.includes(list), list);
});

test('the test-only fixtures are marks the loader would accept, and no component type is named like a shape key', () => {
    const { installExtensionFixtures } = require('../../testUtils/appCatalogExtensions.testkit');
    const specs = require('../componentSpecs');
    const uninstall = installExtensionFixtures();
    try {
        for (const [key, mark] of Object.entries(specs.KEY_MARKS.binding)) assert.deepEqual(marks.bindingMarkProblems(key, mark), [], key);
        for (const [name, mark] of Object.entries(specs.KEY_MARKS.queryShape)) assert.deepEqual(marks.queryShapeProblems(name, mark), [], name);
        assert.ok(Object.keys(specs.KEY_MARKS.binding).length >= 2 && Object.keys(specs.KEY_MARKS.queryShape).length >= 2);
    } finally {
        uninstall();
    }
    // 'binding.x', 'filter.x', 'groupBy.x' … name items of the data family; a type of that name would read like one of them.
    const reserved = ['binding', ...marks.QUERY_SHAPE_KEYS];
    assert.deepEqual(specs.COMPONENT_TYPES.filter((/** @type {string} */ type) => reserved.includes(type)), []);
});
