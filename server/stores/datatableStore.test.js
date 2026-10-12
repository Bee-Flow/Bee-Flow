/**
 * The metadata store's contract, checked against the SQL it emits rather than a
 * live database (there is none in CI). The properties that matter are all
 * visible in the statements:
 *
 *   - every list is narrowed to a tenant;
 *   - the hot counters are an arithmetic UPDATE, never a read-modify-write;
 *   - the datatables row and the org model move together or not at all;
 *   - a stale schema save loses rather than silently overwriting.
 *
 * ── THIS FILE IS NOT COVERAGE ───────────────────────────────────────
 * "checked against the SQL it emits rather than a live database (there is none
 * in CI)" is no longer true: @electric-sql/pglite is a devDependency and
 * `stores/datatableDbStore.integration.test.js` drives this store's genuine
 * createSchema, transactions and counters against a real Postgres. The
 * assertions below still earn their place — they pin rules a passing scenario
 * would not notice were gone — but they cannot see a wrong value, and nothing
 * behavioural should be left to them.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// datatableStore.js is sinds de opsplitsing een FACADE: de implementatie staat
// in stores/datatableStore/*. Het is nog steeds ÉÉN module, dus lees hem als
// één tekst — in de volgorde waarin de facade zijn onderdelen bedraadt, want
// verderop letten beweringen op de VOLGORDE van twee functies. Alleen de
// facade lezen zou elke slice hieronder leeg maken en stil groen laten worden.
const PART_DIR = path.join(__dirname, 'datatableStore');
const FACADE = fs.readFileSync(path.join(__dirname, 'datatableStore.js'), 'utf8');
const WIRED = [...new Set([...FACADE.matchAll(/\.\/datatableStore\/(\w+)/g)].map(m => `${m[1]}.js`))];
const ON_DISK = fs.readdirSync(PART_DIR).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
// Bedrade volgorde eerst, en wat daar (nog) niet in staat erachter: een nieuw
// onderdeel mag nooit stilletjes buiten deze scan vallen.
const PART_FILES = [...WIRED.filter(f => ON_DISK.includes(f)), ...ON_DISK.filter(f => !WIRED.includes(f))];
const RAW = PART_FILES.map(f => fs.readFileSync(path.join(PART_DIR, f), 'utf8')).join('\n') + '\n' + FACADE;
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const norm = (s) => s.replace(/\s+/g, ' ');

test('every table is created IF NOT EXISTS, so the store is its own migration', () => {
    for (const t of ['datatables', 'datatable_models', 'datatable_grants', 'automation_datatable_usage']) {
        assert.match(SRC, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`), `${t} missing`);
    }
});

test('it is registered in STORE_MODULES', () => {
    // Genuinely textual, per this file's own header: no database here, and
    // registration is itself a textual fact (is the name in the list) —
    // migrateDb.integration.test.js/registration.test.js prove the ladder
    // that reads this registry actually runs. An unregistered store's DDL
    // only runs on first feature use — the post-mortems for blueprintStore
    // and coworkStore are written into that file.
    const registry = fs.readFileSync(path.join(__dirname, '..', 'storeModules.js'), 'utf8');
    assert.match(registry, /'datatableStore'/);
});

test('the SCOPE is NOT NULL — tenancy is structural, not conventional', () => {
    // It used to be `organization_id TEXT NOT NULL`, which is what refused an
    // account with no organisation (BFSF-412). The tenancy did not become
    // optional; it moved. organization_id is now "the org this belongs to, NULL
    // for a personal table" and scope_id carries the key.
    assert.match(norm(SRC), /CREATE TABLE IF NOT EXISTS datatables \([^)]*scope_kind\s+TEXT NOT NULL/);
    assert.match(norm(SRC), /CREATE TABLE IF NOT EXISTS datatables \([^)]*scope_id\s+TEXT NOT NULL/);
    const models = norm(SRC).slice(norm(SRC).indexOf('CREATE TABLE IF NOT EXISTS datatable_models'));
    assert.match(models, /scope_id\s+TEXT NOT NULL/);
    assert.match(models.slice(0, models.indexOf('CREATE TABLE IF NOT EXISTS datatable_grants')),
        /PRIMARY KEY \(scope_kind, scope_id\)/,
        'one model document per SCOPE — a NULL organisation cannot address a tenant');
});

test('a table key is unique per SCOPE, case-insensitively', () => {
    assert.match(SRC, /CREATE UNIQUE INDEX IF NOT EXISTS uq_datatables_scope_key ON datatables\(scope_kind, scope_id, lower\(key\)\)/);
    // Two accounts each owning a personal `customers` is normal; the old
    // per-org index would have let them collide on a NULL organisation.
    assert.doesNotMatch(SRC, /uq_datatables_org_key/);
});

test('grants can only be viewer or editor — owner is derived, never granted', () => {
    assert.match(norm(SRC), /grade\s+TEXT NOT NULL CHECK \(grade IN \('viewer','editor'\)\)/);
    assert.doesNotMatch(norm(SRC), /grade IN \([^)]*'owner'/);
});

test('there is no org-wide grantee type — org-wide write is a separate column', () => {
    assert.match(norm(SRC), /grantee_type\s+TEXT NOT NULL CHECK \(grantee_type IN \('user','group'\)\)/);
    assert.doesNotMatch(norm(SRC), /grantee_type IN \([^)]*'org'/,
        'org-wide write must go through write_mode, which is auditable on its own column');
});

test('every read is narrowed to a tenant, and the unscoped call throws', () => {
    assert.match(SRC, /assertScope\(scope, 'listDatatablesForScope'\)/);
    assert.match(SRC, /FROM datatables WHERE scope_kind = \$1 AND scope_id = \$2/);
    assert.match(SRC, /FROM datatables WHERE id = \$1 AND scope_kind = \$2 AND scope_id = \$3/);
});

test('a malformed scope is refused rather than bound as NULL', () => {
    // `scope_id = undefined` binds as NULL, matches nothing, and reads as
    // "this tenant has no tables" — a bug that looks like an empty account.
    const store = require('./datatableStore');
    for (const bad of [null, undefined, {}, { kind: 'org' }, { id: 'x' }, { kind: 'team', id: 'x' }, { kind: 'org', id: '' }]) {
        assert.throws(() => store.assertScope(bad, 'test'), /scope/, JSON.stringify(bad));
    }
    assert.deepStrictEqual(store.orgScope('org-a'), { kind: 'org', id: 'org-a' });
    assert.deepStrictEqual(store.userScope('u1'), { kind: 'user', id: 'u1' });
});

test('the hot counter path is one arithmetic UPDATE with no row lock', () => {
    const fn = SRC.slice(SRC.indexOf('async function bumpAfterWrite'), SRC.indexOf('async function deleteDatatable'));
    assert.match(fn, /row_count = GREATEST\(0, row_count \+ \$4\)/);
    assert.match(fn, /data_version = data_version \+ 1/);
    assert.doesNotMatch(fn, /FOR UPDATE/,
        'App Studio bumps its equivalents with SELECT … FOR UPDATE on every record write; at automation write volume, with one row per org, that serialises the whole organisation');
    assert.doesNotMatch(fn, /SELECT/, 'no read-modify-write on the hot path');
});

test('a schema change DOES take the row lock — it is rare and must be serialised', () => {
    const fn = SRC.slice(SRC.indexOf('async function saveModel'), SRC.indexOf('async function setSharing'));
    assert.match(fn, /FOR UPDATE/);
});

test('createDatatable writes the row, the model entry AND the DDL in one transaction', () => {
    const fn = SRC.slice(SRC.indexOf('async function createDatatable'), SRC.indexOf('async function saveModel'));
    // `inTransaction`, not `withTransaction` directly: the route owns the
    // transaction now so the CREATE TABLE can ride it, and the fallback below
    // is what keeps a caller that owns none working.
    assert.match(fn, /return inTransaction\(client,/);
    assert.match(fn, /INSERT INTO datatables/);
    assert.match(fn, /datatable_models/);
    // The physical half, on the SAME client. The metadata used to commit first,
    // so a failing CREATE TABLE left a table the picker listed and every read
    // 500'd on — and the retry hit uq_datatables_org_key.
    assert.match(fn, /await applyPhysical\(c,/, 'it must run on the transaction\'s own client');
    assert.ok(fn.indexOf('INSERT INTO datatables') < fn.indexOf('await applyPhysical'),
        'the engine\'s access check reads datatable_models, so the metadata has to be written first');
});

test('inTransaction reuses the caller\'s transaction and opens one only when there is none', () => {
    const fn = SRC.slice(SRC.indexOf('function inTransaction'), SRC.indexOf('function rowToGrant'));
    // Opening a second transaction while the caller holds one would put the
    // model write and the DDL in different commits again — the exact split this
    // helper exists to close.
    assert.match(norm(fn), /return client \? fn\(client\) : withTransaction\(fn\)/);
});

test('a schema save takes the model lock BEFORE the plan is diffed', () => {
    const fn = SRC.slice(SRC.indexOf('async function saveModel'), SRC.indexOf('async function setSharing'));
    // `before` read outside the transaction is a plan diffed against a model
    // somebody else has since changed — it then carries out their edit too.
    assert.ok(fn.indexOf('FOR UPDATE') < fn.indexOf('const before ='),
        'the baseline must be read under the row lock, not before the transaction');
    assert.ok(fn.indexOf('const before =') < fn.indexOf('await applyPhysical'));
});

test('saveModel returns the conflict shape App Studio already uses', () => {
    const fn = SRC.slice(SRC.indexOf('async function saveModel'), SRC.indexOf('async function setSharing'));
    assert.match(fn, /ok: false,\s*conflict: true,\s*currentVersion/);
    assert.match(fn, /ok: true, model, modelVersion/);
});

test('a grant upserts rather than duplicating', () => {
    assert.match(SRC, /ON CONFLICT \(datatable_id, grantee_type, grantee_id\)\s*DO UPDATE/);
});

test('usage reconcile is delete-then-insert for ONE automation, and skips a deleted table', () => {
    const fn = SRC.slice(SRC.indexOf('async function reconcileUsage'), SRC.indexOf('async function listUsage'));
    assert.match(fn, /DELETE FROM automation_datatable_usage WHERE automation_id = \$1/);
    // The INSERT selects FROM datatables, so a step naming a since-deleted
    // table simply matches nothing and writes nothing — the FK never gets the
    // chance to reject a row and fail the whole save.
    assert.match(fn, /FROM datatables d\s+WHERE d\.id = \$6/,
        'a step may name a since-deleted table; the FK would reject the row and fail the whole save');
    // And the scope is a GUARD, not a value the caller gets to write: the row's
    // scope columns are read off the datatables row it matched. A webpage owned
    // by an org member reaches both its organisation's tables and its owner's
    // personal ones, so the guard takes a LIST — and a row still has to say
    // which single scope it really lives in.
    assert.match(fn, /SELECT 1 FROM unnest\(\$7::text\[\], \$8::text\[\]\) AS s\(kind, sid\)/);
    assert.match(fn, /SELECT d\.scope_kind, d\.scope_id,/);
    assert.match(fn, /CASE WHEN d\.scope_kind = 'org' THEN d\.scope_id ELSE NULL END/,
        'organization_id follows the table, never the caller');
});

test('reconcileUsage returns rows WRITTEN, not rows offered', () => {
    // The guarded INSERT above writes nothing when the caller's organizationId
    // is wrong — which it was for every automation saved from a session-derived
    // org. Returning entries.length made that no-op indistinguishable from
    // success, and the "used by" panel stayed empty on a green save.
    const fn = SRC.slice(SRC.indexOf('async function reconcileUsage'), SRC.indexOf('async function listUsage'));
    assert.match(fn, /written \+= r\?\.rowCount \|\| 0;/);
    assert.match(fn, /return written;/);
    assert.doesNotMatch(fn, /return rows\.length;/);
});

test('deleting a table removes its model entry too, in the same transaction', () => {
    const fn = SRC.slice(SRC.indexOf('async function deleteDatatable'));
    assert.match(fn, /withTransaction/);
    assert.match(fn, /model\.tables = .*filter/);
    assert.match(fn, /DELETE FROM datatables WHERE id = \$1 AND scope_kind = \$2 AND scope_id = \$3/);
});

test('the physical DROP rides that same transaction, injected rather than imported', () => {
    // The route used to commit the metadata and only THEN run the DDL: a lock
    // timeout there left a Postgres table full of personal data that no
    // metadata described, no access filter guarded and no UI could reach — and
    // it still answered ok. The callback keeps this store engine-free;
    // datatableDbStore.dropDatatable is the one place that supplies it.
    const fn = SRC.slice(SRC.indexOf('async function deleteDatatable'), SRC.indexOf('// ── The dependents index'));
    assert.match(fn, /dropPhysical/);
    assert.match(fn, /await dropPhysical\(client,/, 'it must run on the transaction\'s own client');
    assert.ok(fn.indexOf('DELETE FROM datatables') < fn.indexOf('await dropPhysical'),
        'skip the DDL when no row was deleted — a wrong org must not drop a table');
    // `before` must still contain the table, or the diff is empty and nothing
    // is dropped at all.
    assert.match(fn, /model = \{ \.\.\.before \}/);
    assert.match(fn, /before\.tables/);
    // And the store still knows nothing about the engine.
    assert.doesNotMatch(SRC, /datatableDbStore/);
    assert.doesNotMatch(SRC, /migrationPlan/);
});

test('the dependents index is generalised by a COLUMN — no rename, no PK change', () => {
    // A renamed table would let an old or rolled-back replica recreate an EMPTY
    // one under the old name and pass the delete-in-use guard. The header says
    // why at length; this pins the mechanics. Behaviour is in
    // datatableStore.usageConsumerKind.test.js.
    assert.match(SRC, /ALTER TABLE automation_datatable_usage ADD COLUMN IF NOT EXISTS consumer_kind TEXT NOT NULL DEFAULT 'automation'/);
    assert.doesNotMatch(SRC, /RENAME/i);
    assert.doesNotMatch(SRC, /CREATE TABLE IF NOT EXISTS datatable_usage\b/);
    assert.match(norm(SRC), /PRIMARY KEY \(automation_id, step_id\)/);
    // 'kb' joined the list in K8, when a knowledge base became a thing that
    // reads a table. The point of the guard is that adding one is a COLUMN
    // value and a JOIN — never a rename, never a new PK.
    assert.match(SRC, /const CONSUMER_KINDS = Object\.freeze\(\['automation', 'app', 'webpage', 'kb'\]\)/);
    // Every DELETE is keyed on the kind AS WELL as the id: ids never collide in
    // practice (all UUIDs) but that is a probability, not a guarantee.
    const keyed = SRC.match(/DELETE FROM automation_datatable_usage WHERE automation_id = \$1 AND consumer_kind = \$2/g) || [];
    assert.strictEqual(keyed.length, 2, 'reconcile and purge');
    assert.doesNotMatch(SRC, /DELETE FROM automation_datatable_usage WHERE automation_id = \$1`/,
        'a delete on the id alone reaches other kinds\' rows');
    // The old entry points are thin wrappers, so no automation save path changed.
    assert.match(SRC, /return reconcileUsageFor\('automation', automationId, scope, entries\)/);
    assert.match(SRC, /return purgeUsageFor\('automation', automationId\)/);
});

test('listUsage joins per kind and never on the id alone', () => {
    const fn = SRC.slice(SRC.indexOf('async function listUsage('), SRC.indexOf('async function listUsageCounts'));
    assert.match(fn, /LEFT JOIN automations a ON u\.consumer_kind = 'automation' AND a\.id = u\.automation_id/);
    assert.match(fn, /LEFT JOIN studio_apps s ON u\.consumer_kind = 'app' AND s\.id = u\.automation_id/);
    assert.match(fn, /LEFT JOIN webpages w ON u\.consumer_kind = 'webpage' AND w\.id = u\.automation_id/);
    // `knowledge_bases.id` is a real uuid column, so the join casts rather
    // than comparing a uuid to text and erroring on every row.
    assert.match(fn, /LEFT JOIN knowledge_bases k ON u\.consumer_kind = 'kb' AND k\.id::text = u\.automation_id/);
    // The two first-use stores' tables are probed, not assumed: a fresh
    // install that never opened App Studio must not 500 the delete guard.
    assert.match(fn, /have\.apps \?/);
    assert.match(fn, /have\.pages \?/);
    assert.match(SRC, /to_regclass\('studio_apps'\)/);
    assert.match(SRC, /to_regclass\('webpages'\)/);
    assert.match(SRC, /to_regclass\('knowledge_bases'\)/);
    // The step position comes from the definition that rode the JOIN — one
    // walk per automation, no lookup per row.
    assert.match(fn, /a\.definition_json AS automation_definition/);
    assert.match(fn, /a\.last_run_at AS automation_last_run_at/);
    assert.doesNotMatch(fn, /automationStore/);
});

test('a deleted automation\'s usage rows have a reaper — the FK cannot be one', () => {
    // automation_datatable_usage has ON DELETE CASCADE from `datatables` and
    // nothing from `automations`, so listUsage's LEFT JOIN kept returning rows
    // with a null title: "something you cannot see writes to your table".
    assert.match(SRC, /async function purgeUsageForAutomation/);
    const fn = SRC.slice(SRC.indexOf('async function purgeUsageForAutomation'));
    assert.match(fn, /DELETE FROM automation_datatable_usage WHERE automation_id = \$1/);
    assert.match(SRC, /purgeUsageForAutomation,/, 'it must be exported or it is dead again');
});

test('the row shape carries BOTH camelCase and the snake_case the grade resolver reads', () => {
    const store = require('./datatableStore');
    const row = store._rowToDatatable({
        id: 'tbl_a', scope_kind: 'org', scope_id: 'org-a',
        organization_id: 'org-a', owner_user_id: 'u1', key: 'orders', name: 'Orders',
        is_published: true, shared_groups: '["g1"]', write_mode: 'grants', row_scope: 'all',
        row_count: '7', data_version: '3', retention_days: null, retention_field: 'created_at',
    });
    // camelCase for the API
    assert.strictEqual(row.organizationId, 'org-a');
    assert.deepStrictEqual(row.scope, { kind: 'org', id: 'org-a' });
    assert.strictEqual(row.rowCount, 7);
    assert.deepStrictEqual(row.sharedGroups, ['g1']);
    // snake_case for auth/datatableAccess — passing the wrong shape there fails
    // by comparing undefined to undefined, which is the worst kind of quiet.
    assert.strictEqual(row.scope_kind, 'org');
    assert.strictEqual(row.scope_id, 'org-a');
    assert.strictEqual(row.organization_id, 'org-a');
    assert.strictEqual(row.owner_user_id, 'u1');
    assert.strictEqual(row.is_published, true);
    assert.strictEqual(row.write_mode, 'grants');
    assert.deepStrictEqual(row.shared_groups, ['g1']);
});

test('the row shape works end to end with the grade resolver', () => {
    const store = require('./datatableStore');
    const { gradeForPrincipal } = require('../auth/datatableAccess');
    const row = store._rowToDatatable({
        id: 'tbl_a', scope_kind: 'org', scope_id: 'org-a',
        organization_id: 'org-a', owner_user_id: 'u1', key: 'orders', name: 'Orders',
        is_published: true, shared_groups: '[]', write_mode: 'grants', row_scope: 'all',
        row_count: 0, data_version: 0, retention_field: 'created_at',
    });
    const who = { userId: 'u2', orgId: 'org-a', organizationId: 'org-a', groupIds: [], orgRole: 'member' };
    assert.strictEqual(gradeForPrincipal(row, [], who), 'viewer',
        'published with no groups is org-wide READ; it must not confer write');
    assert.strictEqual(gradeForPrincipal(row, [], { ...who, userId: 'u1' }), 'owner');
});

test('a JSONB column survives being handed back as a string or an object', () => {
    const store = require('./datatableStore');
    const asString = store._rowToDatatable({ shared_groups: '["a"]' });
    const asObject = store._rowToDatatable({ shared_groups: ['a'] });
    const asNull = store._rowToDatatable({ shared_groups: null });
    assert.deepStrictEqual(asString.sharedGroups, ['a']);
    assert.deepStrictEqual(asObject.sharedGroups, ['a']);
    assert.deepStrictEqual(asNull.sharedGroups, []);
});
