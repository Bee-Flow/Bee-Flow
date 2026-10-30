// @typecheck
'use strict';

// OAuth metadata and credentials are committed together. Reads deliberately
// bypass caches: a tenant restriction must take effect on every replica.
const SECRET_KEYS = Object.freeze({
    microsoft: 'oauth_microsoft_client_secret',
    google: 'oauth_google_client_secret',
    nextcloud: 'oauth_nextcloud_client_secret',
});
const META_KEYS = ['admin', 'oauth', 'providers'];
// Each additional Microsoft sign-in connection (auth/oauth/microsoftConnections.mts)
// keeps its secret under its own key, next to the primary's.
const CONNECTION_SECRET_PREFIX = `${SECRET_KEYS.microsoft}:`;
/** @param {string} connectionId */
const connectionSecretKey = (connectionId) => `${CONNECTION_SECRET_PREFIX}${connectionId}`;

/**
 * The additional Microsoft connections on a provider entry, never undefined.
 * @param {{ connections?: unknown } | undefined} entry
 * @returns {Record<string, any>[]}
 */
function connectionList(entry) {
    return Array.isArray(entry?.connections) ? entry.connections : [];
}

/**
 * An additional Microsoft connection stores its secret under its own key, never in
 * the providers row; one that got there anyway (a hand-edited row) is moved like a
 * legacy primary secret, inside the same locked transaction.
 * @param {{ providers: Record<string, any> }} state
 * @param {{ has: (key: string) => boolean, secretAt: (key: string) => string, write: (key: string, value: any, secret?: boolean) => Promise<void> }} tx
 */
async function upgradeConnectionSecrets(state, { has, secretAt, write }) {
    for (const connection of connectionList(state.providers.microsoft)) {
        if (!connection || !Object.hasOwn(connection, 'clientSecret')) continue;
        const key = connectionSecretKey(connection.id);
        const old = connection.clientSecret;
        if (old && !has(key)) await write(key, old, true);
        if (old && secretAt(key) !== old) throw new Error('Conflicting OAuth credentials require administrator recovery');
        delete connection.clientSecret;
        connection.hasClientSecret = !!secretAt(key);
        await write('providers', state.providers);
    }
}

/**
 * Replace the additional Microsoft connections with `supplied`: the
 * metadata goes in `providers`, each secret under its own key (kept when
 * the patch leaves it blank), and the secret of a connection that is no
 * longer in the list is deleted in the same transaction.
 * @param {Record<string, any>} current the providers.microsoft entry
 * @param {Record<string, any>[]} supplied
 * @param {{ secretAt: (key: string) => string, write: (key: string, value: any, secret?: boolean) => Promise<void>, remove: (key: string) => Promise<void> }} tx
 */
async function replaceConnections(current, supplied, { secretAt, write, remove }) {
    const kept = new Set();
    const next = [];
    for (const fields of supplied) {
        const { clientSecret, hasClientSecret: _presence, ...metadata } = fields;
        if (typeof metadata.id !== 'string' || !metadata.id) throw new Error('A Microsoft connection needs an id');
        if (kept.has(metadata.id)) throw new Error('Duplicate Microsoft connection id');
        kept.add(metadata.id);
        const key = connectionSecretKey(metadata.id);
        if (clientSecret !== undefined && typeof clientSecret !== 'string') throw new Error('Invalid OAuth credential');
        if (clientSecret?.trim()) await write(key, clientSecret, true);
        const previous = connectionList(current).find((c) => c.id === metadata.id) || {};
        next.push({ ...previous, ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)), hasClientSecret: !!secretAt(key) });
    }
    for (const old of connectionList(current)) {
        if (!kept.has(old.id)) await remove(connectionSecretKey(old.id));
    }
    current.connections = next;
}

/**
 * One provider's patch: metadata on the entry, the secret under its key (kept when
 * blank), and for Microsoft the additional connections.
 * @param {string} provider
 * @param {Record<string, any>} current
 * @param {Record<string, any>} fields
 * @param {{ secretValue: (provider: string) => string, secretAt: (key: string) => string, write: (key: string, value: any, secret?: boolean) => Promise<void>, remove: (key: string) => Promise<void> }} tx
 */
async function applyProviderFields(provider, current, fields, { secretValue, secretAt, write, remove }) {
    const { clientSecret, hasClientSecret: _presence, connections, ...metadata } = fields;
    Object.assign(current, Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)));
    if (connections !== undefined) {
        if (provider !== 'microsoft' || !Array.isArray(connections)) throw new Error('Only Microsoft has sign-in connections');
        await replaceConnections(current, connections, { secretAt, write, remove });
    }
    if (clientSecret !== undefined && typeof clientSecret !== 'string') throw new Error('Invalid OAuth credential');
    if (clientSecret?.trim()) await write(SECRET_KEYS[provider], clientSecret, true);
    current.hasClientSecret = !!secretValue(provider);
}

function createAuthConfigStore({ db, configStore }) {
    const invalidate = (keys) => {
        for (const key of keys) configStore._applyInvalidation(key);
    };
    async function transaction(fn) {
        await configStore.initDB();
        const changed = new Set();
        const result = await db.withTransaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext('beeflow:auth-config'))");
            const { rows } = await client.query('SELECT key, value FROM config WHERE key = ANY($1::text[]) OR key LIKE $2',
                [[...META_KEYS, ...Object.values(SECRET_KEYS)], `${CONNECTION_SECRET_PREFIX}%`]);
            const values = new Map(rows.map(row => [row.key, row.value]));
            /**
             * @param {string} key
             */
            const read = key => values.has(key) ? JSON.parse(values.get(key)) : null;
            /**
             * @param {boolean} [secret]
             */
            const write = async (key, value, secret = false) => {
                const encoded = secret ? configStore.encryptValue(value) : JSON.stringify(value);
                if (secret && configStore.decryptValue(encoded) !== value) throw new Error('OAuth secret encryption verification failed');
                await client.query(`INSERT INTO config (key, value, updated_at) VALUES ($1,$2,NOW())
                    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [key, encoded]);
                if (secret) {
                    const { rows } = await client.query('SELECT value FROM config WHERE key=$1', [key]);
                    if (rows.length !== 1 || configStore.decryptValue(rows[0].value) !== value) throw new Error('Stored OAuth credential verification failed');
                }
                values.set(key, encoded);
                changed.add(key);
                // Postgres delivers transactional notifications only at commit.
                await client.query('SELECT pg_notify($1,$2)', [configStore.CONFIG_INVALIDATE_CHANNEL, key]);
            };
            /** @param {string} key */
            const remove = async (key) => {
                if (!values.has(key)) return;
                await client.query('DELETE FROM config WHERE key=$1', [key]);
                values.delete(key);
                changed.add(key);
                await client.query('SELECT pg_notify($1,$2)', [configStore.CONFIG_INVALIDATE_CHANNEL, key]);
            };
            /** @param {string} key */
            const secretAt = (key) => {
                const raw = values.get(key);
                if (!raw) return '';
                if (JSON.parse(raw)?._encrypted !== 'config-v1') throw new Error('OAuth credential is not encrypted');
                const value = configStore.decryptValue(raw);
                if (value === null) throw new Error('OAuth credential could not be decrypted');
                return value;
            };
            const secretValue = (/** @type {string} */ provider) => secretAt(SECRET_KEYS[provider]);
            const state = {
                admin: read('admin') || { username: 'admin', passwordHash: '' },
                oauth: read('oauth') || { nextcloudUrl: '', clientId: '' },
                providers: read('providers') || {},
            };
            // Upgrade legacy rows inside the same locked transaction. Never
            // delete the old value until the replacement can be decrypted.
            for (const provider of Object.keys(SECRET_KEYS)) {
                const entries = provider === 'nextcloud'
                    ? [['oauth', state.oauth], ['providers', state.providers.nextcloud]]
                    : [['providers', state.providers[provider]]];
                for (const [key, entry] of entries) {
                if (!entry) continue;
                if (Object.hasOwn(entry, 'clientSecret')) {
                    const old = entry.clientSecret;
                    if (old && !values.has(SECRET_KEYS[provider])) await write(SECRET_KEYS[provider], old, true);
                    if (old && secretValue(provider) !== old) throw new Error('Conflicting OAuth credentials require administrator recovery');
                    delete entry.clientSecret;
                    entry.hasClientSecret = !!secretValue(provider);
                    await write(key, state[key]);
                }
                }
            }
            await upgradeConnectionSecrets(state, { has: key => values.has(key), secretAt, write });
            return fn({ state, secretValue, secretAt, write, remove, client });
        });
        invalidate(changed);
        return result;
    }
    async function load() {
        return transaction(async ({ state, secretValue, secretAt }) => {
            for (const provider of Object.keys(SECRET_KEYS)) {
                const entry = provider === 'nextcloud' ? state.oauth : (state.providers[provider] ||= {});
                entry.clientSecret = secretValue(provider);
            }
            for (const connection of connectionList(state.providers.microsoft)) {
                connection.clientSecret = secretAt(connectionSecretKey(connection.id));
            }
            return state;
        });
    }
    async function save(patch) {
        return transaction(async ({ state, secretValue, secretAt, write, remove }) => {
            if (patch.admin !== undefined) {
                state.admin = { ...state.admin, ...patch.admin };
                await write('admin', state.admin);
            }
            for (const [key, supplied] of [['oauth', patch.oauth], ['providers', patch.providers]]) {
                if (!supplied) continue;
                const entries = key === 'oauth' ? { nextcloud: supplied } : supplied;
                for (const [provider, fields] of Object.entries(entries)) {
                    if (!Object.hasOwn(SECRET_KEYS, provider)) throw new Error('Unknown OAuth provider');
                    const current = key === 'oauth' ? state.oauth : (state.providers[provider] ||= {});
                    await applyProviderFields(provider, current, fields, { secretValue, secretAt, write, remove });
                }
                await write(key, state[key]);
            }
            return true;
        });
    }
    /**
     * Swap the built-in admin's password hash for a re-encoding of the same
     * password, only if it is still the hash the sign-in just verified. Inside
     * the same advisory-locked transaction as save(), so a concurrent setup or
     * password change cannot be overwritten by an older password.
     * @param {string} expectedHash
     * @param {string} newHash
     * @returns {Promise<boolean>}
     */
    async function replaceAdminPasswordHash(expectedHash, newHash) {
        if (!expectedHash || !newHash) return false;
        return transaction(async ({ state, write }) => {
            if (state.admin.passwordHash !== expectedHash) return false;
            state.admin = { ...state.admin, passwordHash: newHash };
            await write('admin', state.admin);
            return true;
        });
    }
    return { load, save, replaceAdminPasswordHash, migrate: () => transaction(async () => true) };
}

let store;
function defaultStore() {
    return store ||= createAuthConfigStore({ db: require('../db'), configStore: require('./configStore') });
}
module.exports = { SECRET_KEYS, createAuthConfigStore,
    load: () => defaultStore().load(), save: patch => defaultStore().save(patch),
    replaceAdminPasswordHash: (expectedHash, newHash) => defaultStore().replaceAdminPasswordHash(expectedHash, newHash),
    migrate: () => defaultStore().migrate() };

/**
 * @typedef OAuthEntry
 * @property {string} [nextcloudUrl]
 * @property {string} [clientId]
 * @property {string} [clientSecret]
 * @property {boolean} [hasClientSecret]
 */

/** @typedef {{ username: string, passwordHash: string }} AdminConfig */

/** @typedef {{ admin: AdminConfig, oauth: OAuthEntry, providers: Record<string, OAuthEntry> }} AuthConfigState */

/** @typedef {{ admin?: Partial<AdminConfig>, oauth?: OAuthEntry, providers?: Record<string, OAuthEntry> }} AuthConfigPatch */

/**
 * @typedef AuthConfigTx
 * @property {AuthConfigState} state
 * @property {(provider: string) => string} secretValue
 * @property {(key: string, value: unknown, secret?: boolean) => Promise<void>} write
 * @property {import('pg').PoolClient} client
 */
