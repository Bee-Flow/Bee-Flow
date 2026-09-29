/**
 * The org backfill must FREEZE today's behaviour, not change it.
 *
 * `runOrgFor` (core/automationRunner/execution.js) already answers "which
 * organisation does this run belong to" by falling back to the owner's
 * `users."organizationId"` whenever `automations.organization_id` is NULL —
 * which is every routine, because neither create route ever passed one.
 *
 * So the backfill is only safe if it writes exactly what that fallback already
 * derives. These tests pin the SQL that guarantees it, and the two properties
 * that make it re-runnable on a live install.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'automation-org-backfill-2026-09.js'), 'utf8');

test('the UPDATE joins users and copies the owner\'s organisation — the same value runOrgFor derives', () => {
    // Normalise whitespace so the assertion is about the SQL, not its layout.
    const sql = SRC.replace(/\s+/g, ' ');
    assert.match(sql, /UPDATE automations a/);
    assert.match(sql, /SET organization_id = u\."organizationId"/);
    assert.match(sql, /FROM users u/);
    assert.match(sql, /WHERE a\.user_id = u\.id/,
        'the org must come from the routine\'s OWNER, which is what runOrgFor uses');
});

test('it only touches rows that are still NULL, so re-running is a no-op', () => {
    const sql = SRC.replace(/\s+/g, ' ');
    assert.match(sql, /AND a\.organization_id IS NULL/,
        'without this the migration would overwrite an explicitly-set org on every boot');
});

test('a routine whose owner has no organisation is left NULL, never invented', () => {
    const sql = SRC.replace(/\s+/g, ' ');
    // TRUTHINESS, not IS NOT NULL. createUser writes `organizationId || ''`, so
    // an org-less account holds the empty string; a null check copied that ''
    // into automations as a tenant key and made the partial index cover every
    // row it exists to skip.
    assert.match(sql, /AND COALESCE\(u\."organizationId", ''\) <> ''/,
        'personal installs must stay NULL; the datatable step refuses rather than guessing');
    assert.doesNotMatch(sql, /AND u\."organizationId" IS NOT NULL/);
});

test("it normalises an already-written '' to NULL, before the backfill", () => {
    const sql = SRC.replace(/\s+/g, ' ');
    assert.match(sql, /UPDATE automations SET organization_id = NULL WHERE organization_id = ''/);
    assert.ok(sql.indexOf("organization_id = NULL WHERE organization_id = ''") < sql.indexOf('UPDATE automations a'),
        "a row stamped '' must be cleared first, so the same pass can give it the owner's real org");
});

test('the index is created IF NOT EXISTS and is partial', () => {
    assert.match(SRC, /CREATE INDEX IF NOT EXISTS idx_automations_org/);
    assert.match(SRC, /WHERE organization_id IS NOT NULL/);
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

test('both create routes now stamp the organisation', () => {
    const crud = fs.readFileSync(path.join(__dirname, '..', 'routes', 'automation', 'crud.js'), 'utf8');
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
    const crud = fs.readFileSync(path.join(__dirname, '..', 'routes', 'automation', 'crud.js'), 'utf8');
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
    const crud = fs.readFileSync(path.join(__dirname, '..', 'routes', 'automation', 'crud.js'), 'utf8');
    assert.match(crud, /const orgOf = async \(req\) =>[\s\S]{0,80}resolveDatatablePrincipal\(req\)/);
    assert.doesNotMatch(crud, /const orgOf = \(req\) => req\.session/);
    const bare = crud.match(/(?<!await )orgOf\(req\)/g) || [];
    assert.deepStrictEqual(bare, [], 'every orgOf call site must be awaited');
});
