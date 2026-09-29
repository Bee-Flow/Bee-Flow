// @typecheck
// Subscription plans — catalogue CRUD, allow-list serialisation, and the
// NC-recommended plan lookup.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { dynamicUpdate, parseJSON } = require('./shared');
const log = require('../../telemetry/log');

// ── Subscription Plans ─────────────────────────────
function parsePlan(p) {
    return {
        ...p,
        allowed_features: parseJSON(p.allowed_features, []),
        allowed_models: parseJSON(p.allowed_models, []),
        // null in DB = unrestricted; only parse when explicitly set so the
        // distinction between "all integrations" and "zero integrations"
        // survives a round-trip.
        allowed_integrations: p.allowed_integrations == null ? null : parseJSON(p.allowed_integrations, null),
        allowed_beta_features: p.allowed_beta_features == null ? null : parseJSON(p.allowed_beta_features, null),
        max_messages_by_type: parseJSON(p.max_messages_by_type, {}),
        is_default: !!p.is_default,
        is_public: !!p.is_public,
        plan_type: p.plan_type || 'organization',
        nc_recommended: !!p.nc_recommended,
        nc_only: !!p.nc_only,
        tagline: p.tagline || null,
        billing_model: p.billing_model || 'fixed',
        markup_percent: p.markup_percent == null ? 0 : Number(p.markup_percent),
        stripe_meter_id: p.stripe_meter_id || null,
        stripe_meter_event_name: p.stripe_meter_event_name || null,
        per_seat: !!p.per_seat,
        max_messages_per_seat: p.max_messages_per_seat ?? null,
    };
}

function serializeAllowList(v) {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (!Array.isArray(v)) throw new Error('allow-list must be an array or null');
    return JSON.stringify(v);
}

async function getAllPlans() {
    await initDB();
    const rows = await getAll('SELECT * FROM subscription_plans ORDER BY sort_order ASC, name ASC');
    return rows.map(parsePlan);
}

async function getPlan(planId) {
    await initDB();
    const p = await getOne('SELECT * FROM subscription_plans WHERE id = $1', [planId]);
    if (!p) return null;
    return parsePlan(p);
}

// Used by the Nextcloud connector bootstrap to grant freshly-provisioned NC
// orgs the entitlements the SaaS operator has flagged as "NC default" (via
// the nc_recommended boolean on subscription_plans). Returns null when no
// plan is flagged — caller treats that as graceful degradation to the
// community fallback.
async function getDefaultNcPlan() {
    await initDB();
    const p = await getOne(`SELECT * FROM subscription_plans
                              WHERE nc_recommended = TRUE
                           ORDER BY price ASC NULLS LAST, sort_order ASC
                              LIMIT 1`);
    if (!p) return null;
    return parsePlan(p);
}

async function createPlan(data) {
    await initDB();
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
        throw new Error('Plan name is required');
    }
    if (data.tier !== undefined && data.tier !== null && data.tier !== '' && !['pro', 'enterprise'].includes(data.tier)) {
        // 'community' and 'full' are reserved for license-key activations on
        // self-hosted installs. Cloud subscription plans use 'pro',
        // 'enterprise', or NULL (Free); the resolver's community floor still
        // covers NULL-tier subscribers transparently.
        throw new Error(`Invalid tier '${data.tier}' for subscription plan. Allowed: 'pro', 'enterprise', or empty. ('community' and 'full' are license-key only.)`);
    }
    if (data.tier === '') data.tier = null;
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    try {
        if (data.is_default) await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
        if (data.nc_recommended) await run('UPDATE subscription_plans SET nc_recommended = FALSE WHERE nc_recommended = TRUE');
        await run(`INSERT INTO subscription_plans (id, name, description, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, allowed_integrations, allowed_beta_features, is_default, price, currency, billing_interval, trial_days, sort_order, is_public, stripe_price_id, stripe_product_id, plan_type, nc_recommended, nc_only, tagline, tier, billing_model, markup_percent, stripe_meter_id, stripe_meter_event_name, per_seat, max_messages_per_seat, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)`,
            [id, data.name.trim(), data.description || '', data.max_messages_per_month ?? null, JSON.stringify(data.max_messages_by_type || {}),
                data.max_tokens_per_month ?? null, data.max_cost_per_month ?? null, data.max_users ?? null, data.max_agents ?? null,
                data.max_knowledge_sources ?? null, JSON.stringify(data.allowed_features || []), JSON.stringify(data.allowed_models || []),
                serializeAllowList(data.allowed_integrations) ?? null,
                serializeAllowList(data.allowed_beta_features) ?? null,
                !!data.is_default, data.price ?? null, data.currency || 'EUR', data.billing_interval || 'monthly',
                data.trial_days ?? 0, data.sort_order ?? 0, !!data.is_public,
                data.stripe_price_id || null, data.stripe_product_id || null, data.plan_type || 'organization',
                !!data.nc_recommended, !!data.nc_only, data.tagline || null, data.tier || null,
                data.billing_model || 'fixed', data.markup_percent ?? 0,
                data.stripe_meter_id || null, data.stripe_meter_event_name || null,
                !!data.per_seat, data.max_messages_per_seat ?? null,
                now, now]);
        return parsePlan(await getOne('SELECT * FROM subscription_plans WHERE id = $1', [id]));
    } catch (e) { log.error('[UserStore] createPlan error:', e); return null; }
}

async function updatePlan(planId, data) {
    await initDB();
    if (!(await getOne('SELECT id FROM subscription_plans WHERE id = $1', [planId]))) return false;
    if (data.name !== undefined && (!data.name || typeof data.name !== 'string' || !data.name.trim())) {
        throw new Error('Plan name cannot be empty');
    }
    const now = new Date().toISOString();
    try {
        if (data.is_default) await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
        if (data.nc_recommended) await run('UPDATE subscription_plans SET nc_recommended = FALSE WHERE nc_recommended = TRUE AND id <> $1', [planId]);
        const updateMap = {};
        if (data.name !== undefined) updateMap.name = data.name.trim();
        if (data.description !== undefined) updateMap.description = data.description;
        if (data.max_messages_per_month !== undefined) updateMap.max_messages_per_month = data.max_messages_per_month;
        if (data.max_messages_by_type !== undefined) updateMap.max_messages_by_type = JSON.stringify(data.max_messages_by_type);
        if (data.max_tokens_per_month !== undefined) updateMap.max_tokens_per_month = data.max_tokens_per_month;
        if (data.max_cost_per_month !== undefined) updateMap.max_cost_per_month = data.max_cost_per_month;
        if (data.max_users !== undefined) updateMap.max_users = data.max_users;
        if (data.max_agents !== undefined) updateMap.max_agents = data.max_agents;
        if (data.max_knowledge_sources !== undefined) updateMap.max_knowledge_sources = data.max_knowledge_sources;
        if (data.allowed_features !== undefined) updateMap.allowed_features = JSON.stringify(data.allowed_features);
        if (data.allowed_models !== undefined) updateMap.allowed_models = JSON.stringify(data.allowed_models);
        if (data.allowed_integrations !== undefined) updateMap.allowed_integrations = serializeAllowList(data.allowed_integrations);
        if (data.allowed_beta_features !== undefined) updateMap.allowed_beta_features = serializeAllowList(data.allowed_beta_features);
        if (data.billing_model !== undefined) updateMap.billing_model = data.billing_model;
        if (data.markup_percent !== undefined) updateMap.markup_percent = data.markup_percent;
        if (data.stripe_meter_id !== undefined) updateMap.stripe_meter_id = data.stripe_meter_id;
        if (data.stripe_meter_event_name !== undefined) updateMap.stripe_meter_event_name = data.stripe_meter_event_name;
        if (data.per_seat !== undefined) updateMap.per_seat = !!data.per_seat;
        if (data.max_messages_per_seat !== undefined) updateMap.max_messages_per_seat = data.max_messages_per_seat;
        if (data.is_default !== undefined) updateMap.is_default = !!data.is_default;
        if (data.price !== undefined) updateMap.price = data.price;
        if (data.currency !== undefined) updateMap.currency = data.currency;
        if (data.billing_interval !== undefined) updateMap.billing_interval = data.billing_interval;
        if (data.trial_days !== undefined) updateMap.trial_days = data.trial_days;
        if (data.sort_order !== undefined) updateMap.sort_order = data.sort_order;
        if (data.is_public !== undefined) updateMap.is_public = !!data.is_public;
        if (data.stripe_price_id !== undefined) updateMap.stripe_price_id = data.stripe_price_id;
        if (data.stripe_product_id !== undefined) updateMap.stripe_product_id = data.stripe_product_id;
        if (data.nc_recommended !== undefined) updateMap.nc_recommended = !!data.nc_recommended;
        if (data.nc_only !== undefined) updateMap.nc_only = !!data.nc_only;
        if (data.tagline !== undefined) updateMap.tagline = data.tagline;
        if (data.tier !== undefined) {
            if (data.tier !== null && data.tier !== '' && !['pro', 'enterprise'].includes(data.tier)) {
                throw new Error(`Invalid tier '${data.tier}' for subscription plan. Allowed: 'pro', 'enterprise', or empty. ('community' and 'full' are license-key only.)`);
            }
            updateMap.tier = data.tier === '' ? null : data.tier;
        }
        updateMap.updated_at = now;
        if (data.plan_type !== undefined) updateMap.plan_type = data.plan_type;
        const colMap = { name: 'name', description: 'description', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', allowed_integrations: 'allowed_integrations', allowed_beta_features: 'allowed_beta_features', is_default: 'is_default', price: 'price', currency: 'currency', billing_interval: 'billing_interval', trial_days: 'trial_days', sort_order: 'sort_order', is_public: 'is_public', stripe_price_id: 'stripe_price_id', stripe_product_id: 'stripe_product_id', plan_type: 'plan_type', nc_recommended: 'nc_recommended', nc_only: 'nc_only', tagline: 'tagline', tier: 'tier', billing_model: 'billing_model', markup_percent: 'markup_percent', stripe_meter_id: 'stripe_meter_id', stripe_meter_event_name: 'stripe_meter_event_name', per_seat: 'per_seat', max_messages_per_seat: 'max_messages_per_seat', updated_at: 'updated_at' };
        const q = dynamicUpdate('subscription_plans', planId, updateMap, colMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { log.error('[UserStore] updatePlan error:', e); return false; }
}

class PlanInUseError extends Error {
    constructor(planId, affectedOrgs, affectedConsumers) {
        super(`Plan ${planId} is in use by ${affectedOrgs.length} org(s) and ${affectedConsumers.length} consumer(s)`);
        this.name = 'PlanInUseError';
        this.planId = planId;
        this.affectedOrgs = affectedOrgs;
        this.affectedConsumers = affectedConsumers;
    }
}

async function deletePlan(planId) {
    await initDB();
    // Refuse to delete a plan that has live subscriptions. Previously this
    // nulled plan_id on org_subscriptions and orphaned the rows so
    // getEffectiveLimits returned a partially-populated shape — which then
    // cascades into undefined gating behaviour. Force the admin to migrate
    // affected subscriptions first.
    const orgs = await getAll(
        `SELECT organization_id FROM organization_subscriptions
          WHERE plan_id = $1 AND COALESCE(status,'active') IN ('active','trialing','past_due')`,
        [planId]
    );
    const consumers = await getAll(
        `SELECT user_id FROM consumer_subscriptions
          WHERE plan_id = $1 AND COALESCE(status,'active') IN ('active','trialing','past_due')`,
        [planId]
    );
    if (orgs.length > 0 || consumers.length > 0) {
        throw new PlanInUseError(planId, orgs.map(r => r.organization_id), consumers.map(r => r.user_id));
    }
    const { rowCount } = await run('DELETE FROM subscription_plans WHERE id = $1', [planId]);
    return rowCount > 0;
}

module.exports = {
    getAllPlans, getPlan, getDefaultNcPlan, createPlan, updatePlan, deletePlan,
    PlanInUseError,
};
