/**
 * What the usage and plan endpoints return.
 *
 * Written from the route handlers, not guessed: `/api/usage/summary` returns
 * SQL aggregate rows straight from Postgres (server/routes/usage.js +
 * stores/usageStore.js), the licence from routes/license.js and the consumer
 * plan from routes/subscriptions/consumerAccount.js.
 *
 * Numeric aggregates are typed `Numeric = number | string`. node-postgres
 * returns `bigint` and `numeric` columns as STRINGS (no type parser is
 * registered in server/db.js), so `COUNT(*)` and `SUM(estimated_cost)` arrive
 * as `"1423"` and `"18.4402"`. The web app coerces at every read site with
 * `Number(...)`; here `num()` in ./format.ts does it once.
 */

/** A Postgres aggregate as it actually arrives on the wire. */
export type Numeric = number | string;

/**
 * The usage window and its optional narrowing to one person.
 *
 * SCOPE IS NOT WHAT YOU MIGHT ASSUME. `/api/usage/*` scopes to the caller's
 * ORGANISATION when they belong to one (routes/usage.js `attachOrgFilter`), so
 * an ordinary member's default view is the whole company's spend, not their
 * own. Only an account with no organisation is force-scoped to itself. Passing
 * `?user=<id>` narrows to one person, which is how "just me" is built.
 */
export type UsageScope = { days: number; userId?: string | null };

export interface LicenseSummary {
    id: string;
    tier: string;
    issuer?: string;
    issuedAt?: string | null;
    expiresAt?: string | null;
    billingInterval?: string | null;
    lastRefreshAt?: string | null;
    refreshStatus?: string | null;
    revokedAt?: string | null;
    scope?: string | null;
}

/** `GET /api/license/status`. */
export interface LicenseStatus {
    tier: string;
    /** 'license_key' | 'stripe_subscription' | 'server_license' | 'default'. */
    source: string;
    scope?: string | null;
    license: LicenseSummary | null;
    subscription: { status?: string; planName?: string } | null;
    features: string[];
    limits: Record<string, number | null>;
    serverOverride?: boolean;
    serverLicense?: LicenseSummary | null;
}

/** `GET /api/subscriptions/consumer/usage`. */
export interface ConsumerUsage {
    limits: {
        max_messages_per_month: number | null;
        max_tokens_per_month: number | null;
        max_cost_per_month: number | null;
        max_agents: number | null;
        max_knowledge_sources: number | null;
        allowed_features: string[];
        allowed_models: string[];
        plan_name: string;
    };
    usage: {
        total_billed_cost: number;
        by_type: { agent_type?: string; billed_cost?: Numeric }[];
    };
    billing_period: { start: string; end: string };
    /** 'fixed' hides every €-per-token figure — the plan is flat-rate. */
    billing_model: string;
    subscription: {
        status: string;
        plan_name?: string;
        payment_status?: string;
        trial_end_date?: string | null;
        billing_model?: string;
    } | null;
}

/** `GET /api/usage/summary`. Members see only their own rows; the router
 *  scopes `userId` server-side for consumer accounts. */
export interface UsageSummary {
    total_calls: Numeric;
    total_tokens: Numeric;
    total_prompt_tokens: Numeric;
    total_completion_tokens: Numeric;
    total_cached_tokens?: Numeric;
    total_estimated_cost: Numeric;
    total_input_cost?: number;
    total_output_cost?: number;
    azure_services_total_cost?: number;
    combined_total_cost?: number;
    unique_models?: Numeric;
    unique_users?: Numeric;
    avg_duration_ms?: Numeric;
}

/** `GET /api/usage/cost-timeline?days=&interval=day`. */
export interface CostPoint {
    /** 'YYYY-MM-DD', or 'YYYY-MM-DD HH:00' when interval=hour. */
    period: string;
    calls: Numeric;
    total_cost: Numeric;
    total_billed_cost?: Numeric;
    prompt_tokens: Numeric;
    completion_tokens: Numeric;
}

/** `GET /api/usage/by-model?days=`. */
export interface ModelUsage {
    model: string;
    calls: Numeric;
    total_tokens: Numeric;
    prompt_tokens: Numeric;
    completion_tokens: Numeric;
    estimated_cost: Numeric;
    input_cost?: number;
    output_cost?: number;
}
