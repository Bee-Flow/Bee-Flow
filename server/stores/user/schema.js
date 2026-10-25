// @typecheck strict
// User store schema — creates the users/organizations/groups/roles/subscription
// tables, applies the incremental column migrations on boot, and runs the
// one-time users/groups/roles JSON→DB migration.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run, getOne, exec } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');
const log = require('../../telemetry/log');
const { BASE_TABLES_SQL, TRIAL_HISTORY_SQL } = require('./schemaTables');
const { ACCOUNT_MIGRATIONS, NC_CONNECTOR_COLUMNS, PENDING_NC_BINDINGS_DDL } = require('./schemaMigrations');
const { SUBSCRIPTION_COLUMNS, PLAN_COLUMNS, BILLING_TABLES, SEAT_CAP_INDEX } = require('./planMigrations');

const initDB = makeStoreInit('UserStore', _initDB);

// The statements live in ./schemaTables.js, ./schemaMigrations.js and
// ./planMigrations.js; this is the order they run in, one runDdl call per list.
async function _initDB() {
    await exec(BASE_TABLES_SQL);
    await runDdl('userSchema', ACCOUNT_MIGRATIONS);
    await runDdl('userSchema', NC_CONNECTOR_COLUMNS);
    await runDdl('userSchema', PENDING_NC_BINDINGS_DDL);
    await runDdl('userSchema', SUBSCRIPTION_COLUMNS);
    await exec(TRIAL_HISTORY_SQL);
    await runDdl('userSchema', PLAN_COLUMNS);
    await stripLicenseOnlyTiers();
    await runDdl('userSchema', BILLING_TABLES);
    await seedFreeOrgPlan();
    await runDdl('userSchema', SEAT_CAP_INDEX);
}

// 'community' and 'full' are license-key tier concepts, not subscription
// tiers. Strip them from subscription_plans so the cloud catalogue stays
// clean; tier resolution still falls back to the community floor for
// free/null-tier subscriptions, so behaviour is preserved.
async function stripLicenseOnlyTiers() {
    try {
        const result = await run(`UPDATE subscription_plans SET tier = NULL WHERE tier IN ('community', 'full') AND name <> '__consumer_default__'`);
        const n = result?.rowCount ?? 0;
        if (n > 0) log.info(`[UserStore] migrated ${n} subscription plan(s) off license-only tiers (community/full → NULL)`);
    } catch (e) { log.error('[UserStore] tier-migratie (community/full → NULL) gefaald:', /** @type {Error} */ (e).message); /* non-fatal */ }
}

// Seed a single €0 "Free" org plan once. New orgs auto-assign whichever
// plan carries is_default (see loginRoutes/oauthRoutes), so Free becomes
// the no-payment default tier and can be assigned from the admin Orgs view.
// Only runs when no Free org plan exists yet — never clobbers admin edits.
async function seedFreeOrgPlan() {
    try {
        // Skip if ANY free org tier already exists (a plan named 'Free' OR any
        // €0 org plan) — avoids seeding a duplicate when the operator has
        // already created their own free plan (e.g. "Bee Flow Free").
        const existingFree = await getOne(
            `SELECT id FROM subscription_plans
              WHERE (plan_type = 'organization' OR plan_type IS NULL)
                AND (name = 'Free' OR price = 0)
              LIMIT 1`
        );
        if (!existingFree) {
            const freeId = crypto.randomUUID();
            // Preserve the single-default invariant the admin CRUD enforces.
            await run(`UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE`);
            await run(
                `INSERT INTO subscription_plans (
                    id, name, plan_type, description, price, currency, billing_interval, billing_model,
                    markup_percent, trial_days, max_cost_per_month, max_users, max_agents, max_knowledge_sources,
                    allowed_features, allowed_models, allowed_integrations, allowed_beta_features,
                    is_public, is_default, nc_recommended, sort_order, created_at, updated_at
                 ) VALUES (
                    $1, 'Free', 'organization', 'Free tier — limited AI usage, no payment required.', 0, 'EUR', 'monthly', 'fixed',
                    0, 0, 5, 3, 1, 5,
                    '[]', '[]', '[]', '[]',
                    FALSE, TRUE, FALSE, 0, NOW(), NOW()
                 )`,
                [freeId]
            );
            log.info('[UserStore] seeded default Free org plan', freeId);
        }
    } catch (e) { log.warn('[UserStore] Free plan seed skipped:', /** @type {Error} */ (e).message); }
}

// ── Migration from JSON ─────────────────────────────
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

async function migrateJsonToDb() {
    await initDB();
    if (fs.existsSync(USERS_FILE)) {
        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            for (const [id, u] of Object.entries(users)) {
                const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
                if (!existing) {
                    const mwDek = u.masterWrappedDEK ? (typeof u.masterWrappedDEK === 'string' ? u.masterWrappedDEK : JSON.stringify(u.masterWrappedDEK)) : null;
                    const wDek = u.wrappedDEK ? (typeof u.wrappedDEK === 'string' ? u.wrappedDEK : JSON.stringify(u.wrappedDEK)) : null;
                    await run(`INSERT INTO users (id, username, "displayName", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt")
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,

                        [id, u.username, u.displayName || u.username, u.passwordHash, u.role || 'user',
                            JSON.stringify(u.groups || []), mwDek, wDek, '', '',
                            u.createdAt || new Date().toISOString().split('T')[0]]);
                    if (u.appPassword) {
                        await run('UPDATE users SET "appPassword" = $1, "appPasswordCreated" = $2 WHERE id = $3',
                            [typeof u.appPassword === 'object' ? JSON.stringify(u.appPassword) : u.appPassword, u.appPasswordCreated || new Date().toISOString(), id]);
                    }
                }
            }
            fs.renameSync(USERS_FILE, `${USERS_FILE}.bak`);
            log.info('[UserStore] Migrated users.json to database');
        } catch (err) { log.error('[UserStore] Failed to migrate users.json:', err); }
    }
    if (fs.existsSync(GROUPS_FILE)) {
        try {
            const groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            for (const [id, g] of Object.entries(groups)) {
                const ex = await getOne('SELECT id FROM groups WHERE id = $1', [id]);
                if (!ex) await run('INSERT INTO groups (id, "organizationId", name, description, permissions, roles, "userCount") VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [id, null, g.name, g.description || '', JSON.stringify(g.permissions || []), JSON.stringify(g.roles || []), g.userCount || 0]);
            }
            fs.renameSync(GROUPS_FILE, `${GROUPS_FILE}.bak`);
            log.info('[UserStore] Migrated groups.json to database');
        } catch (err) { log.error('[UserStore] Failed to migrate groups.json:', err); }
    }
    if (fs.existsSync(ROLES_FILE)) {
        try {
            const roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
            for (const [id, r] of Object.entries(roles)) {
                const ex = await getOne('SELECT id FROM roles WHERE id = $1', [id]);
                if (!ex) await run('INSERT INTO roles (id, name, description, permissions) VALUES ($1,$2,$3,$4)',
                    [id, r.name, r.description || '', JSON.stringify(r.permissions || [])]);
            }
            fs.renameSync(ROLES_FILE, `${ROLES_FILE}.bak`);
            log.info('[UserStore] Migrated roles.json to database');
        } catch (err) { log.error('[UserStore] Failed to migrate roles.json:', err); }
    }
}

migrateJsonToDb().catch(err => log.error('[UserStore] Migration error:', err.message));

module.exports = { initDB };
