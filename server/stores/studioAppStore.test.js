/**
 * Studio App store behaviour tests — CRUD, visibility matrix, definition CAS,
 * publish snapshots + pruning, and builder-session optimistic locking.
 *
 * Postgres is replaced by a small in-memory stand-in that implements exactly
 * the SQL shapes studioAppStore issues (documented per branch below), so the
 * suite is hermetic and exercises the store's real logic — WHERE scoping,
 * version arithmetic, JSONB round-trips — without a database.
 *
 * Run: node --test stores/studioAppStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── In-memory Postgres stand-in ───────────────────────────────────
// Rows are plain objects; JSONB params stay as the strings the store passed
// (the store's parseJSON handles both shapes, like pg does).

let clock = Date.parse('2026-01-01T00:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();

const tables = { studio_apps: [], studio_app_versions: [], studio_app_attachments: [] };

const ROW_DEFAULTS = {
    studio_apps: () => {
        const t = tick();
        return {
            organization_id: null, name: 'Untitled app', description: '', icon: null,
            accent_color: null, definition: '{}', definition_version: 1,
            published_definition: null, published_version: null, builder_session: null, is_published: false,
            shared_groups: '[]', published_at: null, created_at: t, updated_at: t,
        };
    },
    studio_app_versions: () => ({ summary: null, created_at: tick() }),
};

// Split on a separator at paren-depth 0 (so `NOW()` and OR-groups survive).
function splitTop(s, sep) {
    const parts = [];
    let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (depth === 0 && s.slice(i, i + sep.length).toUpperCase() === sep.toUpperCase()) {
            parts.push(cur); cur = ''; i += sep.length - 1; continue;
        }
        cur += ch;
    }
    parts.push(cur);
    return parts;
}

function isBalanced(s) {
    let depth = 0;
    for (const ch of s) {
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth < 0) return false; }
    }
    return depth === 0;
}

function evalExpr(row, expr, params) {
    expr = expr.trim();
    while (expr.startsWith('(') && expr.endsWith(')') && isBalanced(expr.slice(1, -1))) {
        expr = expr.slice(1, -1).trim();
    }
    const ors = splitTop(expr, ' OR ');
    if (ors.length > 1) return ors.some(e => evalExpr(row, e, params));
    const ands = splitTop(expr, ' AND ');
    if (ands.length > 1) return ands.every(e => evalExpr(row, e, params));
    let m;
    if ((m = expr.match(/^([a-z_]+)\s*=\s*ANY\(\$(\d+)(?:::[a-z\[\]]+)?\)$/i))) {
        return (params[Number(m[2]) - 1] || []).includes(row[m[1]]);
    }
    if ((m = expr.match(/^([a-z_]+)\s*=\s*\$(\d+)(?:::[a-z\[\]]+)?$/i))) {
        return row[m[1]] === params[Number(m[2]) - 1];
    }
    if ((m = expr.match(/^([a-z_]+)\s*=\s*TRUE$/i))) return row[m[1]] === true;
    if ((m = expr.match(/^([a-z_]+)\s+IS\s+NOT\s+NULL$/i))) return row[m[1]] != null;
    throw new Error(`fake db: unsupported condition "${expr}"`);
}

function doSelect(s, params) {
    const m = s.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)\s*([\s\S]*)$/i);
    if (!m) throw new Error(`fake db: unparseable SELECT: ${s}`);
    const [, colsRaw, tableName, rest] = m;
    const whereM = rest.match(/\bWHERE\b([\s\S]*?)(?:\bORDER BY\b|\bLIMIT\b|\bOFFSET\b|\bFOR UPDATE\b|$)/i);
    let rows = whereM
        ? tables[tableName].filter(r => evalExpr(r, whereM[1], params))
        : [...tables[tableName]];
    const orderM = rest.match(/\bORDER BY\b\s+([\s\S]*?)(?:\bLIMIT\b|\bOFFSET\b|\bFOR UPDATE\b|$)/i);
    if (orderM) {
        const keys = orderM[1].split(',').map(k => {
            const [col, dir] = k.trim().split(/\s+/);
            return { col, desc: /desc/i.test(dir || '') };
        });
        rows = [...rows].sort((a, b) => {
            for (const { col, desc } of keys) {
                const av = a[col] ?? '', bv = b[col] ?? '';
                if (av < bv) return desc ? 1 : -1;
                if (av > bv) return desc ? -1 : 1;
            }
            return 0;
        });
    }
    const offM = rest.match(/\bOFFSET\b\s+\$(\d+)/i);
    if (offM) rows = rows.slice(Number(params[Number(offM[1]) - 1]));
    const limM = rest.match(/\bLIMIT\b\s+(\d+)/i);
    if (limM) rows = rows.slice(0, Number(limM[1]));
    const cols = colsRaw.trim();
    let out;
    if (cols === '*') out = rows.map(r => ({ ...r }));
    else if (cols === '1') out = rows.map(() => ({ '?column?': 1 }));
    else {
        const names = cols.split(',').map(c => c.trim());
        out = rows.map(r => Object.fromEntries(names.map(n => [n, r[n]])));
    }
    return { rows: out, rowCount: out.length };
}

function doInsert(s, params) {
    const m = s.match(/^INSERT INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*(RETURNING \*)?/i);
    if (!m) throw new Error(`fake db: unparseable INSERT: ${s}`);
    const cols = m[2].split(',').map(c => c.trim());
    const vals = m[3].split(',').map(v => v.trim());
    const row = ROW_DEFAULTS[m[1]]();
    cols.forEach((c, i) => {
        const vm = vals[i].match(/^\$(\d+)/);
        if (!vm) throw new Error(`fake db: non-placeholder INSERT value "${vals[i]}"`);
        row[c] = params[Number(vm[1]) - 1];
    });
    tables[m[1]].push(row);
    return { rows: m[4] ? [{ ...row }] : [], rowCount: 1 };
}

function doUpdate(s, params) {
    const m = s.match(/^UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+?)(\s+RETURNING \*)?\s*$/i);
    if (!m) throw new Error(`fake db: unparseable UPDATE: ${s}`);
    const matched = tables[m[1]].filter(r => evalExpr(r, m[3], params));
    for (const row of matched) {
        for (const item of splitTop(m[2], ',').map(x => x.trim())) {
            let sm;
            if ((sm = item.match(/^([a-z_]+)\s*=\s*\$(\d+)(?:::[a-z\[\]]+)?$/i))) row[sm[1]] = params[Number(sm[2]) - 1];
            else if ((sm = item.match(/^([a-z_]+)\s*=\s*NOW\(\)$/i))) row[sm[1]] = tick();
            else if ((sm = item.match(/^([a-z_]+)\s*=\s*NULL$/i))) row[sm[1]] = null;
            else if (/^definition_version\s*=\s*definition_version\s*\+\s*1$/i.test(item)) row.definition_version += 1;
            else if (/^published_definition\s*=\s*definition$/i.test(item)) row.published_definition = row.definition;
            else throw new Error(`fake db: unsupported SET "${item}"`);
        }
    }
    return { rows: m[4] ? matched.map(r => ({ ...r })) : [], rowCount: matched.length };
}

function doDelete(s, params) {
    const m = s.match(/^DELETE FROM\s+(\w+)\s+WHERE\s+([\s\S]+)$/i);
    if (!m) throw new Error(`fake db: unparseable DELETE: ${s}`);
    const before = tables[m[1]].length;
    tables[m[1]] = tables[m[1]].filter(r => !evalExpr(r, m[2], params));
    return { rows: [], rowCount: before - tables[m[1]].length };
}

function query(sql, params = []) {
    const s = String(sql).trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^(CREATE|ALTER|DO)\b/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^INSERT\b/i.test(s)) return doInsert(s, params);
    if (/^UPDATE\b/i.test(s)) return doUpdate(s, params);
    if (/^DELETE\b/i.test(s)) return doDelete(s, params);
    if (/^SELECT\b/i.test(s)) return doSelect(s, params);
    throw new Error(`fake db: unsupported SQL: ${s.slice(0, 100)}`);
}

const mockDb = {
    run: async (sql, params = []) => query(sql, params),
    getOne: async (sql, params = []) => query(sql, params).rows[0] || null,
    getAll: async (sql, params = []) => query(sql, params).rows,
    exec: async (sql) => { query(sql); },
    getClient: async () => ({ query: async (sql, params = []) => query(sql, params), release() {} }),
};

// The delete path purges the app's DATA too (per-app database + attachment
// objects), so those two collaborators are stubbed as well — the suite stays
// hermetic and can pin that the purge actually happens.
const purge = { resets: [], deletedKeys: [], storageAvailable: true, resetThrows: false };
const mockDbStore = {
    reset: async (ownerId, appId) => {
        if (purge.resetThrows) throw new Error('rustfs unreachable');
        purge.resets.push(`${ownerId}:${appId}`);
    },
};
const mockStorage = {
    isAvailable: () => purge.storageAvailable,
    deleteFile: async (key) => { purge.deletedKeys.push(key); },
    buildStudioAppAttachmentKey: (ownerId, appId, sha) => `studio-apps/${ownerId}/${appId}/attachments/${sha}`,
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    if (request === './studioAppDbStore') return 'mock-dbstore';
    if (request === './storageStore') return 'mock-storage';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };
require.cache['mock-dbstore'] = { id: 'mock-dbstore', exports: mockDbStore };
require.cache['mock-storage'] = { id: 'mock-storage', exports: mockStorage };

const store = require('./studioAppStore');
const { LIMITS } = require('../appStudio/componentSpecs');

function resetTables() {
    tables.studio_apps = [];
    tables.studio_app_versions = [];
    tables.studio_app_attachments = [];
    purge.resets = [];
    purge.deletedKeys = [];
    purge.storageAvailable = true;
    purge.resetThrows = false;
}

// ── CRUD happy paths ──────────────────────────────────────────────

test('createStudioApp defaults to the canonical empty definition', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'CRM' });
    assert.ok(app.id);
    assert.strictEqual(app.userId, 'alice');
    assert.strictEqual(app.name, 'CRM');
    assert.strictEqual(app.definitionVersion, 1);
    assert.strictEqual(app.isPublished, false);
    assert.deepStrictEqual(app.sharedGroups, []);
    assert.strictEqual(app.publishedDefinition, null);
    // emptyDefinition shape from componentSpecs (v2 contract)
    assert.strictEqual(app.definition.schemaVersion, 2);
    assert.strictEqual(app.definition.screens.length, 1);
    assert.strictEqual(app.definition.homeScreenId, app.definition.screens[0].id);
});

test('createStudioApp persists an explicit definition + metadata', async () => {
    resetTables();
    const def = { schemaVersion: 1, meta: { name: 'X' }, screens: [], actions: {} };
    const app = await store.createStudioApp({
        userId: 'alice', organizationId: 'org1', name: 'X', description: 'd',
        icon: 'LayoutGrid', accentColor: '#0F766E', definition: def,
    });
    assert.strictEqual(app.organizationId, 'org1');
    assert.strictEqual(app.accentColor, '#0F766E');
    assert.deepStrictEqual(app.definition, def);
    const fetched = await store.getStudioApp(app.id);
    assert.deepStrictEqual(fetched.definition, def);
});

test('a new app is born on the engine this server actually runs', async () => {
    // The column DEFAULT is 'sqlite' (it was added for apps that predate the
    // Postgres engine). On a pg replica that default is a trap: the engine's
    // interlock refuses any app not marked 'pg', so every freshly created app
    // answered engine_mismatch and nothing on it worked. Found by installing a
    // template on the local pg stack; pinned here so it stays fixed.
    const engineFlag = require('../appStudio/engineFlag');
    try {
        engineFlag._setForTests('pg');
        resetTables();
        await store.createStudioApp({ userId: 'alice', name: 'On pg' });
        assert.strictEqual(tables.studio_apps[0].engine, 'pg');

        engineFlag._setForTests('sqlite');
        resetTables();
        await store.createStudioApp({ userId: 'alice', name: 'On sqlite' });
        assert.strictEqual(tables.studio_apps[0].engine, 'sqlite');
    } finally {
        engineFlag._setForTests(null);
    }
});

test('getStudioApp returns null for an unknown id', async () => {
    resetTables();
    assert.strictEqual(await store.getStudioApp('nope'), null);
});

test('updateStudioApp whitelists metadata columns and is owner-scoped', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Old' });
    const updated = await store.updateStudioApp(app.id, {
        name: 'New', description: 'desc', icon: 'Zap', accentColor: '#0369A1',
        isPublished: true, definition: { hacked: true }, // not whitelisted — ignored
    }, 'alice');
    assert.strictEqual(updated.name, 'New');
    assert.strictEqual(updated.icon, 'Zap');
    assert.strictEqual(updated.accentColor, '#0369A1');
    assert.strictEqual(updated.isPublished, false, 'is_published is not updatable here');
    assert.strictEqual(updated.definition.hacked, undefined, 'definition is not updatable here');
    // Wrong owner → null, row untouched.
    assert.strictEqual(await store.updateStudioApp(app.id, { name: 'Hax' }, 'mallory'), null);
    assert.strictEqual((await store.getStudioApp(app.id)).name, 'New');
});

test('deleteStudioApp removes the app and its version snapshots', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Doomed' });
    await store.setStudioAppPublished(app.id, true, 'alice', [], 'org1');
    assert.strictEqual((await store.listVersions(app.id, 'alice')).length, 1);
    const deleted = await store.deleteStudioApp(app.id, 'alice');
    assert.strictEqual(deleted.id, app.id);
    assert.strictEqual(await store.getStudioApp(app.id), null);
    assert.strictEqual(tables.studio_app_versions.length, 0, 'version rows are removed too');
});

test('publishing syncs accent_color to the published theme primary', async () => {
    // The gallery tile and the running app used to disagree about the app's
    // colour; publishing is where they are reconciled.
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Coloured', accentColor: '#111111' });
    const definition = { schemaVersion: 2, meta: { name: 'Coloured' }, theme: { primary: '#B45309' }, screens: [], actions: {} };
    await store.setStudioAppPublished(app.id, true, 'alice', [], 'org1', definition, 3);

    const after = await store.getStudioApp(app.id);
    assert.strictEqual(after.accentColor, '#B45309');
});

test('deleteStudioApp PURGES the data: per-app database + attachment objects + ledger', async () => {
    // The GDPR hole this closes: deleting an app used to remove three Postgres
    // rows and leave every record, e-mail body and uploaded document behind in
    // storage — unreachable, and permanent.
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Doomed' });
    tables.studio_app_attachments.push(
        { id: 'att_1', app_id: app.id, owner_user_id: 'alice', sha256: 'aaa' },
        { id: 'att_2', app_id: app.id, owner_user_id: 'alice', sha256: 'bbb' },
    );

    await store.deleteStudioApp(app.id, 'alice');

    assert.deepStrictEqual(purge.resets, [`alice:${app.id}`], 'the per-app database is dropped through the engine facade');
    assert.deepStrictEqual(purge.deletedKeys.sort(), [
        `studio-apps/alice/${app.id}/attachments/aaa`,
        `studio-apps/alice/${app.id}/attachments/bbb`,
    ], 'every attachment object is deleted from storage');
    assert.strictEqual(tables.studio_app_attachments.length, 0, 'and their ledger rows go with them');
});

test('a storage failure never blocks the delete (best-effort purge, loud log)', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Doomed' });
    purge.resetThrows = true;

    const deleted = await store.deleteStudioApp(app.id, 'alice');
    assert.strictEqual(deleted.id, app.id, 'an app must never become undeletable because RustFS blinked');
    assert.strictEqual(await store.getStudioApp(app.id), null);
});

// ── Accessible-apps matrix ────────────────────────────────────────

async function seedMatrix() {
    resetTables();
    const a1 = await store.createStudioApp({ userId: 'alice', name: 'A1 private' });
    const b1 = await store.createStudioApp({ userId: 'bob', name: 'B1 org-wide' });
    await store.setStudioAppPublished(b1.id, true, 'bob', [], 'org1');
    const b2 = await store.createStudioApp({ userId: 'bob', name: 'B2 group-only' });
    await store.setStudioAppPublished(b2.id, true, 'bob', ['g1'], 'org1');
    const b3 = await store.createStudioApp({ userId: 'bob', name: 'B3 private' });
    const c1 = await store.createStudioApp({ userId: 'carol', name: 'C1 other-org' });
    await store.setStudioAppPublished(c1.id, true, 'carol', [], 'org2');
    return { a1, b1, b2, b3, c1 };
}

test('getAccessibleStudioApps: owner / org-published / group-restricted / unpublished', async () => {
    const { a1, b1, b2, b3, c1 } = await seedMatrix();

    // dave: org1 member in g1 → sees the org-wide app and the g1-restricted one.
    const dave = await store.getAccessibleStudioApps('dave', ['g1'], ['org1']);
    assert.deepStrictEqual(dave.map(a => a.id).sort(), [b1.id, b2.id].sort());

    // erin: org1 member in g2 → group-restricted app is filtered out.
    const erin = await store.getAccessibleStudioApps('erin', ['g2'], ['org1']);
    assert.deepStrictEqual(erin.map(a => a.id), [b1.id]);

    // alice: her own unpublished app + org1's org-wide publish.
    const alice = await store.getAccessibleStudioApps('alice', [], ['org1']);
    assert.deepStrictEqual(alice.map(a => a.id).sort(), [a1.id, b1.id].sort());

    // bob: owner sees all of his, published or not (but not carol's other-org app).
    const bob = await store.getAccessibleStudioApps('bob', [], ['org1']);
    assert.deepStrictEqual(bob.map(a => a.id).sort(), [b1.id, b2.id, b3.id].sort());

    // outsider with no org overlap sees nothing.
    assert.deepStrictEqual(await store.getAccessibleStudioApps('zed', [], ['org9']), []);

    // list rows are meta-only — no payloads ride along.
    for (const row of [...dave, ...alice]) {
        assert.ok(!('definition' in row), 'list rows must not carry definition');
        assert.ok(!('publishedDefinition' in row), 'list rows must not carry published_definition');
        assert.ok(!('builderSession' in row), 'list rows must not carry builder_session');
    }
    assert.ok(c1.id, 'c1 seeded');
});

test('canRead/canWrite predicates + userHasAnyStudioAppAccess', async () => {
    const { b1, b2, b3 } = await seedMatrix();
    const app1 = await store.getStudioApp(b1.id);
    const app2 = await store.getStudioApp(b2.id);
    const app3 = await store.getStudioApp(b3.id);

    // canRead
    assert.strictEqual(store.canReadStudioApp(app1, 'bob', [], []), true, 'owner always reads');
    assert.strictEqual(store.canReadStudioApp(app1, 'dave', [], ['org1']), true, 'org-wide publish');
    assert.strictEqual(store.canReadStudioApp(app1, 'dave', [], ['org2']), false, 'wrong org');
    assert.strictEqual(store.canReadStudioApp(app2, 'dave', ['g1'], ['org1']), true, 'group member');
    assert.strictEqual(store.canReadStudioApp(app2, 'erin', ['g2'], ['org1']), false, 'not in shared group');
    assert.strictEqual(store.canReadStudioApp(app3, 'dave', ['g1'], ['org1']), false, 'unpublished');
    assert.strictEqual(store.canReadStudioApp(null, 'dave', [], []), false);

    // canWrite is owner-only — even users who can read must not write.
    assert.strictEqual(store.canWriteStudioApp(app1, 'bob'), true);
    assert.strictEqual(store.canWriteStudioApp(app1, 'dave'), false);
    assert.strictEqual(store.canWriteStudioApp(null, 'bob'), false);

    // userHasAnyStudioAppAccess
    assert.strictEqual(await store.userHasAnyStudioAppAccess('bob', [], []), true, 'owner');
    assert.strictEqual(await store.userHasAnyStudioAppAccess('dave', [], ['org1']), true, 'org-wide publish');
    assert.strictEqual(await store.userHasAnyStudioAppAccess('zed', [], ['org9']), false, 'no overlap');
    assert.strictEqual(await store.userHasAnyStudioAppAccess('zed', [], []), false, 'no orgs at all');

    // an org where only group-restricted apps exist: membership decides.
    resetTables();
    const f1 = await store.createStudioApp({ userId: 'frank', name: 'F1' });
    await store.setStudioAppPublished(f1.id, true, 'frank', ['gX'], 'org3');
    assert.strictEqual(await store.userHasAnyStudioAppAccess('gina', [], ['org3']), false, 'outside the shared group');
    assert.strictEqual(await store.userHasAnyStudioAppAccess('gina', ['gX'], ['org3']), true, 'inside the shared group');
});

// ── saveDefinition CAS ────────────────────────────────────────────

test('saveDefinition bumps the version and detects CAS conflicts', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'CAS' });
    const d1 = { schemaVersion: 1, meta: { name: 'v2' }, screens: [], actions: {} };

    const r1 = await store.saveDefinition(app.id, 'alice', d1, { expectedVersion: 1 });
    assert.deepStrictEqual(r1, { ok: true, version: 2 });

    // Stale writer (still at version 1) must conflict and get the server copy.
    const r2 = await store.saveDefinition(app.id, 'alice', { stale: true }, { expectedVersion: 1 });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.conflict, true);
    assert.strictEqual(r2.currentVersion, 2);
    assert.deepStrictEqual(r2.definition, d1, 'conflict returns the server copy');
    assert.deepStrictEqual((await store.getStudioApp(app.id)).definition, d1, 'stale write did not land');

    // Unconditional write (no expectedVersion) always lands.
    const d2 = { schemaVersion: 1, meta: { name: 'v3' }, screens: [], actions: {} };
    const r3 = await store.saveDefinition(app.id, 'alice', d2);
    assert.deepStrictEqual(r3, { ok: true, version: 3 });

    // Ownership is enforced in the locking SELECT.
    const r4 = await store.saveDefinition(app.id, 'mallory', { hax: true });
    assert.deepStrictEqual(r4, { ok: false, notFound: true });
    assert.deepStrictEqual((await store.getStudioApp(app.id)).definition, d2);
});

test('saveDefinition rejects definitions over MAX_DEFINITION_BYTES', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Big' });
    const oversized = { blob: 'x'.repeat(LIMITS.MAX_DEFINITION_BYTES) };
    await assert.rejects(
        () => store.saveDefinition(app.id, 'alice', oversized),
        err => err.code === 'definition_too_large'
    );
    // createStudioApp shares the guard.
    await assert.rejects(
        () => store.createStudioApp({ userId: 'alice', name: 'Big2', definition: oversized }),
        err => err.code === 'definition_too_large'
    );
});

// ── Publish: freeze + versions + prune ────────────────────────────

test('publish freezes the definition, stamps published_at and snapshots a version', async () => {
    resetTables();
    const d1 = { schemaVersion: 1, meta: { name: 'live' }, screens: [], actions: {} };
    const app = await store.createStudioApp({ userId: 'alice', name: 'Pub', definition: d1 });

    assert.strictEqual(await store.setStudioAppPublished(app.id, true, 'alice', ['g9'], 'org1'), true);
    let row = await store.getStudioApp(app.id);
    assert.strictEqual(row.isPublished, true);
    assert.strictEqual(row.organizationId, 'org1');
    assert.deepStrictEqual(row.sharedGroups, ['g9']);
    assert.deepStrictEqual(row.publishedDefinition, d1, 'working definition frozen into published_definition');
    assert.ok(row.publishedAt, 'published_at stamped');
    const versions = await store.listVersions(app.id, 'alice');
    assert.strictEqual(versions.length, 1);
    assert.strictEqual(versions[0].summary, 'Published');
    assert.ok(!('definition' in versions[0]), 'listVersions is meta-only');

    // Owner keeps editing — viewers' copy stays frozen.
    const d2 = { schemaVersion: 1, meta: { name: 'draft' }, screens: [], actions: {} };
    await store.saveDefinition(app.id, 'alice', d2);
    row = await store.getStudioApp(app.id);
    assert.deepStrictEqual(row.definition, d2);
    assert.deepStrictEqual(row.publishedDefinition, d1);

    // Unpublish only flips the flag — frozen copy, stamp and history stay.
    const publishedAt = row.publishedAt;
    assert.strictEqual(await store.setStudioAppPublished(app.id, false, 'alice'), true);
    row = await store.getStudioApp(app.id);
    assert.strictEqual(row.isPublished, false);
    assert.deepStrictEqual(row.publishedDefinition, d1);
    assert.strictEqual(row.publishedAt, publishedAt);
    assert.deepStrictEqual(row.sharedGroups, ['g9'], 'undefined sharedGroups preserves the DB value');
    assert.strictEqual((await store.listVersions(app.id, 'alice')).length, 1, 'unpublish does not snapshot');

    // Non-owner cannot flip publish state.
    assert.strictEqual(await store.setStudioAppPublished(app.id, true, 'mallory'), false);
});

test('publish records which definition_version went live; the draft then moves on alone', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Drift' });
    assert.strictEqual(app.publishedVersion, null, 'never published → unknown, not 0');

    await store.saveDefinition(app.id, 'alice', { rev: 'a' });   // → version 2
    await store.setStudioAppPublished(app.id, true, 'alice', [], 'org1');
    let row = await store.getStudioApp(app.id);
    assert.strictEqual(row.definitionVersion, 2);
    assert.strictEqual(row.publishedVersion, 2, 'the frozen draft is version 2');

    // Fifty more autosaves later the live copy is still version 2.
    await store.saveDefinition(app.id, 'alice', { rev: 'b' });
    await store.saveDefinition(app.id, 'alice', { rev: 'c' });
    row = await store.getStudioApp(app.id);
    assert.strictEqual(row.definitionVersion, 4);
    assert.strictEqual(row.publishedVersion, 2, 'published_version does not follow the draft');

    // Unpublish leaves it alone — the frozen copy is still that version.
    await store.setStudioAppPublished(app.id, false, 'alice');
    assert.strictEqual((await store.getStudioApp(app.id)).publishedVersion, 2);

    // Meta-only list rows carry it too (the gallery/header read those).
    const [meta] = await store.getStudioAppsByUser('alice');
    assert.strictEqual(meta.publishedVersion, 2);
    assert.strictEqual(meta.definitionVersion, 4);
});

test('publish records the version the CALLER validated, not a racing newer draft', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Race' });
    const validated = { rev: 'validated' };
    // The route validates version 1 without a lock; a concurrent autosave then
    // lands version 2 before the publish transaction takes the row.
    await store.saveDefinition(app.id, 'alice', { rev: 'concurrent' });

    await store.setStudioAppPublished(app.id, true, 'alice', [], 'org1', validated, 1);
    const row = await store.getStudioApp(app.id);
    assert.deepStrictEqual(row.publishedDefinition, validated);
    assert.strictEqual(row.publishedVersion, 1, 'names the version whose bytes went live');
    assert.strictEqual(row.definitionVersion, 2);
});

test('publish prunes version history to the newest MAX_VERSIONS_PER_APP', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Pruned' });
    const total = store.MAX_VERSIONS_PER_APP + 2;
    for (let i = 0; i < total; i++) {
        await store.saveDefinition(app.id, 'alice', { rev: i });
        await store.setStudioAppPublished(app.id, true, 'alice');
    }
    const versions = await store.listVersions(app.id, 'alice');
    assert.strictEqual(versions.length, store.MAX_VERSIONS_PER_APP);
    // Newest-first, and the newest snapshot is the latest publish.
    assert.ok(versions[0].createdAt >= versions[versions.length - 1].createdAt);
    const newest = await store.getVersion(app.id, versions[0].id, 'alice');
    assert.deepStrictEqual(newest.definition, { rev: total - 1 });
    // The oldest snapshots fell off.
    const kept = new Set(tables.studio_app_versions.map(r => JSON.parse(r.definition).rev));
    assert.ok(!kept.has(0) && !kept.has(1), 'the two oldest snapshots are pruned');
});

test('createVersionSnapshot writes a checkpoint and prunes to the newest MAX_VERSIONS_PER_APP', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Checkpointed' });
    const total = store.MAX_VERSIONS_PER_APP + 2;
    for (let i = 0; i < total; i++) {
        const vid = await store.createVersionSnapshot(app.id, 'alice', { rev: i }, `AI checkpoint — phase ${i}`);
        assert.ok(typeof vid === 'string' && vid, 'returns the new version id');
    }
    const versions = await store.listVersions(app.id, 'alice');
    assert.strictEqual(versions.length, store.MAX_VERSIONS_PER_APP, 'shared 20-cap enforced');
    assert.strictEqual(versions[0].summary, `AI checkpoint — phase ${total - 1}`, 'newest kept with its summary');
    // The two oldest checkpoints fell off; the newest snapshot round-trips.
    const kept = new Set(tables.studio_app_versions.map(r => JSON.parse(r.definition).rev));
    assert.ok(!kept.has(0) && !kept.has(1), 'oldest checkpoints pruned');
    const newest = await store.getVersion(app.id, versions[0].id, 'alice');
    assert.deepStrictEqual(newest.definition, { rev: total - 1 });
});

test('getVersion + restoreVersion round-trip (and bump the CAS version)', async () => {
    resetTables();
    const d1 = { schemaVersion: 1, meta: { name: 'first' }, screens: [], actions: {} };
    const app = await store.createStudioApp({ userId: 'alice', name: 'Hist', definition: d1 });
    await store.setStudioAppPublished(app.id, true, 'alice', [], 'org1');
    const [v1] = await store.listVersions(app.id, 'alice');

    const d2 = { schemaVersion: 1, meta: { name: 'second' }, screens: [], actions: {} };
    await store.saveDefinition(app.id, 'alice', d2); // version 1 → 2

    const snap = await store.getVersion(app.id, v1.id, 'alice');
    assert.deepStrictEqual(snap.definition, d1);

    const restored = await store.restoreVersion(app.id, v1.id, 'alice');
    assert.deepStrictEqual(restored.definition, d1, 'working definition is the snapshot again');
    assert.strictEqual(restored.definitionVersion, 3, 'restore bumps definition_version');

    // Foreign/absent version ids restore nothing.
    assert.strictEqual(await store.restoreVersion(app.id, 'nope', 'alice'), null);
    assert.strictEqual(await store.restoreVersion(app.id, v1.id, 'mallory'), null);
});

// ── Builder session ───────────────────────────────────────────────

test('setBuilderSession CAS: monotonic version + conflict on mismatch', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Chat' });
    assert.strictEqual(await store.getBuilderSession(app.id, 'alice'), null, 'starts empty');

    const r1 = await store.setBuilderSession(app.id, 'alice', { messages: [{ role: 'user', content: 'hi' }] }, { expectedVersion: 0 });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.snapshot.version, 1);

    // Stale second tab (still at 0) must conflict and receive the current snapshot.
    const r2 = await store.setBuilderSession(app.id, 'alice', { messages: [] }, { expectedVersion: 0 });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.conflict, true);
    assert.strictEqual(r2.current.version, 1);

    // Unconditional write still bumps.
    const r3 = await store.setBuilderSession(app.id, 'alice', { messages: [] });
    assert.strictEqual(r3.snapshot.version, 2);

    const persisted = await store.getBuilderSession(app.id, 'alice');
    assert.strictEqual(persisted.version, 2);

    // Unknown app → notFound.
    const r4 = await store.setBuilderSession('nope', 'alice', {});
    assert.deepStrictEqual(r4, { ok: false, notFound: true });
});

test('setBuilderSession trims oversized snapshots by dropping oldest messages', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Long chat' });
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `${i}:${'x'.repeat(3000)}` }));
    const r = await store.setBuilderSession(app.id, 'alice', { messages });
    assert.strictEqual(r.ok, true);
    assert.ok(r.snapshot.messages.length < 60, 'oldest messages dropped');
    assert.ok(JSON.stringify(r.snapshot).length <= store.SNAPSHOT_MAX_BYTES + 64, 'snapshot fits the 64KB budget');
    // Newest message survives the trim.
    assert.match(r.snapshot.messages[r.snapshot.messages.length - 1].content, /^59:/);
    // The trimmed snapshot is what got persisted.
    const persisted = await store.getBuilderSession(app.id, 'alice');
    assert.strictEqual(persisted.messages.length, r.snapshot.messages.length);
});

test('setBuilderSession trims in whole blocks when the builder asks (prefix-cache stability)', async () => {
    resetTables();
    // The builder route composes [prefix…][history…]; evicting one message per
    // save moves the first kept message every time and shifts every later byte
    // the llama.cpp prefix cache could reuse. With trimBlock the head goes in
    // multiples of the block, so the kept run only moves at a block boundary.
    const app = await store.createStudioApp({ userId: 'alice', name: 'Block chat' });
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:${'x'.repeat(3000)}` }));
    const r = await store.setBuilderSession(app.id, 'alice', { messages }, { trimBlock: 6 });
    assert.strictEqual(r.ok, true);
    const kept = r.snapshot.messages;
    assert.ok(kept.length < 60 && kept.length >= 8, `kept ${kept.length}`);
    const firstIdx = Number(kept[0].content.split(':')[0]);
    assert.strictEqual((60 - kept.length) % 6, 0, 'dropped count is a multiple of the block');
    assert.strictEqual(firstIdx % 6, 0, 'the kept run starts on a block boundary');
    assert.match(kept[kept.length - 1].content, /^59:/, 'newest message survives');
    assert.ok(JSON.stringify(r.snapshot).length <= store.SNAPSHOT_MAX_BYTES + 64, 'snapshot fits the budget');
    // Default (no block) evicts one at a time, so it never drops more than the block path.
    const r2 = await store.setBuilderSession(app.id, 'alice', { messages });
    assert.ok(r2.snapshot.messages.length >= kept.length, 'the plain path keeps at least as many messages');
});

test('trim hardening: pinned top-level keys survive intact; summary gets the trim marker once', async () => {
    resetTables();
    // The pinned-key contract is frozen (Wave 2C) — future snapshot writers
    // rely on exactly these names surviving every trim.
    assert.deepStrictEqual(
        [...store.PINNED_SNAPSHOT_KEYS],
        ['pendingPlan', 'approvedPlan', 'checkpoints', 'continueToken', 'lastTier'],
    );
    assert.ok(Object.isFrozen(store.PINNED_SNAPSHOT_KEYS));

    const app = await store.createStudioApp({ userId: 'alice', name: 'Plan chat' });
    const plan = { planId: 'plan-1', title: 'CRM', tables: [{ key: 'deals' }], phases: [{ label: 'Data model' }] };
    const checkpoints = [{ versionId: 'v1', summary: 'AI checkpoint — Data model' }];
    const bigMessages = () => Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `${i}:${'x'.repeat(3000)}` }));

    const r = await store.setBuilderSession(app.id, 'alice', {
        summary: 'Building a CRM',
        messages: bigMessages(),
        pendingPlan: plan,
        approvedPlan: plan,
        checkpoints,
        continueToken: 'tok-1',
        lastTier: 'complex',
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.snapshot.messages.length < 60, 'messages were trimmed');
    assert.ok(JSON.stringify(r.snapshot).length <= store.SNAPSHOT_MAX_BYTES + 64, 'snapshot fits the budget');
    // ONLY messages may be trimmed — every pinned key rides through intact.
    assert.deepStrictEqual(r.snapshot.pendingPlan, plan);
    assert.deepStrictEqual(r.snapshot.approvedPlan, plan);
    assert.deepStrictEqual(r.snapshot.checkpoints, checkpoints);
    assert.strictEqual(r.snapshot.continueToken, 'tok-1');
    assert.strictEqual(r.snapshot.lastTier, 'complex');
    assert.strictEqual(r.snapshot.summary, `Building a CRM ${store.SNAPSHOT_TRIM_MARKER}`);

    // Idempotent marker: re-trimming an already-marked snapshot never doubles it.
    const r2 = await store.setBuilderSession(app.id, 'alice', {
        ...r.snapshot,
        messages: [...r.snapshot.messages, ...bigMessages()],
    });
    assert.strictEqual(r2.ok, true);
    const occurrences = r2.snapshot.summary.split(store.SNAPSHOT_TRIM_MARKER).length - 1;
    assert.strictEqual(occurrences, 1, 'marker appended once, idempotently');
    assert.deepStrictEqual(r2.snapshot.pendingPlan, plan, 'pinned keys survive repeated trims');

    // An under-budget snapshot is returned untouched — no marker, no trim.
    const small = await store.setBuilderSession(app.id, 'alice', {
        summary: 'tiny', messages: [{ role: 'user', content: 'hi' }], pendingPlan: plan,
    });
    assert.strictEqual(small.snapshot.summary, 'tiny');
    assert.strictEqual(small.snapshot.messages.length, 1);

    // A trimmed snapshot with no summary gets the bare marker.
    const noSummary = await store.setBuilderSession(app.id, 'alice', { messages: bigMessages() });
    assert.strictEqual(noSummary.snapshot.summary, store.SNAPSHOT_TRIM_MARKER);
});

test('clearBuilderSession wipes the snapshot (owner-scoped)', async () => {
    resetTables();
    const app = await store.createStudioApp({ userId: 'alice', name: 'Wipe' });
    await store.setBuilderSession(app.id, 'alice', { messages: [{ role: 'user', content: 'hi' }] });
    await store.clearBuilderSession(app.id, 'mallory');
    assert.ok(await store.getBuilderSession(app.id, 'alice'), 'foreign clear is a no-op');
    await store.clearBuilderSession(app.id, 'alice');
    assert.strictEqual(await store.getBuilderSession(app.id, 'alice'), null);
});

// ── Template provenance (template-upgrade feature) ────────────────

test('template stamp: persisted at create, mapped on full AND meta rows, null on blank apps', async () => {
    resetTables();
    const stamped = await store.createStudioApp({
        userId: 'alice', name: 'From template',
        templateId: 'app-crm-pipeline', templateVersion: 1, templateInstallHash: 'a'.repeat(64),
    });
    assert.strictEqual(stamped.templateId, 'app-crm-pipeline');
    assert.strictEqual(stamped.templateVersion, 1);
    assert.strictEqual(stamped.templateInstallHash, 'a'.repeat(64));

    // Meta list rows carry the stamp too (the upgrade-availability check reads
    // it off the list without loading definitions).
    const mine = await store.getStudioAppsByUser('alice');
    const row = mine.find(a => a.id === stamped.id);
    assert.strictEqual(row.templateId, 'app-crm-pipeline');
    assert.strictEqual(row.templateVersion, 1);
    assert.strictEqual(row.templateInstallHash, 'a'.repeat(64));

    const blank = await store.createStudioApp({ userId: 'alice', name: 'Blank' });
    assert.strictEqual(blank.templateId, null);
    assert.strictEqual(blank.templateVersion, null);
    assert.strictEqual(blank.templateInstallHash, null);
});

test('setTemplateStamp moves version + hash, owner-scoped', async () => {
    resetTables();
    const app = await store.createStudioApp({
        userId: 'alice', name: 'Upgradable',
        templateId: 'app-crm-pipeline', templateVersion: 1, templateInstallHash: 'a'.repeat(64),
    });

    assert.strictEqual(
        await store.setTemplateStamp(app.id, 'mallory', { templateVersion: 9, templateInstallHash: 'f'.repeat(64) }),
        false, 'a non-owner moves nothing'
    );
    let fetched = await store.getStudioApp(app.id);
    assert.strictEqual(fetched.templateVersion, 1);

    assert.strictEqual(
        await store.setTemplateStamp(app.id, 'alice', { templateVersion: 2, templateInstallHash: 'b'.repeat(64) }),
        true
    );
    fetched = await store.getStudioApp(app.id);
    assert.strictEqual(fetched.templateVersion, 2);
    assert.strictEqual(fetched.templateInstallHash, 'b'.repeat(64));
    // templateId never changes on upgrade — same template, newer version.
    assert.strictEqual(fetched.templateId, 'app-crm-pipeline');
});

// ── De herindexerende wrappers, op GEDRAG ─────────────────────────
//
// `appStudio/automationUsage.savePaths.test.js` telt de save-paden en eist per
// schrijver een `x: xIndexed`-export. Wat dat NIET kon zien: of een wrapper de
// reconciler ook echt aanroept. Eén overgebleven aanroep hield de
// string-controle voor alle wrappers in de lucht, dus de belangrijkste van
// allemaal — `saveDefinitionIndexed`, het pad dat élke autosave van élke app
// neemt — kon eruit zonder dat er iets rood werd. De gevolgen in productie zijn
// stil en permanent: `reconcileAutomationUsage` is delete-then-insert, dus
// zonder de aanroep blijven de rijen van de VÓRIGE definitie staan en houdt een
// actie die haar routine kwijtraakt de capsule voor altijd in de lucht.
//
// Vandaar deze vier: de echte store, de echte wrappers, de reconciler
// vervangen door een teller.

const usageSync = require('../appStudio/automationUsageSync');

/** Vang de detached reconciles die tijdens `fn` worden ingepland. */
async function withReindexSpy(fn) {
    const realDetached = usageSync.reconcileAppAutomationUsageDetached;
    const realPurge = usageSync.purgeAppAutomationUsage;
    const seen = { reindexed: [], purged: [] };
    usageSync.reconcileAppAutomationUsageDetached = (appId) => { seen.reindexed.push(appId); };
    usageSync.purgeAppAutomationUsage = async (appId) => { seen.purged.push(appId); return 0; };
    try { await fn(seen); } finally {
        usageSync.reconcileAppAutomationUsageDetached = realDetached;
        usageSync.purgeAppAutomationUsage = realPurge;
    }
}

const DEF_WITH_BUTTON = {
    schemaVersion: 2,
    screens: [{ id: 'scr_1', sections: [{ id: 'sec_1', children: [{ id: 'cmp_b1', type: 'button', onClick: 'act_1' }] }] }],
    actions: { act_1: { kind: 'run_automation', automationId: 'auto_1' } },
};

test('createStudioApp herindexeert', async () => {
    resetTables();
    await withReindexSpy(async (seen) => {
        const app = await store.createStudioApp({ userId: 'alice', name: 'A', definition: DEF_WITH_BUTTON });
        assert.deepStrictEqual(seen.reindexed, [app.id]);
    });
});

test('saveDefinition herindexeert — het pad dat elke autosave neemt', async () => {
    resetTables();
    await withReindexSpy(async (seen) => {
        const app = await store.createStudioApp({ userId: 'alice', name: 'A' });
        seen.reindexed.length = 0;
        const out = await store.saveDefinition(app.id, 'alice', DEF_WITH_BUTTON, { expectedVersion: app.definitionVersion });
        assert.strictEqual(out.ok, true);
        assert.deepStrictEqual(seen.reindexed, [app.id]);
    });
});

test('een MISLUKTE saveDefinition herindexeert niet — er is niets veranderd', async () => {
    resetTables();
    await withReindexSpy(async (seen) => {
        const app = await store.createStudioApp({ userId: 'alice', name: 'A' });
        seen.reindexed.length = 0;
        const out = await store.saveDefinition(app.id, 'alice', DEF_WITH_BUTTON, { expectedVersion: 99 });
        assert.strictEqual(out.ok, false, 'een CAS-conflict hoort te falen');
        assert.deepStrictEqual(seen.reindexed, []);
    });
});

test('restoreVersion herindexeert — een teruggezette versie noemt andere routines', async () => {
    resetTables();
    await withReindexSpy(async (seen) => {
        const app = await store.createStudioApp({ userId: 'alice', name: 'A', definition: DEF_WITH_BUTTON });
        const versionId = await store.createVersionSnapshot(app.id, 'alice', DEF_WITH_BUTTON, 'checkpoint');
        seen.reindexed.length = 0;
        const restored = await store.restoreVersion(app.id, versionId, 'alice');
        assert.ok(restored, 'de fixture hoort een terugzetbare versie te maken — anders bewijst deze test niets');
        assert.deepStrictEqual(seen.reindexed, [app.id]);
    });
});

test('publiceren en DEPUBLICEREN herindexeren — bezoekers draaien de gepubliceerde kopie', async () => {
    resetTables();
    await withReindexSpy(async (seen) => {
        const app = await store.createStudioApp({ userId: 'alice', name: 'A', definition: DEF_WITH_BUTTON });
        seen.reindexed.length = 0;
        assert.strictEqual(await store.setStudioAppPublished(app.id, true, 'alice'), true);
        assert.deepStrictEqual(seen.reindexed, [app.id], 'publiceren verandert de gepubliceerde helft van de unie');
        seen.reindexed.length = 0;
        assert.strictEqual(await store.setStudioAppPublished(app.id, false, 'alice'), true);
        assert.deepStrictEqual(seen.reindexed, [app.id], 'depubliceren haalt hem er weer uit');
    });
});

test('een publish door een NIET-eigenaar herindexeert niet', async () => {
    resetTables();
    await withReindexSpy(async (seen) => {
        const app = await store.createStudioApp({ userId: 'alice', name: 'A' });
        seen.reindexed.length = 0;
        assert.strictEqual(await store.setStudioAppPublished(app.id, true, 'mallory'), false);
        assert.deepStrictEqual(seen.reindexed, []);
    });
});

test('deleteStudioApp ruimt de index op in plaats van hem te herbouwen', async () => {
    resetTables();
    await withReindexSpy(async (seen) => {
        const app = await store.createStudioApp({ userId: 'alice', name: 'A', definition: DEF_WITH_BUTTON });
        seen.reindexed.length = 0;
        assert.ok(await store.deleteStudioApp(app.id, 'alice'), 'de delete hoort de verwijderde rij terug te geven');
        assert.deepStrictEqual(seen.purged, [app.id]);
        assert.deepStrictEqual(seen.reindexed, [], 'een verwijderde app hoort niet opnieuw geindexeerd te worden');
    });
});
