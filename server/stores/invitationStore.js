// @typecheck strict
/**
 * Invitation Store — PostgreSQL-backed invitation token management
 *
 * Manages email invitations for organisations. Tokens expire after 7 days.
 *
 * The token column holds the SHA-256 of the token the mail carries, so a
 * database read does not yield a usable invitation link. Rows written before
 * that (the token in clear) are still found: a lookup that misses on the hash
 * tries the value as given once and, on a hit, rewrites that row hashed.
 *
 * Redeeming is a claim: `markAccepted` flips exactly one pending row and says
 * whether it did, so two signups racing on the same token cannot both pass.
 * `releaseClaim` hands a claim back when the signup it was taken for did not
 * produce an account.
 */

const crypto = require('crypto');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * What the signup form sends in place of a token when the invitation came in
 * through the redeem link: the token itself stays on the pre-auth session
 * that link parked it on (auth/login/inviteRoutes.js), and the signup resolves
 * it from there. A real token is a UUID, so the two cannot collide.
 */
const SESSION_INVITE_MARKER = 'session';

/**
 * @typedef {{
 *   run: (sql: string, params?: unknown[]) => Promise<{ rowCount: number, rows?: any[] }>,
 *   getOne: (sql: string, params?: unknown[]) => Promise<any>,
 *   getAll: (sql: string, params?: unknown[]) => Promise<any[]>,
 *   exec: (sql: string) => Promise<unknown>,
 * }} InvitationDb
 */

const DDL = `
    CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        token TEXT NOT NULL UNIQUE,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
    )
`;

const PENDING_BY_TOKEN = `SELECT * FROM invitations WHERE token = $1 AND status = 'pending' AND expires_at > NOW()`;

/** What the column holds for a token: never the token itself. @param {string} token */
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * The row a token names, pending and unexpired, whatever form the column
 * holds it in. A row still holding the token in clear is rewritten hashed on
 * the way out.
 * @param {InvitationDb} db
 * @param {string} token
 */
async function findPending(db, token) {
    if (typeof token !== 'string' || !token) return null;
    const hashed = hashToken(token);
    const byHash = await db.getOne(PENDING_BY_TOKEN, [hashed]);
    if (byHash) return byHash;
    const legacy = await db.getOne(PENDING_BY_TOKEN, [token]);
    if (!legacy) return null;
    await db.run(`UPDATE invitations SET token = $1 WHERE id = $2 AND token = $3`, [hashed, legacy.id, token]);
    return { ...legacy, token: hashed };
}

/**
 * Create a new invitation. The returned token is the one the mail carries;
 * the row keeps its hash.
 * @param {InvitationDb} db
 * @param {{ email: string, organizationId: string, invitedBy: string, role?: string }} data
 * @returns {Promise<{ id: string, token: string, expiresAt: string } | null>}
 */
async function createInvitation(db, { email, organizationId, invitedBy, role }) {
    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    // Revoke any existing pending invitations for the same email + org
    await db.run(
        `UPDATE invitations SET status = 'revoked' WHERE LOWER(email) = LOWER($1) AND organization_id = $2 AND status = 'pending'`,
        [email, organizationId]
    );

    try {
        await db.run(
            `INSERT INTO invitations (id, email, organization_id, invited_by, role, token, status, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
            [id, email.toLowerCase(), organizationId, invitedBy, role || 'user', hashToken(token), expiresAt]
        );
        return { id, token, expiresAt };
    } catch (e) {
        log.error('[InvitationStore] createInvitation error:', /** @type {Error} */ (e).message);
        return null;
    }
}

/**
 * Claim an invitation: exactly one caller gets `true` for a pending row.
 * @param {InvitationDb} db
 * @param {string} token
 */
async function markAccepted(db, token) {
    const row = await findPending(db, token);
    if (!row) return false;
    const { rowCount } = await db.run(
        `UPDATE invitations SET status = 'accepted' WHERE id = $1 AND status = 'pending'`,
        [row.id]
    );
    return rowCount > 0;
}

/**
 * @param {{ db?: InvitationDb }} [deps]
 */
function createInvitationStore({ db = require('../db') } = {}) {
    const initDB = makeStoreInit('InvitationStore', async () => { await db.exec(DDL); });
    /** @template T @param {() => Promise<T>} fn */
    const ready = async (fn) => { await initDB(); return fn(); };

    return {
        /** @param {{ email: string, organizationId: string, invitedBy: string, role?: string }} data */
        createInvitation: (data) => ready(() => createInvitation(db, data)),
        /** Get a valid invitation by token (must be pending and not expired). @param {string} token */
        getInvitationByToken: (token) => ready(() => findPending(db, token)),
        /** @param {string} token */
        markAccepted: (token) => ready(() => markAccepted(db, token)),
        /**
         * Hand a claim back: the signup the claim was taken for produced no
         * account, so the invitation is pending again. By id, so a caller can
         * only release what it claimed.
         * @param {string} invitationId
         */
        releaseClaim: (invitationId) => ready(async () => (await db.run(
            `UPDATE invitations SET status = 'pending' WHERE id = $1 AND status = 'accepted'`, [invitationId],
        )).rowCount > 0),
        /** All invitations for an organisation (most recent first). @param {string} organizationId */
        getInvitationsForOrg: (organizationId) => ready(() => db.getAll(
            `SELECT id, email, role, status, invited_by, created_at, expires_at
             FROM invitations WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100`,
            [organizationId],
        )),
        /**
         * An invitation row by primary id. Used by the audit-trail snapshot on
         * DELETE — the revoke path records the original grant terms first.
         * @param {string | string[]} invitationId
         */
        getInvitationById: (invitationId) => ready(() => db.getOne('SELECT * FROM invitations WHERE id = $1', [invitationId])),
        /** Delete (revoke) an invitation by ID. @param {string | string[]} invitationId */
        deleteInvitation: (invitationId) => ready(async () => (await db.run(
            `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'pending'`, [invitationId],
        )).rowCount > 0),
        // Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
        initDB,
    };
}

module.exports = { ...createInvitationStore(), createInvitationStore, hashToken, SESSION_INVITE_MARKER };
