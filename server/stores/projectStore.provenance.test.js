/**
 * O4 part C — where a Solution comes from, as the INSERT records it.
 *
 * Three columns, and all three are written at creation and never patched
 * afterwards: a second statement is a second thing that can fail, and leaves a
 * Solution that cannot say where it came from.
 *
 * What is pinned here:
 *
 *   1. THE THREE VALUES ARRIVE IN THE INSERT. Without this test `createProject`
 *      can silently drop them — the installer stays green, because it only checks
 *      what it PASSES, and the count stays at zero for good.
 *   2. NULL STAYS NULL. "Not recorded" is something other than version 1 and
 *      something other than an empty organization; an install without a number
 *      must never read as updated.
 *   3. THE PROVENANCE DECIDES NOTHING. The project's `organization_id` is that of
 *      the caller, and is separate from `installed_from_org_id`.
 *
 * Hermetic: `../db` is stubbed (the pattern of blueprintStore.releases.test.js),
 * so no Postgres is involved.
 *
 * Run: cd server && node --test stores/projectStore.provenance.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('module');

// ── De db-stub ──────────────────────────────────────────────────────────────

const calls = { run: [], exec: [], getOne: [], getAll: [] };
const state = { row: null };

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

const dbStub = {
    async exec(sql) { calls.exec.push(sql); return { rowCount: 0 }; },
    async run(sql, params) { calls.run.push({ sql, params }); return { rowCount: 1 }; },
    async getOne(sql, params) { calls.getOne.push({ sql, params }); return state.row; },
    async getAll(sql, params) { calls.getAll.push({ sql, params }); return []; },
    async getClient() { throw new Error('deze test heeft geen client nodig'); },
    isSqlStateError(err) { return typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code); },
    async withTransaction(fn) { return fn({ async query() { return { rows: [], rowCount: 0 }; } }); },
};

const STORES_DIR = path.sep + 'stores' + path.sep;
const STUB_PATH = path.join(__dirname, '__stub_db_project_provenance__.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(STORES_DIR) && (request === '../db' || request === '../../db')) {
        return STUB_PATH;
    }
    return origResolve.call(this, request, parent, ...rest);
};
require.cache[STUB_PATH] = { id: STUB_PATH, filename: STUB_PATH, loaded: true, exports: dbStub };

const store = require('./projectStore');

async function reset() {
    await store.initDB();
    for (const k of Object.keys(calls)) calls[k].length = 0;
    state.row = null;
}

/** De INSERT op `projects`, met zijn kolomlijst en zijn parameters. */
function insert() {
    const call = calls.run.find(c => /^INSERT INTO projects /.test(flat(c.sql)));
    assert.ok(call, 'er is een project ingevoegd');
    const columns = flat(call.sql).match(/INSERT INTO projects \(([^)]*)\)/)[1]
        .split(',').map(s => s.trim());
    const valueOf = (column) => call.params[columns.indexOf(column)];
    return { columns, valueOf, params: call.params };
}

const BASE = { name: 'Onboarding', ownerId: 'alice', organizationId: 'org_receiver' };

// ── 1. De drie waarden komen in de INSERT terecht ───────────────────────────

test('de herkomst wordt bij het aanmaken geschreven, niet achteraf', async () => {
    await reset();
    const created = await store.createProject({
        ...BASE,
        installedFromBlueprintId: 'bp_abc',
        installedFromOrgId: 'org_source',
        installedVersion: 3,
    });

    const { valueOf } = insert();
    assert.strictEqual(valueOf('installed_from_blueprint_id'), 'bp_abc');
    assert.strictEqual(valueOf('installed_from_org_id'), 'org_source');
    assert.strictEqual(valueOf('installed_version'), 3);

    // One statement, not a second UPDATE that still has to come afterwards.
    assert.strictEqual(calls.run.filter(c => /projects/.test(flat(c.sql))).length, 1);

    // En de aanroeper krijgt terug wat er is opgeschreven.
    assert.strictEqual(created.installedFromBlueprintId, 'bp_abc');
    assert.strictEqual(created.installedFromOrgId, 'org_source');
    assert.strictEqual(created.installedVersion, 3);
});

// ── 2. Null blijft null ─────────────────────────────────────────────────────

test('een project dat hier gebouwd is claimt geen herkomst', async () => {
    await reset();
    const created = await store.createProject(BASE);
    const { valueOf } = insert();
    assert.strictEqual(valueOf('installed_from_blueprint_id'), null);
    assert.strictEqual(valueOf('installed_from_org_id'), null);
    assert.strictEqual(valueOf('installed_version'), null,
        '"niet vastgelegd" is iets anders dan versie 1');
    assert.strictEqual(created.installedVersion, null);
});

test('een onzinnig versienummer wordt null, nooit 0 of 1', async () => {
    // 0 and a negative number are not versions but gaps, and a gap that reads as
    // 1 turns an unknown install into an updated one.
    for (const bogus of [0, -3, 1.5, '2', null, undefined, NaN]) {
        await reset();
        await store.createProject({ ...BASE, installedVersion: bogus });
        assert.strictEqual(insert().valueOf('installed_version'), null,
            `${String(bogus)} is geen versienummer`);
    }
});

test('een lege bewering is geen bewering', async () => {
    await reset();
    await store.createProject({ ...BASE, installedFromBlueprintId: '', installedFromOrgId: '' });
    const { valueOf } = insert();
    assert.strictEqual(valueOf('installed_from_blueprint_id'), null);
    assert.strictEqual(valueOf('installed_from_org_id'), null);
});

test('een bewering die geen string is komt de database niet in', async () => {
    await reset();
    await store.createProject({
        ...BASE,
        installedFromBlueprintId: { $ref: 'aut_1' },
        installedFromOrgId: ['org_source'],
    });
    const { valueOf } = insert();
    assert.strictEqual(valueOf('installed_from_blueprint_id'), null);
    assert.strictEqual(valueOf('installed_from_org_id'), null);
});

// ── 3. De herkomst beslist niets ────────────────────────────────────────────

test('de organisatie van het project is die van de aanroeper, niet die van de bron', async () => {
    // This is the column that determines visibility. If provenance filled it,
    // a file could grant itself read rights to another organization.
    await reset();
    await store.createProject({ ...BASE, installedFromOrgId: 'org_source' });
    const { valueOf } = insert();
    assert.strictEqual(valueOf('organization_id'), 'org_receiver');
    assert.strictEqual(valueOf('installed_from_org_id'), 'org_source');
});

// ── 4. De leeskant geeft dezelfde drie terug ────────────────────────────────

test('een gelezen project draagt zijn herkomst mee', async () => {
    await reset();
    state.row = {
        id: 'p1', name: 'Onboarding', organization_id: 'org_receiver', owner_id: 'alice',
        knowledge_base_ids: '[]', version: 0,
        installed_from_blueprint_id: 'bp_abc', installed_from_org_id: 'org_source', installed_version: 3,
    };
    const project = await store.getProject('p1');
    assert.strictEqual(project.installedFromBlueprintId, 'bp_abc');
    assert.strictEqual(project.installedFromOrgId, 'org_source');
    assert.strictEqual(project.installedVersion, 3);
});

test('een project uit een oudere rij leest als onbekend, niet als versie 1', async () => {
    // Rows from before these columns carry NULL. That must read as "we don't know" —
    // never as a number nobody wrote down.
    await reset();
    state.row = {
        id: 'p1', name: 'Onboarding', organization_id: '', owner_id: 'alice',
        knowledge_base_ids: '[]', version: 0,
        installed_from_blueprint_id: null, installed_from_org_id: null, installed_version: null,
    };
    const project = await store.getProject('p1');
    assert.strictEqual(project.installedFromOrgId, null);
    assert.strictEqual(project.installedVersion, null);
});
