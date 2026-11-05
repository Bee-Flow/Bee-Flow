/**
 * The self-hosted monthly AI budget of one user (see costLimit.mts for how the
 * limit is resolved). Called from checkSubscriptionLimits in limits.js, which
 * every chat surface goes through.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

// A plain require: the SPA's typecheck follows imports into this file, and an
// import path ending in .mts is an error there.
const { resolveEffectiveCostLimit } = nodeRequire('./costLimit.mts') as {
    resolveEffectiveCostLimit(input: { userLimit: unknown; groupLimits: readonly unknown[] }): number | null;
};

interface UserStore {
    getCostLimitInputs(userId: string): Promise<{ userLimit: number | null; groupLimits: number[] }>;
}
interface UsageStore {
    getUsageSummary(filters: { startDate: string; endDate: string; userId: string }): Promise<{ total_estimated_cost?: unknown } | null>;
}
interface Log { warn(message: string): void }
interface HttpErrors { unavailable(code: string, message: string): Error }

// Resolved at call time so a test can swap the store's functions.
const userStore = () => nodeRequire('../../stores/userStore') as UserStore;
const usageStore = () => nodeRequire('../../stores/usageStore') as UsageStore;
const log = () => nodeRequire('../../telemetry/log') as Log;
const httpErrors = () => nodeRequire('../../shared/httpErrors') as HttpErrors;

/**
 * Self-hosted monthly AI budget of one user: their own limit, else the highest
 * per-member limit of their groups, else none. Usage is everything the user
 * spent this calendar month on this server (no organisation filter).
 *
 * Fails CLOSED: when the limit or the usage cannot be read this throws
 * (503) instead of returning null, because null would lift the limit for as
 * long as the database hiccups. This matches limits.js, where the cost query of
 * the cloud path also propagates its error rather than allowing.
 *
 * @returns the message to show when the budget is used up, null otherwise
 */
export async function checkSelfHostedUserLimit(userId: string): Promise<string | null> {
    try {
        const limit = resolveEffectiveCostLimit(await userStore().getCostLimitInputs(userId));
        if (limit === null) return null;
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const summary = await usageStore().getUsageSummary({ startDate, endDate: now.toISOString(), userId });
        if (Number(summary?.total_estimated_cost || 0) >= limit) {
            return `You have reached your monthly AI budget (€${limit.toFixed(2)}). Contact your administrator.`;
        }
        return null;
    } catch (err) {
        log().warn(`[Limits] self-hosted budget lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        throw httpErrors().unavailable('cost_limit_unavailable', 'Your AI budget could not be checked');
    }
}
