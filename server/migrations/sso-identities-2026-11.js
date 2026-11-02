// @typecheck strict
'use strict';
/**
 * Migration: SSO identities (2026-11).
 *
 * Creates sso_identities (auth/ssoIdentityStore.mts) and records the
 * provider subject for the accounts whose id already names it:
 *
 *   - `nextcloud-<uid>`: made by the Nextcloud sign-in under its prefixed id;
 *   - a 21-digit id: made by the Google sign-in under the Google `sub`.
 *
 * Only rows without a credential or second factor of their own and without
 * the admin role are recorded: a self-chosen username of the same shape is
 * not proof of the provider identity. Everything else (accounts created
 * under an e-mail-derived id, legacy accounts under the raw Nextcloud uid)
 * gets its identity on the next sign-in or by linking from account settings.
 *
 * Idempotent: CREATE ... IF NOT EXISTS and ON CONFLICT DO NOTHING.
 */

/** @param {{ exec: (sql: string) => Promise<unknown>, run: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null } | unknown> }} [db] */
async function up(db = require('../db')) {
    const { SSO_IDENTITY_DDL } = require('../auth/ssoIdentityStore.mts');
    for (const sql of SSO_IDENTITY_DDL) await db.exec(sql);
    const noCredential = `"passwordHash" IS NULL AND "opaqueRecord" IS NULL
        AND COALESCE(mfa_enabled, FALSE) = FALSE AND COALESCE(role, '') <> 'admin'`;
    const nc = /** @type {{ rowCount?: number | null }} */ (await db.run(`
        INSERT INTO sso_identities (user_id, provider, subject)
        SELECT id, 'nextcloud', SUBSTRING(id FROM 11) FROM users
         WHERE id LIKE 'nextcloud-%' AND LENGTH(id) > 10 AND ${noCredential}
        ON CONFLICT (provider, subject) DO NOTHING`));
    const google = /** @type {{ rowCount?: number | null }} */ (await db.run(`
        INSERT INTO sso_identities (user_id, provider, subject)
        SELECT id, 'google', id FROM users
         WHERE id ~ '^[0-9]{21}$' AND ${noCredential}
        ON CONFLICT (provider, subject) DO NOTHING`));
    console.log(`[Migration] sso-identities-2026-11: ${nc?.rowCount || 0} Nextcloud and ${google?.rowCount || 0} Google identities recorded`);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
