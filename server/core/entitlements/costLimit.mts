/**
 * costLimit.mts: the monthly AI budget of one user on a self-hosted server.
 *
 * A user can carry their own limit (`users.monthly_cost_limit`). A group can
 * carry a per-member limit (`groups.per_user_cost_limit`): every member gets
 * that amount for themselves, it is not a pot the members share. NULL means
 * "no limit" at both levels. Pure functions only; the reads live in the user
 * store and the enforcement in `limits.js`.
 */

/** A limit as the database or a request holds it: a positive number, or nothing. */
export type CostLimitValue = number | null | undefined;

/** True for a number that can serve as a limit: finite and above zero. */
export function isValidCostLimit(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Turn a stored value (a REAL column may arrive as a number or a numeric
 * string, an empty field as null) into a usable limit, or null for "none".
 * Anything that is not a positive finite number counts as no limit.
 */
export function toCostLimit(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'string' ? Number(value) : value;
    return isValidCostLimit(n) ? n : null;
}

/**
 * The limit that applies to a user: their own when set, otherwise the highest
 * per-member limit among their groups, otherwise null (no limit). A group
 * without a limit is ignored, it does not lower the result.
 */
export function resolveEffectiveCostLimit(input: {
    userLimit: unknown;
    groupLimits: readonly unknown[];
}): number | null {
    const own = toCostLimit(input.userLimit);
    if (own !== null) return own;
    let best: number | null = null;
    for (const raw of input.groupLimits) {
        const limit = toCostLimit(raw);
        if (limit !== null && (best === null || limit > best)) best = limit;
    }
    return best;
}
