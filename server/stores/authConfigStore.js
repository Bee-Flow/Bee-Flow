'use strict';

// OAuth metadata and credentials are committed together. Reads deliberately
// bypass caches: a tenant restriction must take effect on every replica.
const SECRET_KEYS = Object.freeze({
    microsoft: 'oauth_microsoft_client_secret',
    google: 'oauth_google_client_secret',
    nextcloud: 'oauth_nextcloud_client_secret',
});
const META_KEYS = ['admin', 'oauth', 'providers'];

function createAuthConfigStore({ db, configStore }) {
    const invalidate = (keys) => {
        for (const key of keys) configStore._applyInvalidation(key);
    };
    async function transaction(fn) {
        await configStore.initDB();
        const changed = new Set();
        const result = await db.withTransaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext('beeflow:auth-config'))");
            const { rows } = await client.query('SELECT key, value FROM config WHERE key = ANY($1::text[])',
                [[...META_KEYS, ...Object.values(SECRET_KEYS)]]);
            const values = new Map(rows.map(row => [row.key, row.value]));
            const read = key => values.has(key) ? JSON.parse(values.get(key)) : null;
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
            const secretValue = provider => {
                const raw = values.get(SECRET_KEYS[provider]);
                if (!raw) return '';
                if (JSON.parse(raw)?._encrypted !== 'config-v1') throw new Error('OAuth credential is not encrypted');
                const value = configStore.decryptValue(raw);
                if (value === null) throw new Error('OAuth credential could not be decrypted');
                return value;
            };
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
            return fn({ state, secretValue, write, client });
        });
        invalidate(changed);
        return result;
    }
    async function load() {
        return transaction(async ({ state, secretValue }) => {
            for (const provider of Object.keys(SECRET_KEYS)) {
                const entry = provider === 'nextcloud' ? state.oauth : (state.providers[provider] ||= {});
                entry.clientSecret = secretValue(provider);
            }
            return state;
        });
    }
    async function save(patch) {
        return transaction(async ({ state, secretValue, write }) => {
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
                    const { clientSecret, hasClientSecret: _presence, ...metadata } = fields;
                    Object.assign(current, Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)));
                    if (clientSecret !== undefined && typeof clientSecret !== 'string') throw new Error('Invalid OAuth credential');
                    if (clientSecret?.trim()) await write(SECRET_KEYS[provider], clientSecret, true);
                    current.hasClientSecret = !!secretValue(provider);
                }
                await write(key, state[key]);
            }
            return true;
        });
    }
    return { load, save, migrate: () => transaction(async () => true) };
}

let store;
function defaultStore() {
    return store ||= createAuthConfigStore({ db: require('../db'), configStore: require('./configStore') });
}
module.exports = { SECRET_KEYS, createAuthConfigStore,
    load: () => defaultStore().load(), save: patch => defaultStore().save(patch),
    migrate: () => defaultStore().migrate() };
