// @typecheck strict
/**
 * The mailbox of Bee Flow's own company support inbox (/app/admin/support):
 * one IMAP account that mail comes in on and one SMTP account replies go out
 * on. There is at most one row (id 'company'); the company inbox itself stays
 * "threads with inbox_id IS NULL", so nothing here is a support_inboxes row
 * and no tenant route can reach it.
 *
 * The passwords live in one AES-256-GCM blob (utils/secretBox, a salt of its
 * own) and never leave this module except to the sync and the mailer:
 * `getMailbox` returns the public columns, `getMailboxWithSecrets` adds them.
 *
 * Sync state: `last_uid` + `uid_validity` are the IMAP cursor (a changed
 * UIDVALIDITY means the server renumbered the folder and the cursor restarts
 * at the date anchor). `sync_locked_until` is a lease the database expires by
 * itself, so a killed pod never holds the mailbox (same handshake as
 * supportInboxStore.acquireSyncLock), held by a token so a sync whose lease
 * expired cannot release the next holder's. `generation` goes up on every
 * save: a sync still running for the previous settings cannot write its
 * cursor or outcome into the new ones.
 */

const { pool, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const crypto = require('crypto');
const { createSecretBox } = require('../utils/secretBox');
const log = require('../telemetry/log');

const ENCRYPTION_KEY_SOURCE = process.env.SESSION_SECRET || '';
const ROW_ID = 'company';

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS support_company_mailbox (
    id TEXT PRIMARY KEY CHECK (id = 'company'),
    email_address TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    imap_host TEXT NOT NULL,
    imap_port INT NOT NULL,
    imap_security TEXT NOT NULL CHECK (imap_security IN ('tls','starttls')),
    imap_folder TEXT NOT NULL DEFAULT 'INBOX',
    smtp_host TEXT NOT NULL,
    smtp_port INT NOT NULL,
    smtp_security TEXT NOT NULL CHECK (smtp_security IN ('tls','starttls')),
    username TEXT NOT NULL,
    smtp_username TEXT,
    encrypted_secrets TEXT NOT NULL,
    ai_auto_reply BOOLEAN NOT NULL DEFAULT false,
    active BOOLEAN NOT NULL DEFAULT true,
    uid_validity TEXT,
    last_uid BIGINT,
    sync_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_status TEXT NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle','error')),
    sync_error TEXT,
    sync_locked_until TIMESTAMPTZ,
    sync_lock_token TEXT,
    generation INT NOT NULL DEFAULT 1,
    last_sync_at TIMESTAMPTZ,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function _initDB() {
    await exec(INIT_SQL);
    log.info('[SupportCompanyMailboxStore] PostgreSQL initialized');
}

const initDB = makeStoreInit('SupportCompanyMailboxStore', _initDB);

const _box = createSecretBox(ENCRYPTION_KEY_SOURCE, 'support-company-mailbox-salt', { logPrefix: '[SupportCompanyMailboxStore]' });

/** Everything a staff screen may see: no secret, no blob. */
const PUBLIC_COLS = `email_address, display_name, imap_host, imap_port, imap_security, imap_folder,
    smtp_host, smtp_port, smtp_security, username, smtp_username, ai_auto_reply, active,
    sync_status, sync_error, last_sync_at, created_at, updated_at`;

/**
 * @typedef {'tls' | 'starttls'} Security
 * @typedef {{
 *   emailAddress: string, displayName: string,
 *   imap: { host: string, port: number, security: Security, folder: string },
 *   smtp: { host: string, port: number, security: Security },
 *   username: string, smtpUsername: string | null,
 *   aiAutoReply: boolean, active: boolean,
 *   syncStatus: string, syncError: string | null, lastSyncAt: string | null,
 *   createdAt: string | null, updatedAt: string | null,
 * }} CompanyMailbox
 * @typedef {{ password: string, smtpPassword?: string | null }} MailboxSecrets
 * @typedef {CompanyMailbox & { secrets: MailboxSecrets, uidValidity: string | null, lastUid: number | null, syncAfter: string, generation: number }} CompanyMailboxWithSecrets
 * @typedef {Record<string, unknown>} Row
 */

/** @param {unknown} v */
const iso = (v) => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : '');
/** @param {unknown} v @returns {Security} */
const sec = (v) => (v === 'starttls' ? 'starttls' : 'tls');

/**
 * @param {Row} r
 * @returns {CompanyMailbox}
 */
function toPublic(r) {
    return {
        emailAddress: str(r.email_address),
        displayName: str(r.display_name),
        imap: { host: str(r.imap_host), port: Number(r.imap_port), security: sec(r.imap_security), folder: str(r.imap_folder) || 'INBOX' },
        smtp: { host: str(r.smtp_host), port: Number(r.smtp_port), security: sec(r.smtp_security) },
        username: str(r.username),
        smtpUsername: typeof r.smtp_username === 'string' && r.smtp_username ? r.smtp_username : null,
        aiAutoReply: r.ai_auto_reply === true,
        active: r.active === true,
        syncStatus: str(r.sync_status) || 'idle',
        syncError: typeof r.sync_error === 'string' ? r.sync_error : null,
        lastSyncAt: iso(r.last_sync_at),
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
    };
}

const UNREADABLE = 'The stored password can no longer be read. Enter it again and save the mailbox.';

/** @returns {Promise<CompanyMailbox | null>} */
async function getMailbox() {
    await initDB();
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLS} FROM support_company_mailbox WHERE id = $1`, [ROW_ID]);
    return rows[0] ? toPublic(rows[0]) : null;
}

/**
 * The row with its decrypted secrets and the IMAP cursor: for the sync and
 * the mailer only, never for a response.
 * @returns {Promise<CompanyMailboxWithSecrets | null>}
 */
async function getMailboxWithSecrets() {
    await initDB();
    const { rows } = await pool.query(`SELECT * FROM support_company_mailbox WHERE id = $1`, [ROW_ID]);
    const r = rows[0];
    if (!r) return null;
    const secrets = _box.decrypt(String(r.encrypted_secrets || ''));
    if (!secrets || typeof secrets.password !== 'string') {
        // SESSION_SECRET changed (or the blob is damaged): say so on the
        // screen instead of going quiet, and let callers treat it as not connected.
        await pool.query(
            `UPDATE support_company_mailbox SET sync_status = 'error', sync_error = $2 WHERE id = $1 AND sync_error IS DISTINCT FROM $2`,
            [ROW_ID, UNREADABLE],
        );
        return null;
    }
    return {
        ...toPublic(r),
        secrets: { password: secrets.password, smtpPassword: typeof secrets.smtpPassword === 'string' ? secrets.smtpPassword : null },
        uidValidity: typeof r.uid_validity === 'string' ? r.uid_validity : null,
        lastUid: r.last_uid == null ? null : Number(r.last_uid),
        syncAfter: iso(r.sync_after) || new Date().toISOString(),
        generation: Number(r.generation) || 1,
    };
}

/** The cursor survives a save only while it still points at the same folder of the same account. */
const SAME_ACCOUNT = `(lower(support_company_mailbox.imap_host) = lower(EXCLUDED.imap_host)
    AND lower(support_company_mailbox.username) = lower(EXCLUDED.username)
    AND support_company_mailbox.imap_folder = EXCLUDED.imap_folder)`;

/**
 * Create or replace the mailbox. A new account (another address, host or
 * user name) resets the IMAP cursor and starts reading from now: connecting
 * a mailbox never turns its whole history into tickets.
 * @param {{
 *   emailAddress: string, displayName: string,
 *   imap: { host: string, port: number, security: Security, folder: string },
 *   smtp: { host: string, port: number, security: Security },
 *   username: string, smtpUsername: string | null,
 *   secrets: MailboxSecrets, aiAutoReply: boolean, createdBy: string | null,
 * }} m
 * @returns {Promise<CompanyMailbox>}
 */
async function saveMailbox(m) {
    await initDB();
    const blob = _box.encrypt({ password: m.secrets.password, smtpPassword: m.secrets.smtpPassword || null });
    const { rows } = await pool.query(
        `INSERT INTO support_company_mailbox
            (id, email_address, display_name, imap_host, imap_port, imap_security, imap_folder,
             smtp_host, smtp_port, smtp_security, username, smtp_username, encrypted_secrets,
             ai_auto_reply, active, created_by, sync_after)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,now())
         ON CONFLICT (id) DO UPDATE SET
            email_address = EXCLUDED.email_address, display_name = EXCLUDED.display_name,
            imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port,
            imap_security = EXCLUDED.imap_security, imap_folder = EXCLUDED.imap_folder,
            smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port,
            smtp_security = EXCLUDED.smtp_security, username = EXCLUDED.username,
            smtp_username = EXCLUDED.smtp_username, encrypted_secrets = EXCLUDED.encrypted_secrets,
            ai_auto_reply = EXCLUDED.ai_auto_reply, active = true,
            generation = support_company_mailbox.generation + 1,
            sync_status = 'idle', sync_error = NULL, updated_at = now(),
            uid_validity = CASE WHEN ${SAME_ACCOUNT} THEN support_company_mailbox.uid_validity ELSE NULL END,
            last_uid = CASE WHEN ${SAME_ACCOUNT} THEN support_company_mailbox.last_uid ELSE NULL END,
            sync_after = CASE WHEN ${SAME_ACCOUNT} THEN support_company_mailbox.sync_after ELSE now() END
         RETURNING ${PUBLIC_COLS}`,
        [ROW_ID, m.emailAddress, m.displayName, m.imap.host, m.imap.port, m.imap.security, m.imap.folder,
            m.smtp.host, m.smtp.port, m.smtp.security, m.username, m.smtpUsername, blob,
            m.aiAutoReply, m.createdBy],
    );
    return toPublic(rows[0]);
}

/** Remove the mailbox. Tickets it produced stay in the inbox. @returns {Promise<boolean>} */
async function deleteMailbox() {
    await initDB();
    const res = await pool.query(`DELETE FROM support_company_mailbox WHERE id = $1`, [ROW_ID]);
    return (res.rowCount || 0) > 0;
}

/**
 * Take the sync lease. Returns its token, or null while another tick (or pod) holds it.
 * @param {number} ttlMinutes
 * @returns {Promise<string | null>}
 */
async function acquireSyncLock(ttlMinutes) {
    await initDB();
    const token = crypto.randomUUID();
    const { rows } = await pool.query(
        `UPDATE support_company_mailbox
            SET sync_locked_until = now() + make_interval(mins => $2::int), sync_lock_token = $3
          WHERE id = $1 AND active = true AND (sync_locked_until IS NULL OR sync_locked_until < now())
          RETURNING id`,
        [ROW_ID, ttlMinutes, token],
    );
    return rows.length > 0 ? token : null;
}

/** Release the lease, only while `token` still holds it. @param {string} token */
async function releaseSyncLock(token) {
    await initDB();
    await pool.query(
        `UPDATE support_company_mailbox SET sync_locked_until = NULL, sync_lock_token = NULL WHERE id = $1 AND sync_lock_token = $2`,
        [ROW_ID, token],
    );
}

/**
 * Move the IMAP cursor after a message was handled, for the settings
 * `generation` the sync read; a save in between makes it a no-op.
 * @param {{ generation: number, uidValidity: string, lastUid: number }} c
 */
async function setCursor({ generation, uidValidity, lastUid }) {
    await initDB();
    await pool.query(
        `UPDATE support_company_mailbox SET uid_validity = $2, last_uid = $3 WHERE id = $1 AND generation = $4`,
        [ROW_ID, uidValidity, lastUid, generation],
    );
}

/**
 * The outcome of a sync: 'idle' or 'error' (never an in-flight marker; the lease is that).
 * @param {{ generation: number, status: 'idle' | 'error', error?: string | null }} s
 */
async function setSyncResult({ generation, status, error = null }) {
    await initDB();
    await pool.query(
        `UPDATE support_company_mailbox SET sync_status = $2, sync_error = $3, last_sync_at = now() WHERE id = $1 AND generation = $4`,
        [ROW_ID, status, error ? String(error).slice(0, 500) : null, generation],
    );
}

module.exports = {
    initDB,
    getMailbox,
    getMailboxWithSecrets,
    saveMailbox,
    deleteMailbox,
    acquireSyncLock,
    releaseSyncLock,
    setCursor,
    setSyncResult,
};
