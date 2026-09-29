/**
 * migrationPlan's `onlyTableIds` scope.
 *
 * The rest of the planner (renames, stored-computed rebuilds, drop ordering) is
 * exercised by appStudio/dataModel.test.js against the same object — this file
 * is about the ONE option App Studio does not use.
 *
 * ── WHY THE SCOPE EXISTS ────────────────────────────────────────────
 * Datatables keep ONE model document per organisation, so a create, a delete or
 * a single-table schema save diffs two whole-org models. Without a scope the
 * plan carries out everything the two documents disagree about — including a
 * concurrent editor's half-finished DROP COLUMN on a table this request never
 * mentioned. The person who pressed "Add a column" then drops somebody else's.
 *
 * Run: cd server && node --test --test-force-exit core/dataEngine/dataModel/migrationPlan.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { migrationPlan } = require('./migrationPlan');

const f = (id, key, over = {}) => ({ id, key, name: key, type: 'text', ...over });
const t = (id, key, fields) => ({ id, key, name: key, fields });
const model = (tables) => ({ modelVersion: 1, tables });

// Two tables in one org model: the one this request is about, and a colleague's.
const MINE = t('tbl_mine', 'customers', [f('fld_a', 'email')]);
const THEIRS = t('tbl_theirs', 'invoices', [f('fld_x', 'amount'), f('fld_y', 'vat')]);

test('with no scope the plan carries out EVERY difference — the shape the scope exists to stop', () => {
    const before = model([MINE, THEIRS]);
    const after = model([
        t('tbl_mine', 'customers', [f('fld_a', 'email'), f('fld_b', 'status')]),
        // A colleague's half-finished edit, sitting in the same document.
        t('tbl_theirs', 'invoices', [f('fld_x', 'amount')]),
    ]);
    const plan = migrationPlan(before, after, { dialect: 'pg' });
    assert.ok(plan.some(s => /ADD COLUMN IF NOT EXISTS "status"/.test(s)));
    assert.ok(plan.some(s => /DROP COLUMN IF EXISTS "vat"/.test(s)),
        'without a scope the unrelated drop rides along — this is the bug, pinned');
});

test('onlyTableIds emits DDL for the named table and NOTHING for the others', () => {
    const before = model([MINE, THEIRS]);
    const after = model([
        t('tbl_mine', 'customers', [f('fld_a', 'email'), f('fld_b', 'status')]),
        t('tbl_theirs', 'invoices', [f('fld_x', 'amount')]),
    ]);
    const plan = migrationPlan(before, after, { dialect: 'pg', onlyTableIds: ['tbl_mine'] });
    assert.deepStrictEqual(plan, ['ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "status" TEXT']);
});

test('the scope covers every step, not just ADD COLUMN', () => {
    // Each of the seven planner steps has its own `if (!inScope(id)) continue`,
    // and a step that lost its guard would leak exactly one kind of statement.
    const before = model([
        t('tbl_mine', 'customers', [f('fld_a', 'email')]),
        t('tbl_theirs', 'invoices', [f('fld_x', 'amount', { unique: true }), f('fld_y', 'vat')]),
        t('tbl_gone', 'scratch', [f('fld_z', 'note')]),
    ]);
    const after = model([
        t('tbl_mine', 'customers', [f('fld_a', 'email')]),
        // A rename, a unique toggle and a drop on a table outside the scope.
        t('tbl_theirs', 'facturen', [f('fld_x', 'amount')]),
        // And a brand-new table outside it.
        t('tbl_new', 'leads', [f('fld_n', 'source')]),
    ]);
    const plan = migrationPlan(before, after, { dialect: 'pg', onlyTableIds: ['tbl_mine'] });
    assert.deepStrictEqual(plan, [], 'nothing outside the scope may reach Postgres');

    // The same diff, unscoped, really does produce all of it — otherwise the
    // assertion above would pass for the wrong reason.
    const wide = migrationPlan(before, after, { dialect: 'pg' });
    assert.ok(wide.some(s => /RENAME TO "facturen"/.test(s)));
    assert.ok(wide.some(s => /CREATE TABLE IF NOT EXISTS "leads"/.test(s)));
    assert.ok(wide.some(s => /DROP INDEX IF EXISTS/.test(s)));
    assert.ok(wide.some(s => /DROP COLUMN IF EXISTS "vat"/.test(s)));
    assert.ok(wide.some(s => /DROP TABLE IF EXISTS "scratch"/.test(s)));
});

test('an EMPTY onlyTableIds means "touch nothing", never "no scope given"', () => {
    // `opts.onlyTableIds?.length` would read [] as absent and widen the plan to
    // the whole model — the silent opposite of what the caller asked for.
    const before = model([MINE]);
    const after = model([t('tbl_mine', 'customers', [f('fld_a', 'email'), f('fld_b', 'status')])]);
    assert.deepStrictEqual(migrationPlan(before, after, { dialect: 'pg', onlyTableIds: [] }), []);
});

test('a scoped CREATE still resolves a relation to a table outside the scope', () => {
    // The diff deliberately runs over the WHOLE model even when the plan is
    // narrowed: a relation column's REFERENCES names a target that may sit
    // outside the scope, and a plan built from a truncated model would emit a
    // dangling reference instead.
    const before = model([THEIRS]);
    const after = model([
        THEIRS,
        t('tbl_mine', 'customers', [
            f('fld_a', 'email'),
            f('fld_r', 'invoice', { type: 'relation', relation: { table: 'tbl_theirs' } }),
        ]),
    ]);
    const plan = migrationPlan(before, after, { dialect: 'pg', onlyTableIds: ['tbl_mine'] });
    assert.strictEqual(plan.length, 1);
    assert.match(plan[0], /CREATE TABLE IF NOT EXISTS "customers"/);
    assert.match(plan[0], /"invoices"/, 'the FK target must be resolved by KEY, from the whole model');
});

// ── De TWEEDE TABELSOORT: een tabel zonder fysieke tabel ─────────────
//
// Een modeltabel met `source` haalt haar rijen uit een Studio-datatabel. De
// planner kende `source` niet en gaf haar gewoon een CREATE TABLE. Die
// schaduwtabel was niet alleen dood gewicht: hij was de LANDINGSPLAATS die een
// schrijving naar de verkeerde opslag stil maakte. Zonder de tabel geeft zo'n
// schrijving een SQL-fout; mét de tabel slaagt de INSERT en verdwijnt de rij
// zonder spoor.

const LINK = { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' };
const linked = (id, key, fields, source = LINK) => ({ ...t(id, key, fields), source });

test('een NIEUWE gekoppelde tabel krijgt geen CREATE TABLE', () => {
    const plan = migrationPlan(model([]), model([linked('tbl_link', 'orders', [f('fld_a', 'total')])]), { dialect: 'pg' });
    assert.deepStrictEqual(plan, []);
});

test('een gekoppelde tabel krijgt geen ALTER, geen index en geen DROP COLUMN', () => {
    const before = model([linked('tbl_link', 'orders', [f('fld_a', 'total'), f('fld_b', 'weg')])]);
    const after = model([linked('tbl_link', 'bestellingen', [
        f('fld_a', 'bedrag', { unique: true }),   // hernoemd én uniek geworden
        f('fld_c', 'nieuw'),                      // nieuwe kolom
    ])]);                                          // fld_b verdwenen
    assert.deepStrictEqual(migrationPlan(before, after, { dialect: 'pg' }), []);
});

test('een gekoppelde tabel die uit het model verdwijnt geeft geen DROP TABLE', () => {
    const before = model([linked('tbl_link', 'orders', [f('fld_a', 'total')])]);
    assert.deepStrictEqual(migrationPlan(before, model([]), { dialect: 'pg' }), []);
});

test('eigen opslag → gekoppeld laat de fysieke tabel STAAN, met haar rijen', () => {
    // Een DROP zou gegevens vernietigen op een modelwijziging. De tabel blijft
    // tot iemand haar echt verwijdert.
    const before = model([t('tbl_x', 'orders', [f('fld_a', 'total')])]);
    const after = model([linked('tbl_x', 'orders', [f('fld_a', 'total')])]);
    assert.deepStrictEqual(migrationPlan(before, after, { dialect: 'pg' }), []);
});

test('gekoppeld → eigen opslag MAAKT de tabel alsnog, compleet, en altereert hem niet', () => {
    // Hij heeft nog nooit een fysieke tabel gehad, dus dit is een CREATE — en
    // dan geen ADD COLUMN erachteraan voor kolommen die er al in staan.
    const before = model([linked('tbl_x', 'orders', [f('fld_a', 'total')])]);
    const after = model([t('tbl_x', 'orders', [f('fld_a', 'total'), f('fld_b', 'status')])]);
    const plan = migrationPlan(before, after, { dialect: 'pg' });
    assert.strictEqual(plan.length, 1, plan.join(' | '));
    assert.match(plan[0], /CREATE TABLE IF NOT EXISTS "orders"/);
    assert.match(plan[0], /"status"/, 'de nieuwe kolom hoort in de CREATE, niet in een ALTER');
});

test('een gewone tabel naast een gekoppelde migreert nog precies zoals altijd', () => {
    const before = model([t('tbl_own', 'notes', [f('fld_n', 'body')]), linked('tbl_link', 'orders', [f('fld_a', 'total')])]);
    const after = model([t('tbl_own', 'notes', [f('fld_n', 'body'), f('fld_m', 'title')]), linked('tbl_link', 'orders', [f('fld_a', 'total')])]);
    const plan = migrationPlan(before, after, { dialect: 'pg' });
    assert.strictEqual(plan.length, 1, plan.join(' | '));
    assert.match(plan[0], /ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "title"/);
});

test('een KAPOTTE source telt óók als gekoppeld — nooit stil als eigen opslag', () => {
    // Stil als eigen opslag lezen is hoe er een tabel ontstaat die niemand vult
    // en niemand leest; dezelfde regel als appStudio/datatableSource.isDatatableBacked.
    const after = model([linked('tbl_link', 'orders', [f('fld_a', 'total')], { kind: 'datatabel' })]);
    assert.deepStrictEqual(migrationPlan(model([]), after, { dialect: 'pg' }), []);
});
