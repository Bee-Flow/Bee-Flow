'use strict';
/**
 * erasureCoverage.js MODULE_TABLES agrees with the tree, every module visible: a table the erasure
 * names (the coverage map, the organisation cascade's list in orgErasure.js, a statement in
 * organizations.js or contentErasure.js) that a module-owned file creates is listed under that
 * module, the owner in scripts/module-map.json of the file with its CREATE TABLE; a table no
 * module file creates is not listed; nothing is listed that the erasure does not name.
 *
 * Run: cd server && node --test stores/user/erasureCoverage.moduleTables.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ERASURE_COVERAGE, MODULE_TABLES, moduleOfTable } = require('./erasureCoverage');
const { ORG_KEYED_TABLES } = require('./orgErasure');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SOURCE = /\.(c?js|mts|sql)$/;
const NOT_SOURCE = /\.test\.|\.testkit\.|^testUtils\/|^scripts\/|^journeys\//;
const CREATE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/g;
const NAMED = /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+"?([a-z_][a-z0-9_]*)"?/g;
/** The erasure's own files whose SQL names tables directly. */
const ERASURE_FILES = ['organizations.js', 'contentErasure.js', 'orgErasure.js'];

/** @type {Map<string, Set<string>>} table -> owners of the files that create it ('core' for none) */
const creators = new Map();

before(async () => {
    const { walkTree } = await import(path.join(REPO, 'scripts', 'lib', 'roots.mjs'));
    const { loadModuleMap } = await import(path.join(REPO, 'scripts', 'module-map.mjs'));
    const map = loadModuleMap();
    for (const f of walkTree('server')) {
        if (!SOURCE.test(f.treePath) || NOT_SOURCE.test(f.treePath)) continue;
        const src = fs.readFileSync(f.abs, 'utf8');
        for (const m of src.matchAll(CREATE)) {
            const table = /** @type {string} */ (m[1]).toLowerCase();
            if (table === 'if') continue; // CREATE TABLE IF NOT EXISTS ${name}: built from parts
            const owners = creators.get(table) ?? new Set();
            owners.add(map.ownerOf('server', f.treePath) || 'core');
            creators.set(table, owners);
        }
    }
});

/** Every table the erasure names. */
function namedTables() {
    const names = new Set([...Object.keys(ERASURE_COVERAGE), ...ORG_KEYED_TABLES.map(([t]) => t)]);
    for (const file of ERASURE_FILES) {
        const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
        for (const m of src.matchAll(NAMED)) names.add(/** @type {string} */ (m[1]).toLowerCase());
    }
    return names;
}

/**
 * The module whose file creates the table, or null: a table a core file creates is the core's
 * (a module's test schema may create core tables too).
 * @param {string} table
 */
function creatorModule(table) {
    const all = creators.get(table) ?? new Set();
    if (all.has('core')) return null;
    const owners = [...all];
    assert.ok(owners.length <= 1, `${table} is created by files of ${owners.join(', ')}`);
    return owners[0] ?? null;
}

test('every table the erasure names is listed under the module that creates it, or not at all', () => {
    /** @type {string[]} */
    const wrong = [];
    for (const table of namedTables()) {
        const expected = creatorModule(table);
        if (moduleOfTable(table) !== expected) wrong.push(`${table}: listed under ${moduleOfTable(table)}, created by ${expected ?? 'the core'}`);
    }
    assert.deepEqual(wrong, []);
});

test('MODULE_TABLES lists only tables the erasure names, each once', () => {
    const named = namedTables();
    const listed = Object.values(MODULE_TABLES).flat();
    assert.equal(new Set(listed).size, listed.length, 'a table is listed twice');
    assert.deepEqual(listed.filter((t) => !named.has(t)), []);
});
