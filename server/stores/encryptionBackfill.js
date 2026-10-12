// @typecheck
/**
 * Retroactive encryption of rows written before a tier / surface was switched on.
 *
 * The policy layer only governs WRITES; reads detect the format of the value in
 * front of them (see stores/encryptionPolicy.js). Switching a tier on therefore
 * protects nothing that already exists. This module walks an organisation's
 * plaintext rows and seals them with the SAME keys, AADs and envelopes the
 * runtime stores use.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *
 *   IDEMPOTENT      a value that is already an envelope is skipped.
 *   RESUMABLE       keyset cursor per table; interrupt and run again.
 *   COMPARE-AND-SET every UPDATE re-states the old column value in its WHERE
 *                   clause. A live write that lands between our SELECT and our
 *                   UPDATE makes the UPDATE match zero rows: the row is counted
 *                   as skipped and picked up (already encrypted by the runtime,
 *                   or still plaintext) by the next run. We never overwrite
 *                   newer data with a stale encrypted copy of older data.
 *   ONE KEY SOURCE  per-user keys come from resolveCrypto, transcripts from
 *                   resolveTranscriptCrypto. Nothing here derives a key.
 *   NO SHARED STATE two orgs may run concurrently; every counter and every key
 *                   cache lives inside one backfillOrg() call.
 *   NEVER DECRYPTS  there is no way to bulk-strip protection through this file.
 *
 * ── Which key opens which column (read from the runtime, not guessed) ────────
 *
 *   conversation_messages.content / .meta_json   conversationKey(ctx.key, conv)
 *       ctx follows the conversation's `crypto_scope`: 'project' => the
 *       PROJECT key (resolveCrypto projectKeyFor), otherwise the owner's key.
 *   agent|direct_conversations.meta_json         conversationKey(ctx.backgroundKey)
 *       same crypto_scope rule (agentConversations._rowCrypto).
 *   agent|direct_conversations.title             owner's backgroundKey ALWAYS,
 *       even for project conversations (title does not follow crypto_scope).
 *   agent|direct_conversations.pii_token_map     owner's backgroundKey ALWAYS
 *       (core/dlp/dlpRunner.js resolves it from the owner).
 *   notebook_conversations.messages_json         ctx.key as base64 (legacy
 *       messageEncryption v2 blob). On `zk` ctx.key is the session DEK, which
 *       a batch job never has, so that surface reports noKey there.
 *   transcriptions.*                             org transcript DEK
 *       (stores/transcriptCrypto.js), on zk as well.
 *
 *   pii_vault_entries.value_enc / .norm_key      vault keys derived from ctx.backgroundKey
 *       (piiVaultStore.vaultKeysFromDek). Not a policy surface: sealed on every
 *       tier whenever the org has encryption on. norm_key is re-derived as the
 *       keyed blind index, otherwise the runtime would never find the old entry.
 *   user_memories.*                              memoryCrypto.memoryKeys(ctx.backgroundKey).enc;
 *       a project-pool row follows the PROJECT key, a personal row the owner's.
 *   agent|direct_conversations.messages_json     LEGACY plaintext copy (see below).
 *
 * ── legacyBlobs: the only destructive step ───────────────────────────────────
 *
 * With encryption on from the start, a conversation's blob is never written once
 * `messages_migrated` is true, and a non-migrated one is migrated into
 * conversation_messages (encrypted) on first read. So for the database to look
 * the same, the old plaintext blob has to go. It is emptied (`'[]'`) ONLY when
 * the same conversation provably has its messages in conversation_messages:
 *   - a non-migrated row is first migrated with the runtime's own
 *     migrateConversationIfNeeded (same ctx, so the rows are sealed);
 *   - the messages are then read back through getMessages with the same ctx and
 *     must number at least as many as the blob held;
 *   - the UPDATE is compare-and-set on the blob and on messages_migrated.
 * A blob that is itself an envelope (written under a session key) is never
 * touched and counts as noKey. Anything uncertain is skipped and counted in
 * stats.reasons. It runs after `messages` and only if that surface had no failures.
 *
 * A shared-project key that cannot be produced counts the row as `failed`; it
 * is never degraded to the owner's key (wrong key = unreadable data).
 */

const log = require('../telemetry/log');
const { SURFACES, IMPLEMENTED_SURFACES, policyFromRow } = require('./encryptionPolicy');
const { encryptField, isEnvelope } = require('./lib/fieldEnvelope');

const LEGACY_BLOBS = 'legacyBlobs';
const PII_VAULT = 'piiVault';

const BATCH = 200;
const TRANSCRIPT_BATCH = 50; // rows carry whole transcripts

function newStats() {
    return { encrypted: 0, skipped: 0, noKey: 0, failed: 0 };
}

/**
 * @typedef {Pick<typeof import('../db'), 'getAll'|'getOne'|'run'> & {
 *   resolveCrypto: typeof import('./agent/messageCrypto').resolveCrypto,
 *   resolveTranscriptCrypto: typeof import('./transcriptCrypto').resolveTranscriptCrypto
 * }} BackfillDependencies
 * @typedef {Partial<BackfillDependencies> & {
 *   batch?: number,
 *   metaAad?: typeof import('./agent/agentConversations')._metaAad,
 *   directMetaAad?: typeof import('./agent/directConversations')._directMetaAad,
 *   vault?: typeof import('./piiVaultStore'),
 *   convMessages?: typeof import('./agent/conversationMessages')
 * }} BackfillOverrides
 */

/** @param {BackfillOverrides} [deps] */
function lazyDeps(deps = {}) {
    const d = { ...deps };
    if (!d.getAll || !d.getOne || !d.run) {
        const db = require('../db');
        d.getAll = d.getAll || db.getAll;
        d.getOne = d.getOne || db.getOne;
        d.run = d.run || db.run;
    }
    if (!d.resolveCrypto) d.resolveCrypto = require('./agent/messageCrypto').resolveCrypto;
    if (!d.resolveTranscriptCrypto) d.resolveTranscriptCrypto = require('./transcriptCrypto').resolveTranscriptCrypto;
    return d;
}

/** Seal a string; throws instead of silently handing back plaintext. */
function seal(plaintext, opts) {
    const out = encryptField(plaintext, { ...opts, encrypt: true });
    if (!isEnvelope(out)) throw new Error('sealing produced a non-envelope value (no usable key)');
    return out;
}

/** Did the compare-and-set UPDATE match a row? */
function matched(res) {
    return !(res && res.rowCount === 0);
}

/**
 * Per-call environment handed to a runner: its own stats, key cache and cursor
 * helper. Nothing is module-level.
 */
function makeEnv(orgId, surface, opts, deps, policy) {
    const stats = newStats();
    if (surface === LEGACY_BLOBS) Object.assign(stats, { migrated: 0, reasons: {} });
    const ctxCache = new Map();
    const env = {
        orgId, surface, stats, deps, policy,
        dryRun: !!opts.dryRun,
        limit: opts.limit ?? Infinity,
        batch: deps.batch || BATCH,
        seen: 0,
        progress() { if (typeof opts.onProgress === 'function') opts.onProgress(surface, { ...stats }); },

        /**
         * Crypto context for a conversation row. `scoped` follows the row's
         * crypto_scope (messages, meta_json); unscoped is always the owner's
         * (title, token map). Resolved once per owner / project per call.
         * Returns { ctx } or { error } (cached too, so a broken project key is
         * not retried for every row).
         */
        async ctxFor(row, scoped) {
            if (!row.user_id) return { ctx: null };
            const isProject = scoped && row.crypto_scope === 'project' && !!row.project_id;
            const k = isProject ? `p:${row.project_id}` : `u:${row.user_id}`;
            if (!ctxCache.has(k)) {
                let entry;
                try {
                    const ctx = await deps.resolveCrypto(isProject
                        ? { userId: row.user_id, orgId, projectKeyFor: { projectId: row.project_id, orgId } }
                        : { userId: row.user_id, orgId });
                    entry = { ctx };
                } catch (err) {
                    log.error(`[EncryptionBackfill] key for ${isProject ? 'project ' + row.project_id : 'user ' + row.user_id} unavailable: ${err.message}`);
                    entry = { error: err };
                }
                ctxCache.set(k, entry);
            }
            return ctxCache.get(k);
        },
    };
    return env;
}

/**
 * Keyset-paged loop with per-row isolation. `fetch(cursor, batch)` returns rows
 * ordered by id; `handle(row)` does the work. Returns false when --limit hit.
 */
async function paged(env, fetch, handle) {
    let cursor = '';
    for (;;) {
        const rows = await fetch(cursor, env.batch);
        if (!rows || rows.length === 0) return true;
        cursor = rows[rows.length - 1].id;
        for (const row of rows) {
            if (++env.seen > env.limit) return false;
            try {
                await handle(row);
            } catch (err) {
                env.stats.failed++;
                log.warn(`[EncryptionBackfill] ${env.surface}: row ${row.id} failed: ${err.message}`);
            }
        }
        env.progress();
        if (rows.length < env.batch) return true;
    }
}

/** Run the UPDATE (unless dry run) and book the outcome. */
async function commit(env, sql, params) {
    if (env.dryRun) { env.stats.encrypted++; return; }
    const res = await env.deps.run(sql, params);
    if (matched(res)) env.stats.encrypted++;
    else env.stats.skipped++; // changed under us: leave it for the next run
}

/** Resolve the ctx or book noKey / failed. Returns ctx or null. */
async function usableCtx(env, row, scoped) {
    const r = await env.ctxFor(row, scoped);
    if (r.error) { env.stats.failed++; return null; }
    if (!r.ctx) { env.stats.noKey++; return null; }
    return r.ctx;
}

// ── Surfaces ────────────────────────────────────────────────────────────────

async function backfillMessages(env) {
    const { conversationKey, messageAad } = require('./agent/messageCrypto');
    await paged(env, (cursor, batch) => env.deps.getAll(`
        SELECT m.id, m.conversation_id, m.conversation_type, m.content, m.meta_json,
               COALESCE(ac.user_id, dc.user_id) AS user_id,
               COALESCE(ac.crypto_scope, dc.crypto_scope) AS crypto_scope,
               COALESCE(ac.project_id, dc.project_id) AS project_id
        FROM conversation_messages m
        LEFT JOIN agent_conversations  ac ON ac.id = m.conversation_id
        LEFT JOIN direct_conversations dc ON dc.id = m.conversation_id
        LEFT JOIN users u ON u.id = COALESCE(ac.user_id, dc.user_id)
        WHERE m.id > $1 AND u."organizationId" = $2
        ORDER BY m.id ASC LIMIT $3
    `, [cursor, env.orgId, batch]), async (row) => {
        const ctx = await usableCtx(env, row, true);
        if (!ctx) return;

        const type = row.conversation_type || 'agent';
        const sets = [];
        const where = [];
        const params = [];
        const add = (col, oldVal, newVal) => {
            params.push(newVal); sets.push(`${col} = $${params.length}`);
            params.push(oldVal); where.push(`${col} IS NOT DISTINCT FROM $${params.length}`);
        };

        // Each field is judged on its own: a row can have encrypted content and
        // plaintext meta if a scope toggle changed mid-life.
        if (ctx.encryptMessages && ctx.key && row.content != null && !isEnvelope(row.content)) {
            add('content', row.content, seal(row.content, {
                key: conversationKey(ctx.key, row.conversation_id),
                aad: messageAad(row.conversation_id, type, 'content'),
            }));
        }
        if (ctx.encryptMeta && ctx.key && row.meta_json != null && !isEnvelope(row.meta_json)) {
            add('meta_json', row.meta_json, seal(row.meta_json, {
                key: conversationKey(ctx.key, row.conversation_id),
                aad: messageAad(row.conversation_id, type, 'meta'),
            }));
        }
        if (sets.length === 0) { env.stats.skipped++; return; }

        params.push(row.id);
        await commit(env,
            `UPDATE conversation_messages SET ${sets.join(', ')} WHERE id = $${params.length} AND ${where.join(' AND ')}`,
            params);
    });
}

const CONV_TABLES = [['agent_conversations', 'agent'], ['direct_conversations', 'direct']];

async function backfillTitles(env) {
    const { sealTitle } = require('./agent/conversationTitle');
    for (const [table, type] of CONV_TABLES) {
        const done = await paged(env, (cursor, batch) => env.deps.getAll(`
            SELECT c.id, c.user_id, c.title FROM ${table} c
            JOIN users u ON u.id = c.user_id
            WHERE c.id > $1 AND u."organizationId" = $2 AND c.title IS NOT NULL
            ORDER BY c.id ASC LIMIT $3
        `, [cursor, env.orgId, batch]), async (row) => {
            if (isEnvelope(row.title)) { env.stats.skipped++; return; }
            const ctx = await usableCtx(env, row, false);
            if (!ctx) return;
            if (!ctx.encryptTitle) { env.stats.skipped++; return; }
            const sealed = sealTitle(row.title, row.id, type, ctx);
            if (!isEnvelope(sealed)) { env.stats.noKey++; return; }
            await commit(env, `UPDATE ${table} SET title = $1 WHERE id = $2 AND title IS NOT DISTINCT FROM $3`,
                [sealed, row.id, row.title]);
        });
        if (!done) return;
    }
}

async function backfillTokenMaps(env) {
    for (const [table] of CONV_TABLES) {
        const done = await paged(env, (cursor, batch) => env.deps.getAll(`
            SELECT c.id, c.user_id, c.pii_token_map FROM ${table} c
            JOIN users u ON u.id = c.user_id
            WHERE c.id > $1 AND u."organizationId" = $2 AND c.pii_token_map IS NOT NULL
            ORDER BY c.id ASC LIMIT $3
        `, [cursor, env.orgId, batch]), async (row) => {
            if (isEnvelope(row.pii_token_map)) { env.stats.skipped++; return; }
            const ctx = await usableCtx(env, row, false);
            if (!ctx) return;
            // Written by the DLP runner, which never has a session.
            if (!ctx.backgroundKey) { env.stats.noKey++; return; }
            const oldJson = JSON.stringify(row.pii_token_map);
            const sealed = encryptField(oldJson, {
                key: ctx.backgroundKey, aad: `bfpii:v1:${row.id}`, encrypt: true, asObject: true,
            });
            if (!isEnvelope(sealed)) throw new Error('sealing produced a non-envelope value');
            await commit(env,
                `UPDATE ${table} SET pii_token_map = $1::jsonb WHERE id = $2 AND pii_token_map IS NOT DISTINCT FROM $3::jsonb`,
                [JSON.stringify(sealed), row.id, oldJson]);
        });
        if (!done) return;
    }
}

async function backfillConversationMeta(env) {
    const { conversationKey } = require('./agent/messageCrypto');
    const aadFor = {
        agent: env.deps.metaAad || require('./agent/agentConversations')._metaAad,
        direct: env.deps.directMetaAad || require('./agent/directConversations')._directMetaAad,
    };
    for (const [table, type] of CONV_TABLES) {
        const done = await paged(env, (cursor, batch) => env.deps.getAll(`
            SELECT c.id, c.user_id, c.meta_json, c.crypto_scope, c.project_id FROM ${table} c
            JOIN users u ON u.id = c.user_id
            WHERE c.id > $1 AND u."organizationId" = $2 AND c.meta_json IS NOT NULL
            ORDER BY c.id ASC LIMIT $3
        `, [cursor, env.orgId, batch]), async (row) => {
            const raw = row.meta_json;
            // '{}' is the column default: nothing to protect.
            if (typeof raw !== 'string' || raw === '' || raw === '{}' || isEnvelope(raw)) { env.stats.skipped++; return; }
            const ctx = await usableCtx(env, row, true);
            if (!ctx) return;
            if (!ctx.encryptConversationMeta || !ctx.backgroundKey) { env.stats.skipped++; return; }
            const sealed = seal(raw, {
                key: conversationKey(ctx.backgroundKey, row.id),
                aad: aadFor[type](row.id),
            });
            await commit(env, `UPDATE ${table} SET meta_json = $1 WHERE id = $2 AND meta_json IS NOT DISTINCT FROM $3`,
                [sealed, row.id, raw]);
        });
        if (!done) return;
    }
}

async function backfillNotebookMessages(env) {
    const { encryptMessages } = require('./agent/messageEncryption');
    await paged(env, (cursor, batch) => env.deps.getAll(`
        SELECT n.id, n.user_id, n.messages_json FROM notebook_conversations n
        JOIN users u ON u.id = n.user_id
        WHERE n.id > $1 AND u."organizationId" = $2
        ORDER BY n.id ASC LIMIT $3
    `, [cursor, env.orgId, batch]), async (row) => {
        const raw = row.messages_json;
        if (typeof raw !== 'string' || raw === '' || raw === '[]') { env.stats.skipped++; return; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { throw new Error('messages_json is not valid JSON'); }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed._encrypted) { env.stats.skipped++; return; }

        const ctx = await usableCtx(env, row, false);
        if (!ctx) return;
        if (!ctx.encryptNotebookMessages) { env.stats.skipped++; return; }
        // notebookConversationStore._keys: write key = escrow || session, where
        // "escrow" is ctx.key. On zk without a session that is null.
        if (!ctx.key) { env.stats.noKey++; return; }
        const sealed = encryptMessages(raw, ctx.key.toString('base64'), row.id, row.user_id);
        if (sealed === raw) throw new Error('notebook encryption fell back to plaintext');
        // message_count is a separate plaintext column and is left untouched.
        await commit(env,
            'UPDATE notebook_conversations SET messages_json = $1 WHERE id = $2 AND messages_json IS NOT DISTINCT FROM $3',
            [sealed, row.id, raw]);
    });
}

async function backfillTranscripts(env) {
    const tc = require('./transcriptCrypto');
    const tctx = await env.deps.resolveTranscriptCrypto(env.orgId);
    if (!tctx || !tctx.encrypt || !tctx.key) {
        const r = await env.deps.getOne('SELECT COUNT(*)::int AS n FROM transcriptions WHERE organization_id = $1', [env.orgId]);
        env.stats.noKey += (r && r.n) || 0;
        return;
    }

    await paged({ ...env, batch: env.deps.batch || TRANSCRIPT_BATCH, stats: env.stats }, (cursor, batch) => env.deps.getAll(`
        SELECT id, full_text, transcript, summary, segments, speakers, attendees, chapters,
               full_text_snippet_enc, summary_snippet_enc
        FROM transcriptions
        WHERE id > $1 AND organization_id = $2
        ORDER BY id ASC LIMIT $3
    `, [cursor, env.orgId, batch]), async (row) => {
        // Serialise exactly as createTranscription does, then let encryptRow do
        // the sealing so format and AAD are the runtime's.
        /** @type {Record<string, string>} */
        const values = {};
        for (const col of tc.TEXT_COLUMNS) {
            const v = row[col];
            if (typeof v === 'string' && v !== '' && !isEnvelope(v)) values[col] = v;
        }
        for (const col of tc.JSON_COLUMNS) {
            const v = row[col];
            if (v === null || v === undefined || isEnvelope(v)) continue;
            if (Array.isArray(v) && v.length === 0) continue;
            values[col] = JSON.stringify(v);
        }

        // Previews: derived columns, encrypted. A preview written while the
        // surface was off is stored as PLAINTEXT in the same column, so it has
        // to be sealed too, even when the main column already is.
        const snippets = {};
        const plainFull = values.full_text
            ?? (typeof row.full_text_snippet_enc === 'string' && !isEnvelope(row.full_text_snippet_enc) ? row.full_text_snippet_enc : '');
        if (plainFull && !isEnvelope(row.full_text_snippet_enc || '')) {
            snippets.full_text_snippet_enc = tc.buildSnippet(row.id, plainFull, tctx);
        }
        const plainSummary = values.summary
            ?? (typeof row.summary_snippet_enc === 'string' && !isEnvelope(row.summary_snippet_enc) ? row.summary_snippet_enc : '');
        if (plainSummary && !isEnvelope(row.summary_snippet_enc || '')) {
            snippets.summary_snippet_enc = tc.buildSummarySnippet(row.id, plainSummary, tctx);
        }

        const sealedCols = tc.encryptRow(row.id, values, tctx);
        const writes = { ...sealedCols, ...snippets };
        const cols = Object.keys(writes);
        if (cols.length === 0) { env.stats.skipped++; return; }
        for (const c of cols) {
            if (writes[c] != null && !isEnvelope(writes[c])) throw new Error(`column ${c} was not sealed`);
        }

        const sets = [];
        const where = [];
        const params = [];
        for (const c of cols) {
            const isJson = tc.JSON_COLUMNS.includes(c);
            const cast = isJson ? '::jsonb' : '';
            params.push(writes[c]); sets.push(`${c} = $${params.length}${cast}`);
            const old = isJson ? JSON.stringify(row[c]) : row[c];
            params.push(old ?? null); where.push(`${c} IS NOT DISTINCT FROM $${params.length}${cast}`);
        }
        params.push(row.id);
        await commit(env,
            `UPDATE transcriptions SET ${sets.join(', ')} WHERE id = $${params.length} AND ${where.join(' AND ')}`,
            params);
    });
}

async function backfillPiiVault(env) {
    const vault = env.deps.vault || require('./piiVaultStore');
    await paged(env, (cursor, batch) => env.deps.getAll(`
        SELECT e.id, e.user_id, e.category, e.norm_key, e.value_enc FROM pii_vault_entries e
        JOIN users u ON u.id = e.user_id
        WHERE e.id > $1 AND u."organizationId" = $2
        ORDER BY e.id ASC LIMIT $3
    `, [cursor, env.orgId, batch]), async (row) => {
        if (typeof row.value_enc !== 'string' || row.value_enc === '' || isEnvelope(row.value_enc)) { env.stats.skipped++; return; }
        const ctx = await usableCtx(env, row, false);
        if (!ctx) return;
        // The vault uses the escrow key, which is backgroundKey on both tiers.
        if (!ctx.backgroundKey) { env.stats.noKey++; return; }
        const keys = vault.vaultKeysFromDek(ctx.backgroundKey);
        const sealed = seal(row.value_enc, { key: keys.value, aad: vault.vaultAad(row.user_id, row.category) });
        // The plaintext-era index is an unkeyed digest; the runtime looks values
        // up by the keyed one, so the entry would otherwise be unfindable.
        const normKey = vault.blindIndex(row.category, row.value_enc, keys);
        await commit(env,
            `UPDATE pii_vault_entries SET value_enc = $1, norm_key = $2
             WHERE id = $3 AND value_enc IS NOT DISTINCT FROM $4 AND norm_key IS NOT DISTINCT FROM $5`,
            [sealed, normKey, row.id, row.value_enc, row.norm_key]);
    });
}

async function backfillLegacyBlobs(env) {
    const cm = env.deps.convMessages || require('./agent/conversationMessages');
    const cannot = (reason) => {
        env.stats.skipped++;
        env.stats.reasons[reason] = (env.stats.reasons[reason] || 0) + 1;
    };
    const readBlob = (raw) => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return { reason: 'blob_unparseable' }; }
        if (Array.isArray(parsed)) return { messages: parsed };
        if (parsed && typeof parsed === 'object' && parsed._encrypted) return { encrypted: true };
        return { reason: 'blob_unparseable' };
    };

    for (const [table, type] of CONV_TABLES) {
        const done = await paged(env, (cursor, batch) => env.deps.getAll(`
            SELECT c.id, c.user_id, c.crypto_scope, c.project_id, c.messages_json, c.messages_migrated
            FROM ${table} c
            JOIN users u ON u.id = c.user_id
            WHERE c.id > $1 AND u."organizationId" = $2
              AND c.messages_json IS NOT NULL AND c.messages_json NOT IN ('', '[]')
            ORDER BY c.id ASC LIMIT $3
        `, [cursor, env.orgId, batch]), async (row) => {
            const ctx = await usableCtx(env, row, true);
            if (!ctx) return;
            // Without the content key the table cannot be read back, so nothing
            // can be proven (zk without a session, or messages not sealed).
            if (!ctx.encryptMessages || !ctx.key) { env.stats.noKey++; return; }

            let blob = row.messages_json;
            let info = readBlob(blob);
            if (info.encrypted) { env.stats.noKey++; return; }
            if (info.reason) { cannot(info.reason); return; }
            if (info.messages.length === 0) { cannot('blob_empty'); return; }

            if (!row.messages_migrated) {
                if (env.dryRun) { env.stats.migrated++; env.stats.encrypted++; return; } // would migrate, then blank
                const did = await cm.migrateConversationIfNeeded(row.id, type, info.messages, ctx);
                if (did) env.stats.migrated++;
                const fresh = await env.deps.getOne(`SELECT messages_migrated, messages_json FROM ${table} WHERE id = $1`, [row.id]);
                if (!fresh || !fresh.messages_migrated) { cannot('migration_incomplete'); return; }
                blob = fresh.messages_json;
                if (blob === '[]' || blob === '' || blob == null) { env.stats.skipped++; return; }
                info = readBlob(blob);
                if (info.encrypted) { env.stats.noKey++; return; }
                if (info.reason) { cannot(info.reason); return; }
            }

            // Read-back with the runtime's own reader and key. A decrypt failure
            // throws and is counted as failed; the blob stays.
            const msgs = await cm.getMessages(row.id, ctx);
            if (!Array.isArray(msgs) || msgs.length === 0) { cannot('table_empty'); return; }
            if (msgs.length < info.messages.length) { cannot('table_shorter_than_blob'); return; }

            await commit(env,
                `UPDATE ${table} SET messages_json = '[]'
                 WHERE id = $1 AND messages_migrated = TRUE AND messages_json IS NOT DISTINCT FROM $2`,
                [row.id, blob]);
        });
        if (!done) return;
    }
}

/**
 * user_memories: seal the text columns and the embedding of rows written while
 * the surface was off, with the keys the runtime store uses (stores/memoryCrypto.js).
 * Every status is covered (superseded history is still the person's data);
 * schedule_coverage bookkeeping is not a memory and stays clear. A row's key_hash
 * is re-derived as the keyed HMAC, otherwise the plain digest of a now-sealed
 * subject would stay in the table. Lookups accept both forms meanwhile.
 */
async function backfillMemories(env) {
    const mc = require('./memoryCrypto');
    await paged(env, (cursor, batch) => env.deps.getAll(`
        SELECT m.* FROM user_memories m
        JOIN users u ON u.id = m.user_id
        WHERE m.id > $1 AND u."organizationId" = $2 AND m.type <> 'schedule_coverage'
        ORDER BY m.id ASC LIMIT $3
    `, [cursor, env.orgId, batch]), async (row) => {
        const todo = mc.SEALED_FIELDS.filter(f => row[f] != null && !isEnvelope(row[f]));
        const sealEmb = row.embedding != null && !row.embedding_enc;
        if (todo.length === 0 && !sealEmb) { env.stats.skipped++; return; }

        // Project pool rows follow the project key, personal rows the owner's.
        const ctx = await usableCtx(env, { ...row, crypto_scope: row.project_id ? 'project' : 'user' }, true);
        if (!ctx) return;
        if (!ctx.encryptMemories) { env.stats.skipped++; return; }
        if (!ctx.backgroundKey) { env.stats.noKey++; return; }
        const wctx = { encrypt: true, keys: mc.memoryKeys(ctx.backgroundKey) };

        const sets = [];
        const where = [];
        const params = [];
        const add = (col, oldVal, newVal, cast = '') => {
            params.push(newVal); sets.push(`${col} = $${params.length}${cast}`);
            params.push(oldVal); where.push(`${col} IS NOT DISTINCT FROM $${params.length}${cast}`);
        };
        const fields = {};
        for (const f of todo) fields[f] = row[f];
        const sealed = mc.sealFields(row.id, fields, wctx);
        for (const f of todo) {
            if (!isEnvelope(sealed[f])) throw new Error('sealing produced a non-envelope value');
            add(f, row[f], sealed[f]);
        }
        if (sealEmb) {
            const vec = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
            const c = mc.sealEmbedding(row.id, vec, wctx);
            add('embedding', JSON.stringify(row.embedding), null, '::jsonb');
            params.push(c.embedding_enc); sets.push(`embedding_enc = $${params.length}`);
        }
        // The typed pgvector columns hold the same vector in the clear
        // (stores/memoryIndex.js); a sealed row keeps none. The tsvector is
        // emptied by its trigger when `content` is rewritten above.
        for (const col of require('./memoryIndex').vectorColumnNames()) sets.push(`"${col}" = NULL`);
        if (row.subject && row.attribute) {
            // The plaintext subject/attribute are in hand only while they are not yet sealed.
            const plainSubject = isEnvelope(row.subject) ? null : row.subject;
            const plainAttribute = isEnvelope(row.attribute) ? null : row.attribute;
            if (plainSubject && plainAttribute) {
                params.push(mc.keyHashForWrite({ type: row.type, subject: plainSubject, attribute: plainAttribute }, wctx));
                sets.push(`key_hash = $${params.length}`);
            }
        }
        params.push(row.id);
        await commit(env,
            `UPDATE user_memories SET ${sets.join(', ')} WHERE id = $${params.length}${where.length ? ' AND ' + where.join(' AND ') : ''}`,
            params);
    });
}

/** surface name -> runner(env). */
const RUNNERS = {
    [SURFACES.MESSAGES]: backfillMessages,
    [SURFACES.CONVERSATION_TITLE]: backfillTitles,
    [SURFACES.PII_TOKEN_MAP]: backfillTokenMaps,
    [SURFACES.CONVERSATION_META]: backfillConversationMeta,
    [SURFACES.NOTEBOOK_MESSAGES]: backfillNotebookMessages,
    [SURFACES.TRANSCRIPTS]: backfillTranscripts,
    [SURFACES.MEMORIES]: backfillMemories,
    [PII_VAULT]: backfillPiiVault,
    // Must stay last: it needs the `messages` surface to have run first.
    [LEGACY_BLOBS]: backfillLegacyBlobs,
};

const BACKFILL_SURFACES = Object.freeze(Object.keys(RUNNERS));

/**
 * Policy scope flags that must be on for a runner to do anything. The messages
 * runner covers two policy surfaces (content and meta).
 */
const POLICY_SURFACES = {
    [SURFACES.MESSAGES]: [SURFACES.MESSAGES, SURFACES.MESSAGE_META],
    [LEGACY_BLOBS]: [SURFACES.MESSAGES],
};

/** Not policy surfaces: sealed whenever the org has encryption on (see piiVaultStore). */
const ALWAYS_ON_SURFACES = [PII_VAULT];

function surfaceEnabled(policy, surface) {
    if (ALWAYS_ON_SURFACES.includes(surface)) return true;
    return (POLICY_SURFACES[surface] || [surface])
        .some(s => IMPLEMENTED_SURFACES.includes(s) && policy.scope[s] === true);
}

/**
 * Encrypt one organisation's existing plaintext rows.
 *
 * @param {string} orgId
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {string[]|null} [opts.surfaces=null]   null = every surface in BACKFILL_SURFACES
 * @param {number} [opts.limit=Infinity]         rows examined per surface
 * @param {((surface: string, stats: object) => void)|null} [opts.onProgress=null]
 * @param {BackfillOverrides} [opts.deps]        test seam (db fns, resolvers, batch size)
 * @returns {Promise<{ orgId: string, tier: string, notFound?: boolean,
 *   surfaces: Record<string, {encrypted: number, skipped: number, noKey: number, failed: number,
 *   migrated?: number, reasons?: Record<string, number>, blocked?: string}> }>}
 */
async function backfillOrg(orgId, { dryRun = false, surfaces = null, limit = Infinity, onProgress = null, deps = {} } = {}) {
    const d = lazyDeps(deps);
    const org = await d.getOne('SELECT id, encryption_tier, encryption_scope FROM organizations WHERE id = $1', [orgId]);
    if (!org) return { orgId, tier: 'none', notFound: true, surfaces: {} };

    const policy = policyFromRow(org);
    const result = { orgId, tier: policy.tier, surfaces: {} };
    if (!policy.enabled) return result;

    // legacyBlobs always last, whatever order the caller gave: it relies on the
    // messages surface having sealed everything it could first.
    const wanted = [...(surfaces || BACKFILL_SURFACES)].sort((a, b) => Number(a === LEGACY_BLOBS) - Number(b === LEGACY_BLOBS));
    for (const surface of wanted) {
        const runner = RUNNERS[surface];
        if (!runner) continue; // CLI reports unknown names
        const env = makeEnv(orgId, surface, { dryRun, limit, onProgress }, d, policy);
        const messagesRan = result.surfaces[SURFACES.MESSAGES];
        if (surface === LEGACY_BLOBS && messagesRan && messagesRan.failed > 0) {
            // Blanking is destructive: not while the sealing step had failures.
            env.stats.blocked = 'messages_failed';
        } else if (surfaceEnabled(policy, surface)) {
            try {
                await runner(env);
            } catch (err) {
                // A query-level failure ends this surface, not the others.
                env.stats.failed++;
                log.error(`[EncryptionBackfill] ${surface} for org ${orgId} aborted: ${err.message}`);
            }
        }
        result.surfaces[surface] = env.stats;
    }
    return result;
}

module.exports = { BACKFILL_SURFACES, RUNNERS, backfillOrg };
