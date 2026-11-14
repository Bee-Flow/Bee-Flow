/**
 * The org backfill must FREEZE today's behaviour, not change it.
 *
 * `runOrgFor` (core/automationRunner/execution.js) already answers "which
 * organisation does this run belong to" by falling back to the owner's
 * `users."organizationId"` whenever `automations.organization_id` is NULL —
 * which is every routine, because neither create route ever passed one.
 *
 * So the backfill is only safe if it writes exactly what that fallback already
 * derives. The migration runs on a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js) over the columns it reads; the route checks below
 * read the create routes' source.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRows } = require('../testUtils/pgliteSeed');

const SRC = fs.readFileSync(path.join(__dirname, 'automation-org-backfill-2026-09.js'), 'utf8');

const { pg, close } = usePglitePool();
const { up } = require('./automation-org-backfill-2026-09');
test.after(close);
test.beforeEach(async () => {
    await pg.exec(`DROP TABLE IF EXISTS automations; DROP TABLE IF EXISTS users;
        CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT);
        CREATE TABLE automations (id TEXT PRIMARY KEY, user_id TEXT, organization_id TEXT);`);
    await insertRows(pg, 'users', [
        { id: 'alice', organizationId: 'org-a' },
        { id: 'bob', organizationId: 'org-b' },
        { id: 'solo-null', organizationId: null },
        { id: 'solo-empty', organizationId: '' },
    ]);
});

const orgs = async () => Object.fromEntries((await pg.query('SELECT id, organization_id FROM automations ORDER BY id')).rows.map(r => [r.id, r.organization_id]));

test('the UPDATE copies the OWNER\'s organisation — the same value runOrgFor derives', async () => {
    await insertRows(pg, 'automations', [
        { id: 'r-alice', user_id: 'alice', organization_id: null },
        { id: 'r-bob', user_id: 'bob', organization_id: null },
        { id: 'r-orphan', user_id: 'gone', organization_id: null },
    ]);
    await up();
    assert.deepStrictEqual(await orgs(), { 'r-alice': 'org-a', 'r-bob': 'org-b', 'r-orphan': null });
});

test('it only touches rows that are still NULL, so re-running is a no-op', async () => {
    await insertRows(pg, 'automations', [{ id: 'r-set', user_id: 'alice', organization_id: 'org-explicit' }]);
    await up();
    await up();
    assert.deepStrictEqual(await orgs(), { 'r-set': 'org-explicit' },
        'without the NULL guard the migration would overwrite an explicitly-set org on every boot');
});

test('a routine whose owner has no organisation is left NULL, never invented', async () => {
    // createUser writes `organizationId || ''`, so an org-less account holds the
    // empty string; a plain null check would copy that '' into automations as a
    // tenant key and make the partial index cover every row it exists to skip.
    await insertRows(pg, 'automations', [
        { id: 'r-null-owner', user_id: 'solo-null', organization_id: null },
        { id: 'r-empty-owner', user_id: 'solo-empty', organization_id: null },
    ]);
    await up();
    assert.deepStrictEqual(await orgs(), { 'r-empty-owner': null, 'r-null-owner': null },
        'personal installs must stay NULL; the datatable step refuses rather than guessing');
});

test("it normalises an already-written '' to NULL, before the backfill", async () => {
    await insertRows(pg, 'automations', [
        { id: 'r-blank', user_id: 'alice', organization_id: '' },
        { id: 'r-blank-solo', user_id: 'solo-empty', organization_id: '' },
    ]);
    await up();
    assert.deepStrictEqual(await orgs(), { 'r-blank': 'org-a', 'r-blank-solo': null },
        "a row stamped '' is cleared first, so the same pass gives it the owner's real org");
});

test('the index is created idempotently and is partial', async () => {
    await up();
    await up();
    const { rows } = await pg.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_automations_org'");
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].indexdef.includes('(organization_id) WHERE (organization_id IS NOT NULL)'), rows[0].indexdef);
});

test('it exports up() and follows the repo migration shape', () => {
    const mod = require('./automation-org-backfill-2026-09');
    assert.strictEqual(typeof mod.up, 'function');
    assert.match(SRC, /require\('\.\.\/db'\)/);
    assert.match(SRC, /require\.main === module/, 'every migration here is runnable standalone');
});

test('it is registered in the automationStore migration list', () => {
    // automation-project-id-2026-07 existed for months and was never listed
    // here, so its column was never created and the feature it belonged to
    // silently did nothing. That post-mortem is written into core.js; this
    // assertion is how this migration avoids repeating it.
    const core = fs.readFileSync(path.join(__dirname, '..', 'stores', 'automationStore', 'core.js'), 'utf8');
    assert.match(core, /'automation-org-backfill-2026-09'/,
        'an unregistered migration never runs');
});

// The automation CRUD routes: crud.js and the route groups split out of it,
// shared helpers (orgOf) first, so they read as the one file they used to be.
function readCrudRoutes() {
    return ['crudContext.js', 'crud.js', 'folders.js', 'forms.js', 'importExport.js']
        .map(f => fs.readFileSync(path.join(__dirname, '..', 'routes', 'automation', f), 'utf8'))
        .join('\n');
}

test('both create routes now stamp the organisation', () => {
    const crud = readCrudRoutes();
    const parts = crud.split('automationStore.createAutomation({');
    const calls = parts.slice(1);
    assert.strictEqual(calls.length, 2, 'expected exactly two create call sites');
    for (const [i, call] of calls.entries()) {
        const body = call.slice(0, call.indexOf('});'));
        assert.match(body, /\borganizationId\b/,
            `create call site ${i + 1} does not stamp organization_id — the backfill would be undone by the next new routine`);
        if (/organizationId:\s*await orgOf\(req\)/.test(body)) continue;
        // Both sites now HOIST the resolved org, because the datatable usage
        // index has to be written against the same one the row was stamped
        // with. Shorthand is fine; a shorthand over some OTHER organizationId
        // is not, so check what the handler bound it to.
        const handler = parts[i].slice(parts[i].lastIndexOf('router.'));
        assert.match(handler, /const organizationId = await orgOf\(req\)/,
            `create call site ${i + 1} uses shorthand for an organizationId that did not come from orgOf(req)`);
    }
});

test('orgOf is defined before the first handler that uses it', () => {
    const crud = readCrudRoutes();
    const def = crud.indexOf('const orgOf =');
    const firstUse = crud.indexOf('await orgOf(req)');
    assert.ok(def > -1 && def < firstUse,
        'orgOf must be declared above its first use — reading it below the handlers invites a TDZ-looking trap');
});

test('orgOf reads the organisation from the DB, never from the session', () => {
    // req.session.user.organizationId is written by only two of the login
    // shapes auth/sessionShapes.contract.test.js freezes, so the old
    // session-derived orgOf stamped NULL for every returning member — and every
    // orgOf call site here is awaited, or it would stamp a Promise.
    const crud = readCrudRoutes();
    assert.match(crud, /const orgOf = async \(req\) =>[\s\S]{0,80}resolveDatatablePrincipal\(req\)/);
    assert.doesNotMatch(crud, /const orgOf = \(req\) => req\.session/);
    const bare = crud.match(/(?<!await )orgOf\(req\)/g) || [];
    assert.deepStrictEqual(bare, [], 'every orgOf call site must be awaited');
});
