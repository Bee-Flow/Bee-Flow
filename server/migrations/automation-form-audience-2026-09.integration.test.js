/**
 * Who may fill a form in — the migration and the store, on real Postgres
 * (@electric-sql/pglite behind the db.js facade).
 *
 * Proven:
 *   - the columns land on automation_form_pages with DEFAULT 'org', so every
 *     row that exists today keeps working for the people it works for now;
 *     twice is once (idempotent);
 *   - a NEW page is 'restricted' with nobody on it — the owner's alone;
 *   - setFormPageAudience is owner-scoped (wrong automation → null) and
 *     de-duplicates the ids it stores;
 *   - formPageAudience carries the audience, and audienceAdmits (the pure
 *     rule the visitor gate and the directory share) reads it right;
 *   - rotating the link keeps the audience — a new token is not un-sharing.
 *
 * Run: cd server && node --test --test-force-exit migrations/automation-form-audience-2026-09.integration.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..');
const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adaptResult(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows ? r.rows.length : 0) };
}
async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params));
    return adaptResult(await pg.query(sql));
}
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p); m.exports = exports; m.loaded = true; require.cache[p] = m;
}
const dbFacade = {
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql),
};
mock(path.join(SERVER, 'db.js'), dbFacade);
// The store's core: the same facade, and no migration ladder (this test IS the migration).
mock(path.join(SERVER, 'stores/automationStore/core.js'), { ...dbFacade, initDB: async () => {} });

const { up } = require('./automation-form-audience-2026-09');
const forms = require('../stores/automationStore/forms');
const { audienceAdmits, needsGroups, publicAudience } = require('../automation/formAudience');

async function columns() {
    const r = await rawQuery(`SELECT column_name, column_default, is_nullable FROM information_schema.columns
                               WHERE table_name = 'automation_form_pages' ORDER BY ordinal_position`);
    return Object.fromEntries(r.rows.map(c => [c.column_name, c]));
}

before(async () => {
    await pg.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await pg.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, organization_id TEXT, title TEXT, description TEXT, is_active BOOLEAN DEFAULT TRUE, is_draft BOOLEAN DEFAULT FALSE, definition_json JSONB)`);
    // the table as automation-form-trigger-2026-08 made it
    await pg.exec(`CREATE TABLE automation_form_pages (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        trigger_step_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ,
        submissions BIGINT NOT NULL DEFAULT 0)`);
    await pg.query(`INSERT INTO users (id, "organizationId") VALUES ('owner', 'org1'), ('pat', 'org1'), ('sam', 'org1'), ('out', 'org2')`);
    await pg.query(`INSERT INTO automations (id, user_id, organization_id, title) VALUES ('au-old', 'owner', 'org1', 'Old'), ('au-new', 'owner', 'org1', 'New'), ('au-other', 'pat', 'org1', 'Theirs')`);
    await pg.query(`INSERT INTO automation_form_pages (id, automation_id) VALUES ('${'a'.repeat(48)}', 'au-old')`);
});
after(async () => { await pg.close(); });

test('the columns land with DEFAULT org for the rows that exist; twice is once', async () => {
    await up();
    await up();
    const cols = await columns();
    assert.match(cols.audience.column_default, /'org'/);
    assert.strictEqual(cols.audience.is_nullable, 'NO');
    assert.ok(cols.shared_groups && cols.shared_user_ids);
    const old = await forms.getFormPage('a'.repeat(48));
    assert.strictEqual(old.audience, 'org');
    assert.deepStrictEqual(old.sharedGroups, []);
    assert.deepStrictEqual(old.sharedUserIds, []);
});

test('a NEW page is restricted with nobody on it — the owner\'s alone', async () => {
    const page = await forms.ensureFormPage('au-new', null);
    assert.strictEqual(page.audience, 'restricted');
    assert.deepStrictEqual(page.sharedUserIds, []);
    const aud = await forms.formPageAudience(page.id);
    assert.deepStrictEqual(aud, { userId: 'owner', organizationId: 'org1', audience: 'restricted', sharedGroups: [], sharedUserIds: [] });
    assert.strictEqual(audienceAdmits(aud, { id: 'owner', organizationId: 'org1' }), true);
    assert.strictEqual(audienceAdmits(aud, { id: 'pat', organizationId: 'org1' }), false);
    assert.strictEqual(needsGroups(aud, { id: 'pat', organizationId: 'org1' }), false, 'no groups listed → no group read');
});

test('setFormPageAudience is owner-scoped, de-duplicates, and the rule reads it back', async () => {
    const page = await forms.ensureFormPage('au-new', null);
    assert.strictEqual(await forms.setFormPageAudience(page.id, 'au-other', { audience: 'org' }), null, 'another routine cannot re-share this page');
    const updated = await forms.setFormPageAudience(page.id, 'au-new', { audience: 'restricted', sharedGroups: ['g-fin', 'g-fin'], sharedUserIds: ['pat', 'pat', 7] });
    assert.deepStrictEqual(updated.sharedGroups, ['g-fin']);
    assert.deepStrictEqual(updated.sharedUserIds, ['pat']);
    const aud = await forms.formPageAudience(page.id);
    const caller = (id, organizationId = 'org1') => ({ id, organizationId });
    assert.strictEqual(audienceAdmits(aud, caller('pat')), true, 'listed by id');
    assert.strictEqual(audienceAdmits(aud, caller('sam')), false, 'not listed, no groups known');
    assert.strictEqual(needsGroups(aud, caller('sam')), true);
    assert.strictEqual(audienceAdmits(aud, caller('sam'), ['g-fin']), true, 'member of a listed group');
    assert.strictEqual(audienceAdmits(aud, caller('out', 'org2'), ['g-fin']), false, 'outside the organisation the list does not matter');
    // the owner's view carries the lists; everyone else's only the mode
    assert.deepStrictEqual(publicAudience(updated, { owner: true }), { mode: 'restricted', groups: ['g-fin'], users: ['pat'] });
    assert.deepStrictEqual(publicAudience(updated), { mode: 'restricted' });
    // back to the whole organisation
    const wide = await forms.setFormPageAudience(page.id, 'au-new', { audience: 'org', sharedGroups: [], sharedUserIds: [] });
    assert.strictEqual(audienceAdmits(await forms.formPageAudience(wide.id), caller('sam')), true);
});

test('rotating the link keeps the audience', async () => {
    const page = await forms.ensureFormPage('au-new', null);
    await forms.setFormPageAudience(page.id, 'au-new', { audience: 'restricted', sharedGroups: ['g-fin'], sharedUserIds: ['pat'] });
    const fresh = await forms.rotateFormPage(page.id, 'au-new');
    assert.notStrictEqual(fresh.id, page.id);
    assert.strictEqual(await forms.getFormPage(page.id), null);
    const aud = await forms.formPageAudience(fresh.id);
    assert.strictEqual(aud.audience, 'restricted');
    assert.deepStrictEqual(aud.sharedGroups, ['g-fin']);
    assert.deepStrictEqual(aud.sharedUserIds, ['pat']);
});

test('the migration is on the ladder', () => {
    const src = require('node:fs').readFileSync(path.join(SERVER, 'stores/automationStore/core.js'), 'utf8');
    assert.match(src, /'automation-form-audience-2026-09'/);
});
