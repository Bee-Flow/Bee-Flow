/**
 * The row store must be Postgres, always, and must never reach for the sqlite
 * blob engine — the three reasons are in the module header. A future edit that
 * "helpfully" adds a sqlite fallback for parity with studioAppDbStore would
 * reintroduce silent metadata loss and cross-replica handle poisoning, so the
 * absence is asserted rather than assumed.
 *
 * ── THIS FILE IS NOT COVERAGE ───────────────────────────────────────
 * Most of it reads its subject with fs.readFileSync and matches regexes against
 * it. That pins architectural invariants no behavioural test catches — and it
 * cannot see a wrong value, a missing row, a counter that drifted or an upsert
 * that appends. `stores/datatableDbStore.integration.test.js` carries the
 * behavioural half, against a real Postgres. Add rules here; add EFFECTS there.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(path.join(__dirname, 'datatableDbStore.js'), 'utf8');

// Match on CODE, not prose. The module header explains at length why the sqlite
// blob engine and STUDIO_APP_ENGINE are not used here, and a naive whole-file
// regex would read those explanations as the thing they warn against.
const SRC = RAW
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');    // line comments (leaving URLs alone)

test('it builds the Postgres engine and never the sqlite blob engine', () => {
    assert.match(SRC, /createPgAppEngine/);
    assert.doesNotMatch(SRC, /createSqliteBlobEngine/,
        'the sqlite blob engine poisons its handle across replicas and silently skips metadata for an org-owned entity');
    assert.doesNotMatch(SRC, /sqliteBlobEngine/);
});

test('it never reads STUDIO_APP_ENGINE', () => {
    assert.doesNotMatch(SRC, /STUDIO_APP_ENGINE/,
        'that flag selects App Studio\'s engine; datatables are unconditionally pg');
    assert.doesNotMatch(SRC, /\bisPg\s*\(/);
});

test('the schema name is a fixed-length hash, so it can never depend on the tenant', () => {
    const { schemaNameFor } = require('./datatableDbStore');
    for (const id of ['', 'a', 'org-with-dash', 'x'.repeat(500), 'someone@example.com']) {
        const name = schemaNameFor('org', id);
        assert.match(name, /^dt_[0-9a-f]{40}$/, name);
        // Postgres truncates every identifier to 63 BYTES, quoted or not.
        assert.ok(Buffer.byteLength(name, 'utf8') <= 63, `${name} is ${name.length} chars`);
    }
});

test('two org ids sharing 57 leading characters get DIFFERENT schemas', () => {
    // This is the live tenancy break the hash exists for: 'dtorg_' + a 60-char
    // slug truncates at 63 bytes, so these two used to address ONE schema and
    // read, overwrite and delete each other's rows. Org ids are slugs of the
    // organisation NAME (accountProvisioning.slugifyOrgId), not UUIDs.
    const { schemaNameFor } = require('./datatableDbStore');
    // 'dtorg_' is 6 bytes, so 57 characters of org id is exactly what survives.
    const shared = 'stichting-vrienden-van-het-nederlands-openluchtmuseum-loc';
    assert.strictEqual(shared.length, 57);
    const a = shared + 'atie-noord';
    const b = shared + 'atie-zuid';
    assert.strictEqual(('dtorg_' + a).slice(0, 63), ('dtorg_' + b).slice(0, 63),
        'the OLD name must actually have collided, or this test proves nothing');
    assert.notStrictEqual(schemaNameFor('org', a), schemaNameFor('org', b));
});

test('the scope kind is part of the digest, so an org and a user cannot share a schema', () => {
    const { schemaNameFor } = require('./datatableDbStore');
    assert.notStrictEqual(schemaNameFor('org', 'acme'), schemaNameFor('user', 'acme'));
});

test('a scope key round-trips, and anything else does not parse', () => {
    const store = require('./datatableDbStore');
    assert.strictEqual(store.scopeKey({ kind: 'org', id: 'acme' }), 'org:acme');
    assert.strictEqual(store.orgScopeKey('acme'), 'org:acme');
    assert.strictEqual(store.scopeKey({ kind: 'user', id: 'u1' }), 'user:u1');
    // An id may itself contain a colon (an OAuth `sub`, an e-mail-shaped id),
    // so only the FIRST one separates.
    assert.deepStrictEqual(store.parseScopeKey('user:sub:123'), { kind: 'user', id: 'sub:123' });
    for (const bad of ['acme', '', 'org:', ':acme', 'team:a', null, 42]) {
        assert.strictEqual(store.parseScopeKey(bad), null, JSON.stringify(bad));
    }
    for (const bad of [null, {}, { kind: 'team', id: 'x' }, { kind: 'org' }]) {
        assert.throws(() => store.scopeKey(bad), /scope/, JSON.stringify(bad));
    }
});

test('schemaFor answers the LEGACY name while only the legacy schema exists', async () => {
    // Load-bearing, not cleanup. applyMigration runs CREATE SCHEMA IF NOT
    // EXISTS, so without this fallback a tenant the rename migration could not
    // move would not 404 — the next schema save would silently create an EMPTY
    // hashed schema while its real rows sat orphaned under `dtorg_<id>` with no
    // metadata, no access filter, no retention and no UI.
    const store = require('./datatableDbStore');
    store._accessMemo.clear();
    const legacyOnly = { query: async () => ({ rows: [{ has_hashed: false, has_legacy: true }] }) };
    await store._assertScopeUsable(legacyOnly, 'org:org-old', 'org:org-old');
    assert.strictEqual(store._schemaFor('org:org-old'), 'dtorg_org-old');

    // Once the rename has landed the hashed name wins, even with the legacy
    // schema still present (the half-failed-rename state).
    store._accessMemo.clear();
    const both = { query: async () => ({ rows: [{ has_hashed: true, has_legacy: true }] }) };
    await store._assertScopeUsable(both, 'org:org-old', 'org:org-old');
    assert.strictEqual(store._schemaFor('org:org-old'), store.schemaNameFor('org', 'org-old'));

    // A brand-new tenant has neither, and gets the hashed name.
    store._accessMemo.clear();
    const neither = { query: async () => ({ rows: [{ has_hashed: false, has_legacy: false }] }) };
    await store._assertScopeUsable(neither, 'org:org-new', 'org:org-new');
    assert.strictEqual(store._schemaFor('org:org-new'), store.schemaNameFor('org', 'org-new'));
    store._accessMemo.clear();
});

test('a PERSONAL scope is never offered the legacy name', async () => {
    // `dtorg_<id>` only ever existed for organisations. Probing a user scope for
    // one and finding a same-named schema would point an account's rows at some
    // organisation's storage.
    const store = require('./datatableDbStore');
    store._accessMemo.clear();
    let seen = null;
    const client = {
        query: async (_sql, params) => { seen = params; return { rows: [{ has_hashed: false, has_legacy: false }] }; },
    };
    await store._assertScopeUsable(client, 'user:u1', 'user:u1');
    assert.deepStrictEqual(seen.slice(0, 2), ['user', 'u1']);
    assert.strictEqual(seen[3], null, 'no legacy name may even be probed for a personal scope');
    assert.strictEqual(store._schemaFor('user:u1'), store.schemaNameFor('user', 'u1'));
    store._accessMemo.clear();
});

test('a LEGACY resolution is never memoised', async () => {
    // The rename can land on another replica at any moment. A cached
    // `dtorg_<id>` would then make applyMigration's CREATE SCHEMA IF NOT EXISTS
    // mint an empty schema beside the renamed one — the orphan this whole
    // change removes.
    const store = require('./datatableDbStore');
    store._accessMemo.clear();
    let queries = 0;
    const legacyOnly = { query: async () => { queries++; return { rows: [{ has_hashed: false, has_legacy: true }] }; } };
    await store._assertScopeUsable(legacyOnly, 'org:org-old', 'org:org-old');
    await store._assertScopeUsable(legacyOnly, 'org:org-old', 'org:org-old');
    assert.strictEqual(queries, 2, 'a legacy tenant must be re-probed every call');
    store._accessMemo.clear();
});

test('it exposes the same frozen facade as studioAppDbStore', () => {
    const store = require('./datatableDbStore');
    for (const fn of ['query', 'exec', 'batch', 'applyMigration', 'getSchemaStamp',
        'schema', 'sizeBytes', 'reset', 'flush', 'invalidate', 'closeAll']) {
        assert.strictEqual(typeof store[fn], 'function', `${fn} must be on the facade`);
    }
    // Raw handles stay unexported on both stores, by design.
    assert.strictEqual(store.getWriteHandle, undefined);
    assert.strictEqual(store.getReadHandle, undefined);
});

test('assertScopeUsable refuses a bare id — only a scope key addresses rows', async () => {
    // It used to refuse `ownerId !== entityId`, which stopped a user id being
    // used as an org id. The scope key subsumes that (the kind is part of the
    // digest) and closes the wider hole: a bare id hashes to a DIFFERENT schema
    // that nobody's rows are in, and applyMigration's CREATE SCHEMA IF NOT
    // EXISTS would then mint it empty beside the real one.
    const store = require('./datatableDbStore');
    store._accessMemo.clear();
    const client = { query: async () => ({ rows: [{ has_hashed: true, has_legacy: false }] }) };
    for (const bad of ['org-a', 'a-user-id', '', 'team:a']) {
        await assert.rejects(
            () => store._assertScopeUsable(client, bad, bad),
            (e) => e.status === 400,
            JSON.stringify(bad) + ' is not a scope key',
        );
    }
    // And an owner that differs from the entity is NOT refused — the shared
    // engine supports owner != entity, and a personal scope is exactly that.
    await store._assertScopeUsable(client, 'u1', 'user:u1');
    store._accessMemo.clear();
});

test('assertScopeUsable 404s a scope with no model row', async () => {
    const store = require('./datatableDbStore');
    store._accessMemo.clear();
    const client = { query: async () => ({ rows: [] }) };
    await assert.rejects(
        () => store._assertScopeUsable(client, 'org:org-empty', 'org:org-empty'),
        (e) => e.status === 404,
    );
    await assert.rejects(
        () => store._assertScopeUsable(client, 'user:u-empty', 'user:u-empty'),
        (e) => e.status === 404,
    );
});

test('assertScopeUsable memoises, so the engine does not pay a round trip per call', async () => {
    const store = require('./datatableDbStore');
    store._accessMemo.clear();
    let queries = 0;
    const client = { query: async () => { queries++; return { rows: [{ has_hashed: true, has_legacy: false }] }; } };
    await store._assertScopeUsable(client, 'org:org-a', 'org:org-a');
    await store._assertScopeUsable(client, 'org:org-a', 'org:org-a');
    await store._assertScopeUsable(client, 'org:org-a', 'org:org-a');
    assert.strictEqual(queries, 1, 'the engine calls this inside every transaction');
    store.invalidate('org:org-a');
    await store._assertScopeUsable(client, 'org:org-a', 'org:org-a');
    assert.strictEqual(queries, 2, 'invalidate must clear the memo');
    // The memo is per SCOPE, not per id: an org and a user that share an id
    // must never share a resolved schema name.
    await store._assertScopeUsable(client, 'user:org-a', 'user:org-a');
    assert.strictEqual(queries, 3);
    assert.notStrictEqual(store._schemaFor('org:org-a'), store._schemaFor('user:org-a'));
    store._accessMemo.clear();
});

test('dropDatatable runs the DDL on the metadata store\'s OWN transaction', () => {
    const store = require('./datatableDbStore');
    assert.strictEqual(typeof store.dropDatatable, 'function');
    const fn = SRC.slice(SRC.indexOf('async function dropDatatable'));
    // The metadata store takes the DDL as a callback so it keeps no engine
    // dependency; this is the one place that supplies it. `client` is what makes
    // the two halves atomic — without it the route committed the metadata and
    // only then dropped the table.
    assert.match(fn, /dropPhysical:/);
    assert.match(fn, /\{ client, targetVersion: modelVersion \}/);
    assert.match(fn, /dialect: 'pg'/,
        'the App Studio engine flag is a process global; these rows are always Postgres');
});

test('no route-facing SQL entry point is exported', () => {
    // The engine facade takes SQL, but only queryCompiler produces it. Nothing
    // here should look like a general-purpose "run this string" helper.
    assert.doesNotMatch(SRC, /module\.exports[\s\S]*\brawQuery\b/);
    assert.doesNotMatch(SRC, /module\.exports[\s\S]*\bexecuteSql\b/);
});
