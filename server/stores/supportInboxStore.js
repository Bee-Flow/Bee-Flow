// @typecheck
/**
 * Support Inbox Store — connected support mailboxes for the tenant Support
 * studio (Studio → Support). One row per connected mailbox (support@, sales@…),
 * org-scoped and team-shared. Holds the per-inbox AI config (agent, KBs, reply
 * mode, threshold, signature) and the incremental-sync cursors.
 *
 * It reuses the
 * same proven primitives — AES-256-GCM token encryption, row-level sync locks,
 * Gmail historyId / Graph deltaLink cursors — but produces SUPPORT TICKETS
 * (support_threads / support_messages), not KB documents.
 *
 * Tenancy: `organization_id` is NOT NULL. Tenant inboxes are always non-null;
 * Bee Flow's own company support inbox lives in support_threads with
 * inbox_id IS NULL and is never represented here.
 */

const { pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');
const log = require('../telemetry/log');

const ENCRYPTION_KEY_SOURCE = process.env.SESSION_SECRET;
if (!ENCRYPTION_KEY_SOURCE || ENCRYPTION_KEY_SOURCE.length < 32) {
    throw new Error('[SupportInboxStore] SESSION_SECRET must be set (≥32 chars) — it derives the AES-256 key for mailbox OAuth-token encryption. See .env.example.');
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS support_inboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('gmail','outlook')),
    email_address TEXT,                              -- set at OAuth callback
    display_name TEXT DEFAULT '',
    encrypted_tokens TEXT,                           -- AES-256-GCM blob {accessToken,refreshToken,...}
    auth_method TEXT DEFAULT 'oauth',
    provider_config JSONB DEFAULT '{}'::jsonb,       -- e.g. { sharedMailbox, tenantId }
    default_agent_id TEXT,                           -- agentStore agent used to draft replies
    kb_ids JSONB DEFAULT '[]'::jsonb,                -- KB UUIDs the agent searches
    reply_mode TEXT NOT NULL DEFAULT 'draft'
        CHECK (reply_mode IN ('draft','auto_confident','autonomous')),
    autoresolve_threshold NUMERIC(3,2) DEFAULT 0.78,
    tools_enabled BOOLEAN DEFAULT false,             -- expose read-only SUPPORT_TOOLS to the agent loop
    signature TEXT,                                  -- appended to outbound replies (HTML)
    folder_filter JSONB DEFAULT '["INBOX"]'::jsonb,
    sync_interval_minutes INT DEFAULT 2,
    gmail_history_id TEXT,
    graph_delta_link TEXT,
    sync_after TIMESTAMPTZ,                           -- bootstrap anchor: ignore mail before this
    sync_status TEXT DEFAULT 'idle' CHECK (sync_status IN ('idle','syncing','error')),
    sync_error TEXT,
    sync_locked_until TIMESTAMPTZ,
    last_sync_at TIMESTAMPTZ,
    active BOOLEAN DEFAULT false,                     -- true after OAuth completes
    kb_ingest_enabled BOOLEAN DEFAULT false,          -- distil resolved tickets into a KB
    kb_ingest_kb_id UUID,                             -- target knowledge base for ingestion
    kb_ingest_routine_id UUID,                        -- the auto-provisioned routine (one per inbox)
    shared_groups JSONB NOT NULL DEFAULT '[]'::jsonb, -- org groups allowed to work this inbox; [] = open to all org support staff
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_inboxes_org ON support_inboxes(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_inbox_org_addr
    ON support_inboxes(organization_id, lower(email_address)) WHERE email_address IS NOT NULL;
`;

const initDB = makeStoreInit('SupportInboxStore', _initDB);

async function _initDB() {
    try {
        await pool.query(INIT_SQL);
        // Additive migrations for existing installs (CREATE TABLE IF NOT EXISTS
        // won't add columns to a pre-existing table). Tolerate failure.
        for (const sql of [
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS kb_ingest_enabled BOOLEAN DEFAULT false`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS kb_ingest_kb_id UUID`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS kb_ingest_routine_id UUID`,
            // Per-inbox enabled-tools set (supersedes the single tools_enabled
            // checkbox): tokens like 'builtin:read','builtin:action','integration:<id>'.
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS enabled_tool_ids JSONB DEFAULT '[]'::jsonb`,
            // Designated operator: the org member whose connected integrations the
            // support AI may use. Integration tool calls execute under this identity
            // (their OAuth tokens / per-user keys / org). NULL = no integration tools.
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS operator_user_id TEXT DEFAULT NULL`,
            // Non-support classification (opt-in): tag + route inbound that isn't
            // a genuine customer request out of the default inbox.
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS classify_non_support_enabled BOOLEAN DEFAULT false`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS classify_sensitivity NUMERIC(3,2) DEFAULT 0.85`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS classify_suppress_autoreply BOOLEAN DEFAULT true`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS known_good_senders JSONB DEFAULT '[]'::jsonb`,
            // Historical response-time scan (aggregate-only, on-demand). Only the
            // scan engine writes these (via dedicated setters — kept off UPDATABLE).
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS scan_status TEXT DEFAULT 'idle'`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS scan_progress JSONB DEFAULT '{}'::jsonb`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS scan_result JSONB`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS scan_after TIMESTAMPTZ`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS scan_locked_until TIMESTAMPTZ`,
            // Per-inbox group access control. [] = open to any org member with the
            // support_inbox permission (preserves prior behaviour); a non-empty
            // array restricts the inbox to members of those org groups.
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS shared_groups JSONB NOT NULL DEFAULT '[]'::jsonb`,
            // Add the CHECK separately so re-runs on an existing column are safe.
            `DO $$ BEGIN
               IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_inboxes_scan_status_chk') THEN
                 ALTER TABLE support_inboxes ADD CONSTRAINT support_inboxes_scan_status_chk
                   CHECK (scan_status IN ('idle','queued','running','done','error'));
               END IF;
             END $$;`,
        ]) {
            await pool.query(sql).catch(e => log.warn('[SupportInboxStore] migration skipped:', e.message));
        }
        log.info('[SupportInboxStore] PostgreSQL initialized');
    } catch (err) {
        log.error('[SupportInboxStore] Init error:', err.message);
        throw err;
    }
}

// ── Token encryption (AES-256-GCM, per-store salt) ──────────────────────────
// One audited cipher (utils/secretBox); the scrypt key is derived once and
// cached, not on every encrypt/decrypt. The DISTINCT salt is deliberate: a
// SESSION_SECRET compromise scoped to one feature's ciphertext must not
// trivially decrypt the other's — never share this salt with another store.
const { createSecretBox } = require('../utils/secretBox');
const _tokenBox = createSecretBox(ENCRYPTION_KEY_SOURCE, 'support-inbox-salt', { logPrefix: '[SupportInboxStore]' });
const encryptTokens = (tokens) => _tokenBox.encrypt(tokens);
const decryptTokens = (encryptedStr) => _tokenBox.decrypt(encryptedStr);

// Columns safe to return to the client (never the encrypted token blob).
const PUBLIC_COLS = `id, organization_id, created_by, provider, email_address, display_name,
    auth_method, provider_config, default_agent_id, kb_ids, reply_mode, autoresolve_threshold,
    tools_enabled, enabled_tool_ids, operator_user_id, signature, folder_filter, sync_interval_minutes, sync_status, sync_error,
    last_sync_at, active, kb_ingest_enabled, kb_ingest_kb_id, kb_ingest_routine_id,
    classify_non_support_enabled, classify_sensitivity, classify_suppress_autoreply, known_good_senders,
    scan_status, scan_progress, scan_result, scan_after, shared_groups,
    created_at, updated_at,
    (encrypted_tokens IS NOT NULL) AS connected`;

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a shell inbox row (pre-OAuth). active stays false until the OAuth
 * callback stores tokens + the mailbox address.
 */
async function createInbox({
    organizationId, createdBy, provider,
    displayName = '', defaultAgentId = null, kbIds = [],
    replyMode = 'draft', autoresolveThreshold = 0.78, toolsEnabled = false,
    signature = null, folderFilter = ['INBOX'], syncIntervalMinutes = 2,
    providerConfig = {},
}) {
    await initDB();
    if (!organizationId) throw new Error('organizationId required');
    if (!['gmail', 'outlook'].includes(provider)) throw new Error('invalid provider');
    if (!['draft', 'auto_confident', 'autonomous'].includes(replyMode)) throw new Error('invalid replyMode');
    const { rows } = await pool.query(
        `INSERT INTO support_inboxes
            (organization_id, created_by, provider, display_name, default_agent_id, kb_ids,
             reply_mode, autoresolve_threshold, tools_enabled, signature, folder_filter,
             sync_interval_minutes, provider_config)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb)
         RETURNING ${PUBLIC_COLS}`,
        [organizationId, createdBy, provider, displayName, defaultAgentId,
            JSON.stringify(kbIds || []), replyMode, autoresolveThreshold, !!toolsEnabled,
            signature, JSON.stringify(folderFilter || ['INBOX']), syncIntervalMinutes,
            JSON.stringify(providerConfig || {})]
    );
    return rows[0];
}

async function listInboxes(organizationId) {
    await initDB();
    if (!organizationId) return [];
    const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLS} FROM support_inboxes WHERE organization_id = $1 ORDER BY created_at ASC`,
        [organizationId]
    );
    return rows;
}

async function getInbox(id) {
    await initDB();
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLS} FROM support_inboxes WHERE id = $1`, [id]);
    return rows[0] || null;
}

/** Full row incl. decrypted tokens — for the sync engine / mailer ONLY. */
async function getInboxWithTokens(id) {
    await initDB();
    const { rows } = await pool.query(`SELECT * FROM support_inboxes WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    row.tokens = decryptTokens(row.encrypted_tokens);
    delete row.encrypted_tokens;
    return row;
}

const asJsonb = (col) => ({ col, cast: 'jsonb', transform: (v) => JSON.stringify(v) });

// The client-writable allowlist. Every scan_* column is deliberately absent —
// that state is engine-owned.
const UPDATABLE = {
    display_name: 'display_name',
    default_agent_id: 'default_agent_id',
    reply_mode: 'reply_mode',
    autoresolve_threshold: 'autoresolve_threshold',
    tools_enabled: 'tools_enabled',
    enabled_tool_ids: asJsonb('enabled_tool_ids'),
    operator_user_id: 'operator_user_id',
    signature: 'signature',
    folder_filter: asJsonb('folder_filter'),
    sync_interval_minutes: 'sync_interval_minutes',
    active: 'active',
    provider_config: asJsonb('provider_config'),
    email_address: 'email_address',
    classify_non_support_enabled: 'classify_non_support_enabled',
    classify_sensitivity: 'classify_sensitivity',
    classify_suppress_autoreply: 'classify_suppress_autoreply',
    known_good_senders: asJsonb('known_good_senders'),
    kb_ids: asJsonb('kb_ids'),
};

async function updateInbox(id, updates = {}, organizationId = null) {
    await initDB();
    const kbIds = (updates.kb_ids !== undefined || updates.kbIds !== undefined)
        ? (updates.kb_ids ?? updates.kbIds ?? [])   // an explicit null means "no bases", not a NULL column
        : undefined;
    const built = buildUpdate({
        table: 'support_inboxes',
        updates: { ...updates, kb_ids: kbIds },
        columnMap: UPDATABLE,
        extraSet: ['updated_at = now()'],
        where: [{ col: 'id', value: id }, ...(organizationId ? [{ col: 'organization_id', value: organizationId }] : [])],
        returning: PUBLIC_COLS,
    });
    if (!built) return getInbox(id);
    const { rows } = await pool.query(built.sql, built.params);
    return rows[0] || null;
}

/**
 * Set the KB-ingestion config (enable flag, target KB, provisioned routine id)
 * for an inbox. Kept off the public PATCH allowlist so clients can only change
 * it via the dedicated /kb-automation endpoint (which provisions the routine).
 * Only provided keys are written; pass null to clear kbId / routineId.
 */
const KB_AUTOMATION_COLUMNS = {
    enabled: { col: 'kb_ingest_enabled', transform: (v) => !!v },
    kbId: 'kb_ingest_kb_id',
    routineId: 'kb_ingest_routine_id',
};

/**
 * @param id
 * @param {{ enabled?: boolean, kbId?: string, routineId?: string }} [opts]
 * @param [organizationId]
 */
async function setKbAutomation(id, { enabled, kbId, routineId } = {}, organizationId = null) {
    await initDB();
    const built = buildUpdate({
        table: 'support_inboxes',
        updates: { enabled, kbId, routineId },
        columnMap: KB_AUTOMATION_COLUMNS,
        extraSet: ['updated_at = now()'],
        where: [{ col: 'id', value: id }, ...(organizationId ? [{ col: 'organization_id', value: organizationId }] : [])],
        returning: PUBLIC_COLS,
    });
    if (!built) return getInbox(id);
    const { rows } = await pool.query(built.sql, built.params);
    return rows[0] || null;
}

/**
 * Set the per-inbox group access list. Kept off the public PATCH allowlist
 * (UPDATABLE) so a forged `shared_groups` in a normal settings PATCH body is
 * ignored — access can only change via the dedicated /access endpoint, which
 * validates the group ids against the inbox's org first. Pass [] to open the
 * inbox to all org support staff.
 */
async function setSharedGroups(id, sharedGroups = [], organizationId = null) {
    await initDB();
    const clean = Array.from(new Set((Array.isArray(sharedGroups) ? sharedGroups : []).filter(Boolean)));
    const vals = [id, JSON.stringify(clean)];
    let where = `WHERE id = $1`;
    if (organizationId) { vals.push(organizationId); where += ` AND organization_id = $${vals.length}`; }
    const { rows } = await pool.query(
        `UPDATE support_inboxes SET shared_groups = $2::jsonb, updated_at = now() ${where} RETURNING ${PUBLIC_COLS}`,
        vals
    );
    return rows[0] || null;
}

/** Persist OAuth tokens + the resolved mailbox address, and activate the inbox. */
const TOKEN_COLUMNS = { tokens: 'encrypted_tokens', emailAddress: 'email_address' };

/**
 * @param id
 * @param tokens
 * @param {{ emailAddress?: string }} [opts]
 */
async function updateTokens(id, tokens, { emailAddress } = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'support_inboxes',
        // An empty address is not an address: keep the one the mailbox already
        // resolved rather than blanking it on a reconnect that omitted it.
        updates: { tokens: encryptTokens(tokens), emailAddress: emailAddress || undefined },
        columnMap: TOKEN_COLUMNS,
        extraSet: ['active = true', 'updated_at = now()'],
        where: [{ col: 'id', value: id }],
    });
    await pool.query(built.sql, built.params);
}

/**
 * Disconnect a mailbox without losing the inbox: shred the OAuth tokens, stop
 * the sync engine from ever picking it up again (active=false clears it out of
 * getDueInboxes), reset the incremental cursors so a later reconnect starts
 * clean, and purge the tickets this mailbox produced.
 *
 * The row itself stays so its settings, group access and KB wiring survive a
 * reconnect. Returns { ok, purgedThreads }.
 */
async function disconnectInbox(id, organizationId = null) {
    await initDB();
    const vals = [id];
    let where = `WHERE id = $1`;
    if (organizationId) { vals.push(organizationId); where += ` AND organization_id = $${vals.length}`; }
    const { rowCount } = await pool.query(
        `UPDATE support_inboxes
            SET encrypted_tokens = NULL,
                active = false,
                gmail_history_id = NULL,
                graph_delta_link = NULL,
                sync_status = 'idle',
                sync_error = NULL,
                sync_locked_until = NULL,
                updated_at = now()
          ${where}`,
        vals
    );
    if (!rowCount) return { ok: false, purgedThreads: 0 };
    // Purge before returning: leaving them would strand the mailbox's tickets
    // in a disconnected inbox nobody works.
    const purgedThreads = await _purgeThreadsForInbox(id);
    return { ok: true, purgedThreads };
}

/**
 * Delete every ticket that arrived over this inbox. Messages and thread events
 * follow via ON DELETE CASCADE; support_audit_log has no FK and survives, which
 * is what keeps the "this mailbox existed and was removed" trail intact.
 */
async function _purgeThreadsForInbox(inboxId) {
    const { rowCount } = await pool.query(`DELETE FROM support_threads WHERE inbox_id = $1`, [inboxId]);
    return rowCount;
}

async function deleteInbox(id, organizationId = null) {
    await initDB();
    const vals = [id];
    let where = `WHERE id = $1`;
    if (organizationId) { vals.push(organizationId); where += ` AND organization_id = $2`; }
    const { rowCount } = await pool.query(`DELETE FROM support_inboxes ${where}`, vals);
    if (!rowCount) return { ok: false, purgedThreads: 0 };
    // Purge, don't detach. Detaching (the old behaviour) set inbox_id = NULL,
    // and inbox_id IS NULL is exactly how Bee Flow's own company inbox is
    // defined — so removing a tenant mailbox dumped every one of its emails
    // into the admin Customer Support panel. See routes/support.js GET /threads.
    // Ordering is safe: support_threads.inbox_id carries no FK to this table.
    const purgedThreads = await _purgeThreadsForInbox(id);
    return { ok: true, purgedThreads };
}

// ── Sync engine helpers ───────────────────────────────────────────────────────

async function getDueInboxes() {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_inboxes
          WHERE active = true
            AND encrypted_tokens IS NOT NULL
            AND sync_status != 'syncing'
            AND (sync_locked_until IS NULL OR sync_locked_until <= now())
            AND (last_sync_at IS NULL OR last_sync_at + (sync_interval_minutes || ' minutes')::interval <= now())
          ORDER BY last_sync_at ASC NULLS FIRST
          LIMIT 20`
    );
    return rows;
}

async function acquireSyncLock(inboxId, ttlMinutes = 10) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_inboxes
            SET sync_locked_until = now() + ($2 || ' minutes')::interval, updated_at = now()
          WHERE id = $1 AND (sync_locked_until IS NULL OR sync_locked_until <= now())
          RETURNING sync_locked_until`,
        [inboxId, String(ttlMinutes)]
    );
    return { acquired: rows.length > 0 };
}

async function releaseSyncLock(inboxId) {
    await initDB();
    await pool.query(
        `UPDATE support_inboxes SET sync_locked_until = NULL, updated_at = now() WHERE id = $1`,
        [inboxId]
    );
}

const CURSOR_COLUMNS = { gmailHistoryId: 'gmail_history_id', graphDeltaLink: 'graph_delta_link' };

/**
 * @param inboxId
 * @param {{ gmailHistoryId?: string, graphDeltaLink?: string }} [opts]
 */
async function updateIncrementalCursor(inboxId, { gmailHistoryId, graphDeltaLink } = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'support_inboxes',
        updates: { gmailHistoryId, graphDeltaLink },
        columnMap: CURSOR_COLUMNS,
        extraSet: ['updated_at = now()'],
        where: [{ col: 'id', value: inboxId }],
    });
    if (!built) return;
    await pool.query(built.sql, built.params);
}

const SYNC_STATE_COLUMNS = { syncStatus: 'sync_status', syncError: 'sync_error', lastSyncAt: 'last_sync_at' };

/**
 * @param inboxId
 * @param {{ syncStatus?: string, syncError?: string, lastSyncAt?: string|Date }} [opts]
 */
async function updateSyncState(inboxId, { syncStatus, syncError, lastSyncAt } = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'support_inboxes',
        updates: { syncStatus, syncError, lastSyncAt },
        columnMap: SYNC_STATE_COLUMNS,
        extraSet: ['updated_at = now()'],
        where: [{ col: 'id', value: inboxId }],
    });
    if (!built) return;
    await pool.query(built.sql, built.params);
}

// ── Historical scan helpers (engine-owned; clients can't write scan_* via PATCH) ─

/**
 * Queue a scan: set status='queued' + the look-back anchor, clearing any prior
 * result/progress. Returns the public row. Caller validates org scope.
 * @param inboxId
 * @param {{ scanAfter?: string|Date }} [opts]
 */
async function queueScan(inboxId, { scanAfter } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_inboxes
            SET scan_status = 'queued',
                scan_after = $2,
                scan_progress = '{}'::jsonb,
                scan_result = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING ${PUBLIC_COLS}`,
        [inboxId, scanAfter || null]
    );
    return rows[0] || null;
}

/** Claim the next queued scan with a TTL lease (mirrors acquireSyncLock). */
async function acquireScanLock(inboxId, ttlMinutes = 30) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_inboxes
            SET scan_status = 'running',
                scan_locked_until = now() + ($2 || ' minutes')::interval,
                updated_at = now()
          WHERE id = $1
            AND scan_status IN ('queued','running')
            AND (scan_locked_until IS NULL OR scan_locked_until <= now())
          RETURNING scan_locked_until`,
        [inboxId, String(ttlMinutes)]
    );
    return { acquired: rows.length > 0 };
}

async function releaseScanLock(inboxId) {
    await initDB();
    await pool.query(
        `UPDATE support_inboxes SET scan_locked_until = NULL, updated_at = now() WHERE id = $1`,
        [inboxId]
    );
}

/** Inboxes with a queued scan whose lease is free (drained off the sync tick). */
async function getDueScans() {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_inboxes
          WHERE active = true
            AND encrypted_tokens IS NOT NULL
            AND scan_status = 'queued'
            AND (scan_locked_until IS NULL OR scan_locked_until <= now())
          ORDER BY updated_at ASC
          LIMIT 5`
    );
    return rows;
}

const SCAN_STATE_COLUMNS = {
    status: 'scan_status',
    progress: asJsonb('scan_progress'),
    // A cleared result is SQL NULL, not the JSON string "null".
    result: { col: 'scan_result', cast: 'jsonb', transform: (v) => (v == null ? null : JSON.stringify(v)) },
};

/**
 * Write scan progress/status/result. Engine-only.
 * @param inboxId
 * @param {{ status?: string, progress?: any, result?: any }} [opts]
 */
async function setScanState(inboxId, { status, progress, result } = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'support_inboxes',
        updates: { status, progress, result },
        columnMap: SCAN_STATE_COLUMNS,
        extraSet: ['updated_at = now()'],
        where: [{ col: 'id', value: inboxId }],
    });
    if (!built) return;
    await pool.query(built.sql, built.params);
}

module.exports = {
    initDB,
    createInbox,
    listInboxes,
    getInbox,
    getInboxWithTokens,
    updateInbox,
    setKbAutomation,
    setSharedGroups,
    updateTokens,
    deleteInbox,
    disconnectInbox,
    getDueInboxes,
    acquireSyncLock,
    releaseSyncLock,
    updateIncrementalCursor,
    updateSyncState,
    queueScan,
    acquireScanLock,
    releaseScanLock,
    getDueScans,
    setScanState,
    encryptTokens,
    decryptTokens,
};
