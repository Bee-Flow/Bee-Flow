/**
 * SSO identities: which local account a provider's subject belongs to.
 *
 *   sso_identities (user_id, provider, subject, created_at), unique (provider, subject)
 *
 * A non-Microsoft SSO sign-in is resolved by (provider, subject) first
 * (auth/ssoUserResolver.js). The subject is the provider's stable id for the
 * person: Google's `sub`, the Nextcloud uid. Microsoft keeps its own binding
 * on the users row (azureTenantId, azureUserId) and is not stored here.
 *
 * The table is created by migrations/sso-identities-2026-11.js; the store
 * also creates it once on first use, so a request served before the boot
 * ladder ran does not fail. Rows go with the account (ON DELETE CASCADE).
 *
 * `makeSsoIdentityStore(db)` takes the small `db` a store factory takes
 * (testUtils/pgliteDb.js); the default export below wires it to the pool.
 */

import { createRequire } from 'node:module';

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export const SSO_IDENTITY_DDL = [
    `CREATE TABLE IF NOT EXISTS sso_identities (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider, subject))`,
    `CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities (user_id)`,
];

/** Providers whose identities live here (Microsoft has its own binding). */
export const SSO_IDENTITY_PROVIDERS = Object.freeze(['google', 'nextcloud']);

export type LinkResult = 'linked' | 'already' | 'taken';

export interface SsoIdentityStore {
    findUserId(provider: string, subject: string): Promise<string | null>;
    hasOtherSubject(userId: string, provider: string, subject: string | null | undefined): Promise<boolean>;
    listForUser(userId: string): Promise<Array<{ provider: string; createdAt: unknown }>>;
    link(userId: string, provider: string, subject: string): Promise<LinkResult>;
}

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export function makeSsoIdentityStore(db: Queryable, opts: { ready?: () => Promise<unknown> } = {}): SsoIdentityStore {
    const ready = opts.ready || (async () => undefined);

    async function findUserId(provider: string, subject: string) {
        const p = clean(provider); const s = clean(subject);
        if (!p || !s) return null;
        await ready();
        const { rows } = await db.query('SELECT user_id FROM sso_identities WHERE provider = $1 AND subject = $2', [p, s]);
        return rows[0]?.user_id ?? null;
    }

    /** True when the account already carries a DIFFERENT subject of this provider. */
    async function hasOtherSubject(userId: string, provider: string, subject: string | null | undefined) {
        await ready();
        const { rows } = await db.query(
            'SELECT 1 FROM sso_identities WHERE user_id = $1 AND provider = $2 AND subject <> $3 LIMIT 1',
            [userId, clean(provider), clean(subject)]);
        return rows.length > 0;
    }

    async function listForUser(userId: string) {
        await ready();
        const { rows } = await db.query(
            'SELECT provider, created_at FROM sso_identities WHERE user_id = $1 ORDER BY created_at', [userId]);
        return rows.map((r) => ({ provider: r.provider, createdAt: r.created_at }));
    }

    /**
     * Record (provider, subject) for the account. 'already' when it is this
     * account's, 'taken' when it belongs to another account (never moved).
     */
    async function link(userId: string, provider: string, subject: string): Promise<LinkResult> {
        const p = clean(provider); const s = clean(subject);
        if (!userId || !p || !s) throw new Error('sso identity needs a user, a provider and a subject');
        await ready();
        const inserted = await db.query(
            'INSERT INTO sso_identities (user_id, provider, subject) VALUES ($1, $2, $3) ON CONFLICT (provider, subject) DO NOTHING',
            [userId, p, s]);
        if (inserted.rowCount) return 'linked';
        const owner = await findUserId(p, s);
        return owner === userId ? 'already' : 'taken';
    }

    return { findUserId, hasOtherSubject, listForUser, link };
}

let _default: SsoIdentityStore | null = null;

/** The store on the server's pool, created on first use. */
export function ssoIdentities(): SsoIdentityStore {
    if (_default) return _default;
    const nodeRequire = createRequire(import.meta.url);
    const { pool } = nodeRequire('../db') as { pool: Queryable };
    let created: Promise<unknown> | null = null;
    const ready = () => {
        created ||= (async () => { for (const sql of SSO_IDENTITY_DDL) await pool.query(sql); })()
            .catch((err) => { created = null; throw err; });
        return created;
    };
    _default = makeSsoIdentityStore({ query: (sql, params) => pool.query(sql, params) }, { ready });
    return _default;
}
