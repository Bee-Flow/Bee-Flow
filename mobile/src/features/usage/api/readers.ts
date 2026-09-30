/**
 * Contract readers for the usage, licence and plan payloads.
 *
 * Aggregates keep their wire type (`Numeric`): a Postgres count arrives as a
 * string, and `num()` coerces it where it is read, exactly as before the
 * readers existed. What the readers add is the allow-list and a stated default
 * for a field the server dropped.
 */

import { field, nullable, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    ConsumerUsage,
    CostPoint,
    LicenseStatus,
    LicenseSummary,
    ModelUsage,
    Numeric,
    UsageSummary,
} from '../model/types';

/** A count or amount as sent: number or numeric string, else absent. */
function optNumeric(value: unknown): Numeric | undefined {
    return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

/** A required aggregate; a missing one reads as 0, which is what num() made of it. */
function numeric(value: unknown): Numeric {
    return optNumeric(value) ?? 0;
}

const readLicenseSummary: (raw: unknown) => LicenseSummary = shapeOf({
    id: field.str(''),
    tier: field.str(''),
    issuer: field.optStr,
    issuedAt: field.strOrNull,
    expiresAt: field.strOrNull,
    billingInterval: field.strOrNull,
    lastRefreshAt: field.strOrNull,
    refreshStatus: field.strOrNull,
    revokedAt: field.strOrNull,
    scope: field.strOrNull,
});

const readSubscriptionSummary = shapeOf({ status: field.optStr, planName: field.optStr });

export const readLicenseStatus: (raw: unknown) => LicenseStatus | null = nullable(
    shapeOf({
        tier: field.str('community'),
        source: field.str('default'),
        scope: field.strOrNull,
        license: nullable(readLicenseSummary),
        subscription: nullable(readSubscriptionSummary),
        features: field.strArray,
        limits: field.record<Record<string, number | null>>({}),
        serverOverride: field.optBool,
        serverLicense: nullable(readLicenseSummary),
    }),
);

const readConsumerLimits = shapeOf({
    max_messages_per_month: field.numOrNull,
    max_tokens_per_month: field.numOrNull,
    max_cost_per_month: field.numOrNull,
    max_agents: field.numOrNull,
    max_knowledge_sources: field.numOrNull,
    allowed_features: field.strArray,
    allowed_models: field.strArray,
    // The server's own fallback name (consumerAccount.js).
    plan_name: field.str('Free'),
});

const readConsumerTotals = shapeOf({
    total_billed_cost: field.num(0),
    by_type: field.list(shapeOf({ agent_type: field.optStr, billed_cost: optNumeric })),
});

const readConsumerSubscription = shapeOf({
    status: field.str(''),
    plan_name: field.optStr,
    payment_status: field.optStr,
    trial_end_date: field.strOrNull,
    billing_model: field.optStr,
});

export const readConsumerUsage: (raw: unknown) => ConsumerUsage | null = nullable(
    shapeOf({
        limits: readConsumerLimits,
        usage: readConsumerTotals,
        billing_period: shapeOf({ start: field.str(''), end: field.str('') }),
        // The server's default when a plan names none.
        billing_model: field.str('fixed'),
        subscription: nullable(readConsumerSubscription),
    }),
);

export const readUsageSummary: (raw: unknown) => UsageSummary | null = nullable(
    shapeOf({
        total_calls: numeric,
        total_tokens: numeric,
        total_prompt_tokens: numeric,
        total_completion_tokens: numeric,
        total_cached_tokens: optNumeric,
        total_estimated_cost: numeric,
        total_input_cost: field.optNum,
        total_output_cost: field.optNum,
        azure_services_total_cost: field.optNum,
        combined_total_cost: field.optNum,
        unique_models: optNumeric,
        unique_users: optNumeric,
        avg_duration_ms: optNumeric,
    }),
);

export const readCostTimeline: (raw: unknown) => CostPoint[] = shapeListOf({
    period: field.str(''),
    calls: numeric,
    total_cost: numeric,
    total_billed_cost: optNumeric,
    prompt_tokens: numeric,
    completion_tokens: numeric,
});

export const readModelUsage: (raw: unknown) => ModelUsage[] = shapeListOf({
    model: field.str(''),
    calls: numeric,
    total_tokens: numeric,
    prompt_tokens: numeric,
    completion_tokens: numeric,
    estimated_cost: numeric,
    input_cost: field.optNum,
    output_cost: field.optNum,
});
