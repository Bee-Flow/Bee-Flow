const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const { backfillOrg, BACKFILL_SURFACES, RUNNERS } = require('./encryptionBackfill');
const { conversationKey, messageAad } = require('./agent/messageCrypto');
const { decryptField, isEnvelope } = require('./lib/fieldEnvelope');

const USER_KEY = crypto.randomBytes(32);
const PROJECT_KEY = crypto.randomBytes(32);
const ALL_ON = { encryption_tier: 'managed', encryption_scope: null };

function ctxOf(key) {
    return {
        key, backgroundKey: key, tier: 'managed',
        encryptMessages: true, encryptMeta: true, encryptConversationMeta: true,
        encryptTitle: true, encryptNotebookMessages: true,
    };
}

/**
 * A tiny fake database: `tables` maps a table name to rows; getAll picks the
 * table out of the SQL, run records UPDATEs. `casMiss` forces rowCount 0.
 */
function fakeDeps({ org = ALL_ON, tables = {}, casMiss = false, resolve } = {}) {
    const updates = [];
    const resolved = [];
    const deps = {
        updates, resolved,
        async getOne(sql) {
            if (/FROM organizations/.test(sql)) return org ? { id: 'o1', ...org } : null;
            if (/COUNT\(\*\)/.test(sql)) return { n: (tables.transcriptions || []).length };
            return null;
        },
        async getAll(sql, params) {
            const m = sql.match(/FROM (\w+)/);
            const name = m && m[1];
            const cursor = params[0];
            return (tables[name] || []).filter(r => r.id > cursor).slice(0, params[2]);
        },
        async run(sql, params) { updates.push({ sql, params }); return { rowCount: casMiss ? 0 : 1 }; },
        async resolveCrypto(opts) {
            resolved.push(opts);
            if (resolve) return resolve(opts);
            return ctxOf(opts.projectKeyFor ? PROJECT_KEY : USER_KEY);
        },
    };
    return deps;
}

const msgRow = (over = {}) => ({
    id: 'm1', conversation_id: 'c1', conversation_type: 'agent', content: 'hello', meta_json: null,
    user_id: 'u1', crypto_scope: 'user', project_id: null, ...over,
});

test('tier none is a no-op', async () => {
    const deps = fakeDeps({ org: { encryption_tier: 'none' }, tables: { conversation_messages: [msgRow()] } });
    const res = await backfillOrg('o1', { deps });
    assert.deepStrictEqual(res, { orgId: 'o1', tier: 'none', surfaces: {} });
    assert.strictEqual(deps.updates.length, 0);
});

test('exports', () => {
    assert.deepStrictEqual([...BACKFILL_SURFACES].sort(),
        ['conversationMeta', 'conversationTitle', 'legacyBlobs', 'messages', 'notebookMessages', 'piiTokenMap', 'piiVault', 'transcripts']);
    assert.strictEqual(typeof RUNNERS.messages, 'function');
});

test('encrypts a plaintext message with a compare-and-set UPDATE the runtime can read', async () => {
    const deps = fakeDeps({ tables: { conversation_messages: [msgRow()] } });
    const res = await backfillOrg('o1', { surfaces: ['messages'], deps });
    assert.deepStrictEqual(res.surfaces.messages, { encrypted: 1, skipped: 0, noKey: 0, failed: 0 });
    const [u] = deps.updates;
    assert.match(u.sql, /content IS NOT DISTINCT FROM/);
    const sealed = u.params[0];
    assert.ok(isEnvelope(sealed));
    assert.strictEqual(u.params[1], 'hello'); // old value for the CAS
    assert.strictEqual(decryptField(sealed, {
        key: conversationKey(USER_KEY, 'c1'), aad: messageAad('c1', 'agent', 'content'),
    }), 'hello');
});

test('second run: already-envelope rows are skipped, nothing written', async () => {
    const deps1 = fakeDeps({ tables: { conversation_messages: [msgRow()] } });
    await backfillOrg('o1', { surfaces: ['messages'], deps: deps1 });
    const stored = deps1.updates[0].params[0];
    const deps2 = fakeDeps({ tables: { conversation_messages: [msgRow({ content: stored })] } });
    const res = await backfillOrg('o1', { surfaces: ['messages'], deps: deps2 });
    assert.deepStrictEqual(res.surfaces.messages, { encrypted: 0, skipped: 1, noKey: 0, failed: 0 });
    assert.strictEqual(deps2.updates.length, 0);
});

test('dry run counts but writes nothing', async () => {
    const deps = fakeDeps({ tables: { conversation_messages: [msgRow(), msgRow({ id: 'm2' })] } });
    const res = await backfillOrg('o1', { surfaces: ['messages'], dryRun: true, deps });
    assert.strictEqual(res.surfaces.messages.encrypted, 2);
    assert.strictEqual(deps.updates.length, 0);
});

test('CAS miss (row changed under us) counts as skipped, not encrypted', async () => {
    const deps = fakeDeps({ casMiss: true, tables: { conversation_messages: [msgRow()] } });
    const res = await backfillOrg('o1', { surfaces: ['messages'], deps });
    assert.deepStrictEqual(res.surfaces.messages, { encrypted: 0, skipped: 1, noKey: 0, failed: 0 });
});

test('project-scoped conversation is sealed under the PROJECT key, resolved via projectKeyFor', async () => {
    const deps = fakeDeps({
        tables: { conversation_messages: [msgRow({ crypto_scope: 'project', project_id: 'p1' })] },
    });
    const res = await backfillOrg('o1', { surfaces: ['messages'], deps });
    assert.strictEqual(res.surfaces.messages.encrypted, 1);
    assert.deepStrictEqual(deps.resolved[0].projectKeyFor, { projectId: 'p1', orgId: 'o1' });
    const sealed = deps.updates[0].params[0];
    assert.strictEqual(decryptField(sealed, {
        key: conversationKey(PROJECT_KEY, 'c1'), aad: messageAad('c1', 'agent', 'content'),
    }), 'hello');
    assert.throws(() => decryptField(sealed, {
        key: conversationKey(USER_KEY, 'c1'), aad: messageAad('c1', 'agent', 'content'),
    }));
});

test('project key unavailable: row counts as failed, never falls back to the user key', async () => {
    const deps = fakeDeps({
        tables: { conversation_messages: [msgRow({ crypto_scope: 'project', project_id: 'p1' })] },
        resolve: (opts) => { if (opts.projectKeyFor) throw new Error('no project key'); return ctxOf(USER_KEY); },
    });
    const res = await backfillOrg('o1', { surfaces: ['messages'], deps });
    assert.deepStrictEqual(res.surfaces.messages, { encrypted: 0, skipped: 0, noKey: 0, failed: 1 });
    assert.strictEqual(deps.updates.length, 0);
});

test('one bad row does not abort the batch', async () => {
    const deps = fakeDeps({ tables: { conversation_messages: [msgRow({ id: 'm1' }), msgRow({ id: 'm2' }), msgRow({ id: 'm3' })] } });
    const realRun = deps.run;
    deps.run = async (sql, params) => {
        if (params[params.length - 2] === 'm2' || params.includes('m2')) throw new Error('boom');
        return realRun(sql, params);
    };
    const res = await backfillOrg('o1', { surfaces: ['messages'], deps });
    assert.deepStrictEqual(res.surfaces.messages, { encrypted: 2, skipped: 0, noKey: 0, failed: 1 });
});

test('user with no key is counted noKey (zk without a session)', async () => {
    const deps = fakeDeps({
        org: { encryption_tier: 'zk', encryption_scope: null },
        tables: { conversation_messages: [msgRow()], notebook_conversations: [{ id: 'n1', user_id: 'u1', messages_json: '[{"role":"user"}]' }] },
        resolve: () => ({ ...ctxOf(null), backgroundKey: crypto.randomBytes(32), encryptMessages: false, encryptMeta: false }),
    });
    const res = await backfillOrg('o1', { surfaces: ['messages', 'notebookMessages'], deps });
    assert.strictEqual(res.surfaces.messages.skipped, 1);
    assert.strictEqual(res.surfaces.notebookMessages.noKey, 1);
    assert.strictEqual(deps.updates.length, 0);
});

test('surface switched off in the policy scope is not run', async () => {
    const deps = fakeDeps({
        org: { encryption_tier: 'managed', encryption_scope: { messages: false, messageMeta: false } },
        tables: { conversation_messages: [msgRow()] },
    });
    const res = await backfillOrg('o1', { surfaces: ['messages'], deps });
    assert.deepStrictEqual(res.surfaces.messages, { encrypted: 0, skipped: 0, noKey: 0, failed: 0 });
    assert.strictEqual(deps.updates.length, 0);
});

test('stats are per call: two orgs run concurrently without mixing', async () => {
    const a = fakeDeps({ tables: { conversation_messages: [msgRow()] } });
    const b = fakeDeps({ tables: { conversation_messages: [msgRow({ id: 'x1' }), msgRow({ id: 'x2' })] } });
    const [ra, rb] = await Promise.all([
        backfillOrg('o1', { surfaces: ['messages'], deps: a }),
        backfillOrg('o2', { surfaces: ['messages'], deps: b }),
    ]);
    assert.strictEqual(ra.surfaces.messages.encrypted, 1);
    assert.strictEqual(rb.surfaces.messages.encrypted, 2);
});

test('limit and onProgress', async () => {
    const rows = [1, 2, 3, 4, 5].map(i => msgRow({ id: `m${i}` }));
    const deps = fakeDeps({ tables: { conversation_messages: rows } });
    deps.batch = 2;
    const seen = [];
    const res = await backfillOrg('o1', { surfaces: ['messages'], limit: 3, deps, onProgress: (s, st) => seen.push([s, st.encrypted]) });
    assert.strictEqual(res.surfaces.messages.encrypted, 3);
    assert.ok(seen.length >= 1 && seen[0][0] === 'messages');
});

test('title: project conversations still use the owner key (title ignores crypto_scope)', async () => {
    const { openTitle } = require('./agent/conversationTitle');
    const deps = fakeDeps({ tables: { agent_conversations: [{ id: 'c1', user_id: 'u1', title: 'Q3 layoffs', crypto_scope: 'project', project_id: 'p1' }] } });
    const res = await backfillOrg('o1', { surfaces: ['conversationTitle'], deps });
    assert.strictEqual(res.surfaces.conversationTitle.encrypted, 1);
    assert.strictEqual(deps.resolved[0].projectKeyFor, undefined);
    assert.strictEqual(openTitle(deps.updates[0].params[0], 'c1', 'agent', ctxOf(USER_KEY)), 'Q3 layoffs');
    assert.match(deps.updates[0].sql, /title IS NOT DISTINCT FROM/);
});

test('token map: jsonb CAS and the dlpRunner AAD', async () => {
    const map = { '[email_1]': 'a@b.nl' };
    const deps = fakeDeps({ tables: { agent_conversations: [{ id: 'c1', user_id: 'u1', pii_token_map: map }] } });
    const res = await backfillOrg('o1', { surfaces: ['piiTokenMap'], deps });
    assert.strictEqual(res.surfaces.piiTokenMap.encrypted, 1);
    const u = deps.updates[0];
    assert.match(u.sql, /pii_token_map IS NOT DISTINCT FROM \$3::jsonb/);
    assert.strictEqual(decryptField(JSON.parse(u.params[0]), { key: USER_KEY, aad: 'bfpii:v1:c1' }), JSON.stringify(map));
});

test('conversationMeta: agent and direct AADs, project key for shared rows, {} skipped', async () => {
    const { _metaAad } = require('./agent/agentConversations');
    const { _directMetaAad } = require('./agent/directConversations');
    const deps = fakeDeps({
        tables: {
            agent_conversations: [
                { id: 'a1', user_id: 'u1', meta_json: '{"conversationSummary":"x"}', crypto_scope: 'user', project_id: null },
                { id: 'a2', user_id: 'u1', meta_json: '{"conversationSummary":"y"}', crypto_scope: 'project', project_id: 'p1' },
                { id: 'a3', user_id: 'u1', meta_json: '{}', crypto_scope: 'user', project_id: null },
            ],
            direct_conversations: [
                { id: 'd1', user_id: 'u1', meta_json: '{"k":1}', crypto_scope: 'user', project_id: null },
            ],
        },
    });
    const res = await backfillOrg('o1', { surfaces: ['conversationMeta'], deps });
    assert.deepStrictEqual(res.surfaces.conversationMeta, { encrypted: 3, skipped: 1, noKey: 0, failed: 0 });
    const by = Object.fromEntries(deps.updates.map(u => [u.params[1], u.params[0]]));
    assert.strictEqual(decryptField(by.a1, { key: conversationKey(USER_KEY, 'a1'), aad: _metaAad('a1') }), '{"conversationSummary":"x"}');
    assert.strictEqual(decryptField(by.a2, { key: conversationKey(PROJECT_KEY, 'a2'), aad: _metaAad('a2') }), '{"conversationSummary":"y"}');
    assert.strictEqual(decryptField(by.d1, { key: conversationKey(USER_KEY, 'd1'), aad: _directMetaAad('d1') }), '{"k":1}');
});

test('notebookMessages: readable by the runtime decoder, message_count untouched', async () => {
    const { tryDecryptMessages } = require('./agent/messageEncryption');
    const plain = '[{"role":"user","content":"hi"}]';
    const deps = fakeDeps({ tables: { notebook_conversations: [
        { id: 'n1', user_id: 'u1', messages_json: plain },
        { id: 'n2', user_id: 'u1', messages_json: '[]' },
        { id: 'n3', user_id: 'u1', messages_json: '{"_encrypted":"v2","iv":"","authTag":"","data":""}' },
    ] } });
    const res = await backfillOrg('o1', { surfaces: ['notebookMessages'], deps });
    assert.deepStrictEqual(res.surfaces.notebookMessages, { encrypted: 1, skipped: 2, noKey: 0, failed: 0 });
    const u = deps.updates[0];
    assert.doesNotMatch(u.sql, /message_count/);
    assert.deepStrictEqual(tryDecryptMessages(u.params[0], USER_KEY.toString('base64'), 'n1', 'u1'), { ok: true, json: plain });
});

test('transcripts: columns and previews sealed via transcriptCrypto, jsonb CAS', async () => {
    const tc = require('./transcriptCrypto');
    const orgKey = crypto.randomBytes(32);
    const tctx = { key: orgKey, encrypt: true, tier: 'managed' };
    const deps = fakeDeps({ tables: { transcriptions: [{
        id: 't1', full_text: 'we fire Jansen', transcript: 'x', summary: 'sum', segments: [{ t: 1 }],
        speakers: [], attendees: ['Jansen'], chapters: [], full_text_snippet_enc: null, summary_snippet_enc: 'sum',
    }] } });
    deps.resolveTranscriptCrypto = async () => tctx;
    const res = await backfillOrg('o1', { surfaces: ['transcripts'], deps });
    assert.deepStrictEqual(res.surfaces.transcripts, { encrypted: 1, skipped: 0, noKey: 0, failed: 0 });
    const u = deps.updates[0];
    assert.match(u.sql, /segments = \$\d+::jsonb/);
    assert.match(u.sql, /segments IS NOT DISTINCT FROM \$\d+::jsonb/);
    assert.doesNotMatch(u.sql, /speakers =/); // empty array: nothing to protect
    assert.doesNotMatch(u.sql, /action_items/);
    const idx = (col) => u.sql.match(new RegExp(`${col} = \\$(\\d+)`))[1] - 1;
    const full = u.params[idx('full_text')];
    assert.strictEqual(decryptField(full, { key: tc.keyFor(tctx, 't1'), aad: tc.columnAad('t1', 'full_text') }), 'we fire Jansen');
    const snip = u.params[idx('full_text_snippet_enc')];
    assert.strictEqual(tc.readSnippet({ id: 't1', full_text_snippet_enc: snip }, tctx), 'we fire Jansen');
    assert.ok(isEnvelope(u.params[idx('summary_snippet_enc')])); // plaintext preview sealed too
});

test('transcripts: org without a usable key reports noKey for every row', async () => {
    const deps = fakeDeps({ tables: { transcriptions: [{ id: 't1' }, { id: 't2' }] } });
    deps.resolveTranscriptCrypto = async () => ({ key: null, encrypt: false, tier: 'managed' });
    const res = await backfillOrg('o1', { surfaces: ['transcripts'], deps });
    assert.strictEqual(res.surfaces.transcripts.noKey, 2);
    assert.strictEqual(deps.updates.length, 0);
});

// ── legacyBlobs ──────────────────────────────────────────────────────────────

const BLOB = JSON.stringify([{ role: 'user', content: 'secret' }, { role: 'assistant', content: 'ok' }]);
const convRow = (over = {}) => ({
    id: 'c1', user_id: 'u1', crypto_scope: 'user', project_id: null,
    messages_json: BLOB, messages_migrated: false, ...over,
});

/**
 * Stateful fake around fakeDeps: parent rows carry messages_migrated, a fake
 * convMessages stands in for migrateConversationIfNeeded / getMessages.
 */
function legacyDeps({ rows = [], direct = [], tableCount = {}, migrateFails = false, readFails = false, org } = {}) {
    const deps = fakeDeps({ org, tables: { agent_conversations: rows, direct_conversations: direct } });
    const all = [...rows, ...direct];
    const migrateCalls = [];
    deps.migrateCalls = migrateCalls;
    // The real query excludes blank blobs; the fake table lookup does not.
    const baseGetAll = deps.getAll;
    deps.getAll = async (sql, params) => (await baseGetAll(sql, params)).filter(r => r.messages_json !== '[]');
    deps.getOne = async (sql, params) => {
        if (/FROM organizations/.test(sql)) return { id: 'o1', ...(org || ALL_ON) };
        const m = sql.match(/SELECT messages_migrated, messages_json FROM (\w+)/);
        if (m) {
            const r = all.find(x => x.id === params[0]);
            return r ? { messages_migrated: r.messages_migrated, messages_json: r.messages_json } : null;
        }
        return null;
    };
    deps.convMessages = {
        async migrateConversationIfNeeded(id, type, messages, ctx) {
            migrateCalls.push({ id, type, ctx, n: messages.length });
            if (migrateFails) throw new Error('insert failed');
            tableCount[id] = messages.length;
            all.find(x => x.id === id).messages_migrated = true;
            return true;
        },
        async getMessages(id) {
            if (readFails) { const e = new Error('bad tag'); e.code = 'FIELD_DECRYPT_FAILED'; throw e; }
            return Array.from({ length: tableCount[id] || 0 }, (_, i) => ({ role: 'user', content: `m${i}` }));
        },
    };
    const realRun = deps.run;
    deps.run = async (sql, params) => {
        await realRun(sql, params);
        if (/SET messages_json = '\[\]'/.test(sql)) {
            const r = all.find(x => x.id === params[0]);
            if (r && r.messages_migrated && r.messages_json === params[1]) { r.messages_json = '[]'; return { rowCount: 1 }; }
            return { rowCount: 0 };
        }
        return { rowCount: 1 };
    };
    return deps;
}
const legacyStats = (over = {}) => ({ encrypted: 0, skipped: 0, noKey: 0, failed: 0, migrated: 0, reasons: {}, ...over });

test('legacyBlobs: migrates a non-migrated conversation with the runtime function, then blanks the blob', async () => {
    const rows = [convRow()];
    const deps = legacyDeps({ rows });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs, legacyStats({ encrypted: 1, migrated: 1 }));
    assert.strictEqual(deps.migrateCalls.length, 1);
    assert.strictEqual(deps.migrateCalls[0].ctx.key, USER_KEY); // sealed under the owner's key
    assert.strictEqual(deps.migrateCalls[0].type, 'agent');
    assert.strictEqual(rows[0].messages_json, '[]');
    assert.match(deps.updates[0].sql, /messages_json IS NOT DISTINCT FROM/);
    assert.match(deps.updates[0].sql, /messages_migrated = TRUE/);
});

test('legacyBlobs: already migrated conversation with readable messages is only blanked', async () => {
    const rows = [convRow({ messages_migrated: true })];
    const deps = legacyDeps({ rows, tableCount: { c1: 3 } });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs, legacyStats({ encrypted: 1 }));
    assert.strictEqual(deps.migrateCalls.length, 0);
    assert.strictEqual(rows[0].messages_json, '[]');
});

test('legacyBlobs: direct conversations use the direct type', async () => {
    const direct = [convRow({ id: 'd1' })];
    const deps = legacyDeps({ direct });
    await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.strictEqual(deps.migrateCalls[0].type, 'direct');
    assert.strictEqual(direct[0].messages_json, '[]');
});

test('legacyBlobs: failed migration leaves the blob and counts failed', async () => {
    const rows = [convRow()];
    const deps = legacyDeps({ rows, migrateFails: true });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.strictEqual(res.surfaces.legacyBlobs.failed, 1);
    assert.strictEqual(res.surfaces.legacyBlobs.encrypted, 0);
    assert.strictEqual(rows[0].messages_json, BLOB);
    assert.strictEqual(deps.updates.length, 0);
});

test('legacyBlobs: migration that did not flip the flag is skipped with a reason', async () => {
    const rows = [convRow()];
    const deps = legacyDeps({ rows });
    deps.convMessages.migrateConversationIfNeeded = async () => false; // e.g. row-count mismatch
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs, legacyStats({ skipped: 1, reasons: { migration_incomplete: 1 } }));
    assert.strictEqual(rows[0].messages_json, BLOB);
});

test('legacyBlobs: unreadable messages (decrypt failure) never blank', async () => {
    const rows = [convRow({ messages_migrated: true })];
    const deps = legacyDeps({ rows, tableCount: { c1: 2 }, readFails: true });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.strictEqual(res.surfaces.legacyBlobs.failed, 1);
    assert.strictEqual(rows[0].messages_json, BLOB);
    assert.strictEqual(deps.updates.length, 0);
});

test('legacyBlobs: empty or shorter table does not blank', async () => {
    const rows = [convRow({ id: 'c1', messages_migrated: true }), convRow({ id: 'c2', messages_migrated: true })];
    const deps = legacyDeps({ rows, tableCount: { c1: 0, c2: 1 } });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs,
        legacyStats({ skipped: 2, reasons: { table_empty: 1, table_shorter_than_blob: 1 } }));
    assert.strictEqual(deps.updates.length, 0);
});

test('legacyBlobs: dry run reports would-migrate / would-blank and writes nothing', async () => {
    const rows = [convRow({ id: 'c1' }), convRow({ id: 'c2', messages_migrated: true })];
    const deps = legacyDeps({ rows, tableCount: { c2: 2 } });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], dryRun: true, deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs, legacyStats({ encrypted: 2, migrated: 1 }));
    assert.strictEqual(deps.migrateCalls.length, 0);
    assert.strictEqual(deps.updates.length, 0);
    assert.strictEqual(rows[0].messages_json, BLOB);
});

test('legacyBlobs: zk without a session key is noKey and untouched', async () => {
    const rows = [convRow(), convRow({ id: 'c2', messages_migrated: true })];
    const deps = legacyDeps({ rows, org: { encryption_tier: 'zk', encryption_scope: null } });
    deps.resolveCrypto = async () => ({ ...ctxOf(null), backgroundKey: crypto.randomBytes(32), encryptMessages: false, encryptMeta: false });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs, legacyStats({ noKey: 2 }));
    assert.strictEqual(deps.migrateCalls.length, 0);
    assert.strictEqual(deps.updates.length, 0);
});

test('legacyBlobs: a blob that is itself an envelope is never touched (noKey)', async () => {
    const enc = '{"_encrypted":"v2","iv":"00","authTag":"00","data":"00"}';
    const rows = [convRow({ messages_json: enc, messages_migrated: true })];
    const deps = legacyDeps({ rows, tableCount: { c1: 5 } });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs, legacyStats({ noKey: 1 }));
    assert.strictEqual(rows[0].messages_json, enc);
});

test('legacyBlobs: project-scoped rows resolve the project key', async () => {
    const rows = [convRow({ crypto_scope: 'project', project_id: 'p1' })];
    const deps = legacyDeps({ rows });
    await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(deps.resolved[0].projectKeyFor, { projectId: 'p1', orgId: 'o1' });
    assert.strictEqual(deps.migrateCalls[0].ctx.key, PROJECT_KEY);
});

test('legacyBlobs: queries are scoped to the org', async () => {
    const seen = [];
    const rows = [convRow()];
    const deps = legacyDeps({ rows });
    const realGetAll = deps.getAll;
    deps.getAll = async (sql, params) => { seen.push({ sql, params }); return realGetAll(sql, params); };
    await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.ok(seen.length >= 2);
    for (const q of seen) {
        assert.match(q.sql, /u\."organizationId" = \$2/);
        assert.strictEqual(q.params[1], 'o1');
    }
});

test('legacyBlobs: idempotent rerun does nothing', async () => {
    const rows = [convRow()];
    const deps = legacyDeps({ rows });
    await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    const before = deps.updates.length;
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs, legacyStats());
    assert.strictEqual(deps.updates.length, before);
});

test('legacyBlobs: CAS miss on the blank UPDATE counts as skipped', async () => {
    const rows = [convRow({ messages_migrated: true })];
    const deps = legacyDeps({ rows, tableCount: { c1: 2 } });
    const run = deps.run;
    deps.run = async (sql, params) => { await run(sql, params); return { rowCount: 0 }; };
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.strictEqual(res.surfaces.legacyBlobs.skipped, 1);
    assert.strictEqual(res.surfaces.legacyBlobs.encrypted, 0);
});

test('legacyBlobs: blocked when the messages surface had failures; runs last regardless of order', async () => {
    const rows = [convRow({ messages_migrated: true })];
    const deps = legacyDeps({ rows, tableCount: { c1: 2 } });
    deps.resolveCrypto = async (o) => { if (o.projectKeyFor) throw new Error('x'); return ctxOf(USER_KEY); };
    // a project-scoped message row makes `messages` fail
    const gm = deps.getAll;
    deps.getAll = async (sql, params) => (/FROM conversation_messages/.test(sql) && params[0] === ''
        ? [msgRow({ crypto_scope: 'project', project_id: 'p1' })] : gm(sql, params));
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs', 'messages'], deps });
    assert.strictEqual(res.surfaces.messages.failed, 1);
    assert.strictEqual(res.surfaces.legacyBlobs.blocked, 'messages_failed');
    assert.strictEqual(rows[0].messages_json, BLOB);
    assert.deepStrictEqual(Object.keys(res.surfaces), ['messages', 'legacyBlobs']);
});

test('legacyBlobs: not run when the messages surface is switched off in the policy', async () => {
    const rows = [convRow({ messages_migrated: true })];
    const deps = legacyDeps({ rows, tableCount: { c1: 2 }, org: { encryption_tier: 'managed', encryption_scope: { messages: false } } });
    const res = await backfillOrg('o1', { surfaces: ['legacyBlobs'], deps });
    assert.deepStrictEqual(res.surfaces.legacyBlobs, legacyStats());
    assert.strictEqual(rows[0].messages_json, BLOB);
});

// ── piiVault ─────────────────────────────────────────────────────────────────

test('piiVault: seals the value and re-derives the keyed blind index; runtime reads it back', async () => {
    const vault = require('./piiVaultStore');
    const oldIdx = vault.blindIndex('person', 'Jan Jansen', null);
    const deps = fakeDeps({ tables: { pii_vault_entries: [
        { id: 'e1', user_id: 'u1', category: 'person', norm_key: oldIdx, value_enc: 'Jan Jansen' },
    ] } });
    const res = await backfillOrg('o1', { surfaces: ['piiVault'], deps });
    assert.deepStrictEqual(res.surfaces.piiVault.failed, 0);
    assert.strictEqual(res.surfaces.piiVault.encrypted, 1);
    const u = deps.updates[0];
    assert.match(u.sql, /value_enc IS NOT DISTINCT FROM/);
    assert.match(u.sql, /norm_key IS NOT DISTINCT FROM/);
    const keys = vault.vaultKeysFromDek(USER_KEY);
    assert.strictEqual(decryptField(u.params[0], { key: keys.value, aad: vault.vaultAad('u1', 'person') }), 'Jan Jansen');
    assert.strictEqual(u.params[1], vault.blindIndex('person', 'Jan Jansen', keys));
    assert.notStrictEqual(u.params[1], oldIdx);
    assert.strictEqual(u.params[4], oldIdx);
});

test('piiVault: envelopes skipped, dry run writes nothing, no escrow is noKey', async () => {
    const vault = require('./piiVaultStore');
    const keys = vault.vaultKeysFromDek(USER_KEY);
    const sealed = encryptFieldFor(keys, 'u1', 'person', 'A');
    const rows = [
        { id: 'e1', user_id: 'u1', category: 'person', norm_key: 'k', value_enc: sealed },
        { id: 'e2', user_id: 'u1', category: 'person', norm_key: 'k2', value_enc: 'B' },
    ];
    const d1 = fakeDeps({ tables: { pii_vault_entries: rows } });
    const r1 = await backfillOrg('o1', { surfaces: ['piiVault'], dryRun: true, deps: d1 });
    assert.deepStrictEqual(r1.surfaces.piiVault, { encrypted: 1, skipped: 1, noKey: 0, failed: 0 });
    assert.strictEqual(d1.updates.length, 0);

    const d2 = fakeDeps({ tables: { pii_vault_entries: rows }, resolve: () => ({ ...ctxOf(null), backgroundKey: null }) });
    const r2 = await backfillOrg('o1', { surfaces: ['piiVault'], deps: d2 });
    assert.strictEqual(r2.surfaces.piiVault.noKey, 1);
    assert.strictEqual(d2.updates.length, 0);
});

test('piiVault: runs even when no policy surface is individually enabled', async () => {
    const deps = fakeDeps({
        org: { encryption_tier: 'managed', encryption_scope: { messages: false } },
        tables: { pii_vault_entries: [{ id: 'e1', user_id: 'u1', category: 'email', norm_key: 'k', value_enc: 'a@b.nl' }] },
    });
    const res = await backfillOrg('o1', { surfaces: ['piiVault'], deps });
    assert.strictEqual(res.surfaces.piiVault.encrypted, 1);
});

function encryptFieldFor(keys, userId, category, text) {
    const vault = require('./piiVaultStore');
    return require('./lib/fieldEnvelope').encryptField(text, { key: keys.value, aad: vault.vaultAad(userId, category), encrypt: true });
}
