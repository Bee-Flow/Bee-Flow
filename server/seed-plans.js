const db = require('./db');
(async () => {
    try {
        const tables = await db.getAll(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%plan%'"
        );
        log.info('plan tables:', tables.map(t => t.table_name));
        const tbl = tables.find(t => /^(plans|subscription_plans)$/i.test(t.table_name));
        if (!tbl) { log.error('No plans table found'); process.exit(1); }
        const TABLE = tbl.table_name;
        log.info('Using table:', TABLE);

        const cols = await db.getAll(
            "SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
            [TABLE]
        );
        log.info('columns:', cols.map(c => c.column_name).join(', '));

        // Hide all current plans from the wizard (FK constraints prevent
        // a clean DELETE — existing org_subscriptions reference them).
        await db.run(`UPDATE ${TABLE} SET is_public = false`);
        log.info('hid existing plans');

        // Upsert the 2 production plans we actually want to expose.
        const upsert = async (id, name, price, trial, stripeId) => {
            await db.run(
                `INSERT INTO ${TABLE} (id, name, plan_type, description, price, currency, billing_interval, trial_days, allowed_features, is_public, is_default, nc_recommended, stripe_price_id, created_at, updated_at)
                 VALUES ($1, $2, 'organization', '', $3, 'EUR', 'monthly', $4, '[]', true, false, false, $5, NOW(), NOW())
                 ON CONFLICT (id) DO UPDATE SET
                   name = EXCLUDED.name,
                   price = EXCLUDED.price,
                   trial_days = EXCLUDED.trial_days,
                   stripe_price_id = COALESCE(EXCLUDED.stripe_price_id, ${TABLE}.stripe_price_id),
                   is_public = true,
                   updated_at = NOW()`,
                [id, name, price, trial, stripeId]
            );
        };
        // The Stripe price ids belong to the operator's own Stripe account, so they
        // come from the environment. Unset keeps whatever the row already has: a
        // re-run without them must never unlink a live plan from its price.
        const beeFlowPrice = process.env.STRIPE_PRICE_ID_BEE_FLOW || null;
        const enterprisePrice = process.env.STRIPE_PRICE_ID_ENTERPRISE || null;
        if (!beeFlowPrice || !enterprisePrice) {
            log.warn('STRIPE_PRICE_ID_BEE_FLOW / STRIPE_PRICE_ID_ENTERPRISE not set: existing stripe_price_id values are kept, new rows get none');
        }
        await upsert('2852d756-411c-4459-b335-84878566732a', 'Bee Flow',   30, 14, beeFlowPrice);
        await upsert('d27181cf-f4b4-4da3-919a-2e2c3be43bb1', 'Enterprise', 50, 0,  enterprisePrice);

        // Ensure exactly one default org plan survives a re-run (BFSF-226):
        // without an is_default row, createOrganization assigns no subscription
        // and new orgs end up uncapped. Promote the Free/€0 org plan, creating
        // it when missing — same logic as migrations/default-org-plan-2026-06.
        const hasDefault = await db.getOne(`SELECT id FROM ${TABLE} WHERE is_default = TRUE LIMIT 1`);
        if (!hasDefault) {
            const free = await db.getOne(
                `SELECT id FROM ${TABLE}
                  WHERE (plan_type = 'organization' OR plan_type IS NULL)
                    AND (name = 'Free' OR price = 0)
                  ORDER BY (name = 'Free') DESC, created_at ASC
                  LIMIT 1`
            );
            if (free) {
                await db.run(`UPDATE ${TABLE} SET is_default = FALSE WHERE is_default = TRUE`);
                await db.run(`UPDATE ${TABLE} SET is_default = TRUE, updated_at = NOW() WHERE id = $1`, [free.id]);
                log.info('promoted Free plan to default:', free.id);
            } else {
                const freeId = require('crypto').randomUUID();
                await db.run(
                    `INSERT INTO ${TABLE} (
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
                log.info('created default Free plan:', freeId);
            }
        }

        const after = await db.getAll(`SELECT id, name, price FROM ${TABLE} WHERE is_public = true ORDER BY price`);
        log.info('now:', after);
        process.exit(0);
    } catch (e) {
        log.error('ERR:', e.message);
        process.exit(1);
    }
})();
const log = require('./telemetry/log');
