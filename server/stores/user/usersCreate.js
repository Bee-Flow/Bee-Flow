// @typecheck
const { run, getOne, getClient } = require('../../db');
const { initDB } = require('./schema');
const { getEffectiveLimits } = require('./subscriptions');
const log = require('../../telemetry/log');
const { syncSeatQuantity } = require('./seatSyncPort');

/**
 * Strip markup from the three free-text name fields on a user row.
 *
 * Lives here rather than in each route because every writer converges on
 * createUser/updateUser: public signup, the admin panel, Google/Microsoft/
 * Nextcloud OAuth, and the Azure + Nextcloud directory syncs. A pentest stored
 * `<img src=x onerror=...>` in an organisation's tagline; the same request's
 * displayName was still landing verbatim after the org fields had been fixed,
 * which is what a single choke point prevents.
 *
 * Lazily required: utils/htmlSanitizer pulls in JSDOM, and this module is loaded
 * during boot before that cost is worth paying. Falls back to a plain tag strip
 * if it cannot be loaded, so a write is never blocked on the sanitiser.
 *
 * @param {object} src        the incoming user data / update payload
 * @param {{onlyPresent?: boolean}} opts  skip keys the caller did not supply
 */
function sanitizeUserNames(src, { onlyPresent = false } = {}) {
    const fields = ['displayName', 'firstName', 'lastName'];
    let clean;
    try {
        clean = require('../../utils/htmlSanitizer').sanitizePlainText;
    } catch (_) {
        clean = (v) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v);
    }
    const out = {};
    for (const f of fields) {
        if (onlyPresent && !Object.prototype.hasOwnProperty.call(src || {}, f)) continue;
        out[f] = clean(src?.[f], { maxLen: 200 });
    }
    return out;
}

/**
 * Does this write install a genuinely NEW login credential?
 *
 * Same argument as sanitizeUserNames above: every writer converges on
 * createUser / createUserWithSeatCheck / updateUser, so the decision belongs
 * here and not spread over seven routes where the eighth one forgets it. The
 * answer drives `password_changed_at`, which a person reads on their security
 * screen as "your password was last changed on …".
 *
 * A non-empty passwordHash is a new password. Two kinds of write look like one
 * and are not:
 *   - `passwordHash: ''` — Azure/SSO provisioning creates an account with no
 *     password at all. An empty string is not a credential, so it never counts.
 *   - the built-in admin row being MATERIALISED (auth/login/finalizeLogin.js,
 *     auth/mfaRoutes.js): those copy the ALREADY EXISTING hash out of the
 *     config into the users table. Nothing changed for the account holder, and
 *     stamping there would claim a months-old password was changed today. Those
 *     two call sites say so with `credentialUnchanged: true`.
 *
 * OPAQUE accounts carry their credential in `opaqueRecord` rather than a bcrypt
 * hash, so auth/opaqueRoutes.js opts in explicitly by passing
 * `passwordChangedAt` itself — see the note there for why only the account
 * registration does that and the SSO encryption PIN does not.
 */
function isNewCredential(data) {
    if (!data || data.credentialUnchanged === true) return false;
    return typeof data.passwordHash === 'string' && data.passwordHash.length > 0;
}

async function createUser(userData) {
    await initDB();
    const { id, username, passwordHash, email, phone, avatar, avatarType, role, groups, orgRole, organizationId, ncUid, provider, autoProvisioned } = userData;
    // Names are stripped of markup HERE, at the one point every path goes
    // through — public signup, the admin panel, all three OAuth providers, the
    // Nextcloud and Azure directory syncs. Fixing the routes one at a time left
    // signup's displayName still storing `<img src=x onerror=...>` after the
    // organisation fields on the very same request were already clean.
    // A display name is not markup on any code path, so this loses nothing.
    const { displayName, firstName, lastName } = sanitizeUserNames(userData);
    const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
    if (existing) return false;
    try {
        const mwDek = userData.masterWrappedDEK ? (typeof userData.masterWrappedDEK === 'string' ? userData.masterWrappedDEK : JSON.stringify(userData.masterWrappedDEK)) : null;
        const wDek = userData.wrappedDEK ? (typeof userData.wrappedDEK === 'string' ? userData.wrappedDEK : JSON.stringify(userData.wrappedDEK)) : null;
        await run(`INSERT INTO users (id, username, "displayName", "firstName", "lastName", email, phone, avatar, "avatarType", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt", status, "azureUserId", "nc_uid", "provider", "auto_provisioned", password_changed_at, "azureTenantId")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
            [id, username, displayName || username, firstName || null, lastName || null, email || null, phone || null,
                avatar || null, avatarType || null, passwordHash, role || 'user',
                JSON.stringify(groups || []), mwDek, wDek, orgRole || '', organizationId || '',
                new Date().toISOString().split('T')[0], userData.status || 'active', userData.azureUserId || null,
                ncUid || null, provider || null, autoProvisioned ? true : false,
                // An account created WITH a password has its password set right
                // now; one provisioned without one (SSO) keeps NULL = unknown.
                // "createdAt" cannot stand in for this — it is a date-only TEXT
                // column and it never moves when the password later changes.
                isNewCredential(userData) ? new Date() : null, userData.azureTenantId || null]);
        return true;
    } catch (e) { log.error(e); return false; }
}

// ── Atomic seat-cap user creation ─────────────────────────────
// Wraps createUser in a serializable transaction so that two concurrent
// admin-add-user requests cannot both pass a "we have room" check and both
// commit. The cap is computed inside the transaction from the live row
// count + the org's effective max_users + the license seat cap. Throws
// SeatCapExceededError when the cap is hit; the caller maps that to 403.
//
// strict=true (default): throw on cap exceed.
// strict=false: return { created: false, reason: 'seat_cap' } so bulk sync
//   paths (Azure, NC) can log+skip without crashing the batch.
class SeatCapExceededError extends Error {
    constructor(current, max, organizationId) {
        super(`seat_cap_exceeded org=${organizationId} current=${current} max=${max}`);
        this.name = 'SeatCapExceededError';
        this.current = current;
        this.max = max;
        this.organizationId = organizationId;
    }
}

async function createUserWithSeatCheck(userData, { strict = true } = {}) {
    await initDB();
    const orgId = userData.organizationId || '';
    if (!orgId) {
        const ok = await createUser(userData);
        return { created: ok, reason: ok ? null : 'create_failed' };
    }

    let max = null;
    try {
        const limits = await getEffectiveLimits(orgId);
        max = limits?.max_users ?? null;
    } catch (err) { log.debug('ignore', err); }
    try {
        const seatCap = await require('../../license/seats').getMaxSeatsForOrg(orgId);
        if (seatCap != null && (max == null || seatCap < max)) max = seatCap;
    } catch (err) { log.debug('license module optional during early boot', err); }

    const insertParams = (() => {
        const mwDek = userData.masterWrappedDEK
            ? (typeof userData.masterWrappedDEK === 'string' ? userData.masterWrappedDEK : JSON.stringify(userData.masterWrappedDEK))
            : null;
        const wDek = userData.wrappedDEK
            ? (typeof userData.wrappedDEK === 'string' ? userData.wrappedDEK : JSON.stringify(userData.wrappedDEK))
            : null;
        return [
            userData.id, userData.username, userData.displayName || userData.username,
            userData.firstName || null, userData.lastName || null, userData.email || null,
            userData.phone || null, userData.avatar || null, userData.avatarType || null,
            userData.passwordHash, userData.role || 'user',
            JSON.stringify(userData.groups || []), mwDek, wDek,
            userData.orgRole || '', orgId,
            new Date().toISOString().split('T')[0], userData.status || 'active',
            userData.azureUserId || null, userData.ncUid || null,
            userData.provider || null, userData.autoProvisioned ? true : false,
            // Same rule as createUser — see the note there.
            isNewCredential(userData) ? new Date() : null, userData.azureTenantId || null,
        ];
    })();

    for (let attempt = 0; attempt < 2; attempt++) {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE");

            if (max != null) {
                // PG rejects FOR UPDATE alongside aggregate functions
                // ("FOR UPDATE is not allowed with aggregate functions"),
                // so we count rows under SERIALIZABLE isolation instead.
                // Concurrent INSERTs that would push us over the cap raise
                // a 40001 serialization failure on COMMIT, which the
                // attempt-retry below already handles.
                const countRow = await client.query(
                    `SELECT COUNT(*)::int AS n FROM users WHERE "organizationId" = $1 AND COALESCE(status, 'active') = 'active'`,
                    [orgId]
                );
                const current = countRow.rows[0]?.n ?? 0;
                if (current >= max) {
                    await client.query('ROLLBACK');
                    client.release();
                    log.warn(`[seat.cap] ${strict ? 'blocked' : 'skipped'} org=${orgId} current=${current} max=${max}`);
                    if (strict) throw new SeatCapExceededError(current, max, orgId);
                    return { created: false, reason: 'seat_cap', current, max };
                }
            }

            const existing = await client.query('SELECT id FROM users WHERE id = $1', [userData.id]);
            if (existing.rowCount > 0) {
                await client.query('ROLLBACK');
                client.release();
                return { created: false, reason: 'duplicate_id' };
            }

            await client.query(
                `INSERT INTO users (id, username, "displayName", "firstName", "lastName", email, phone, avatar, "avatarType", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt", status, "azureUserId", "nc_uid", "provider", "auto_provisioned", password_changed_at, "azureTenantId")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
                insertParams
            );
            await client.query('COMMIT');
            client.release();
            // Fire-and-forget Stripe seat-quantity sync. Per-seat plans rebill
            // when the active user count changes; we don't await so a Stripe
            // outage can't block user creation. The webhook will reconcile
            // stripe_seat_quantity once the update is processed.
            if (orgId) {
                Promise.resolve().then(async () => {
                    try {
                        await syncSeatQuantity(orgId);
                    } catch (err) { log.debug('best-effort', err); }
                });
            }
            return { created: true, reason: null };
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) { log.debug('connection already broken, the original error is handled below', _); }
            client.release();
            if (e && e.code === '40001' && attempt < 1) continue;
            if (e instanceof SeatCapExceededError) throw e;
            log.error('[UserStore] createUserWithSeatCheck error:', e.message);
            return { created: false, reason: 'create_failed', error: e.message };
        }
    }
    return { created: false, reason: 'create_failed' };
}

module.exports = { sanitizeUserNames, isNewCredential, createUser, SeatCapExceededError, createUserWithSeatCheck };
