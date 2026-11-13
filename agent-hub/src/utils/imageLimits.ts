/**
 * Image limits: how many images one user may generate per rolling window
 * (the server's core/entitlements/imageLimit.mts). Three levels carry the same
 * shape: the organisation's default, a per-member value on a group and the
 * user's own. A window left out is "not set" (the next level decides); 0 is
 * "no limit" on purpose, which lifts a lower level's limit.
 *
 * In the admin forms each window is a text input; on the wire it is a whole
 * number, and the whole object is null when no window is set.
 */

export const IMAGE_LIMIT_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
export type ImageLimitWindow = typeof IMAGE_LIMIT_WINDOWS[number];

/** The stored shape: only the windows that are set. */
export type ImageLimits = Partial<Record<ImageLimitWindow, number>>;

/** The form shape: one text per window, '' = not set. */
export type ImageLimitsInput = Record<ImageLimitWindow, string>;

/** What the server answers for a user: the limits that apply and how much of each is used. */
export interface ImageQuota {
    limits: ImageLimits;
    used: Partial<Record<ImageLimitWindow, number>>;
}

/** The highest value the server accepts per window. */
export const MAX_IMAGE_LIMIT = 1_000_000;

export const EMPTY_IMAGE_LIMITS_INPUT: ImageLimitsInput = Object.freeze({ hour: '', day: '', week: '', month: '' });

const isLimit = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_IMAGE_LIMIT;

/** The stored value as the texts the inputs show; anything unusable shows as not set. */
export function imageLimitsToInput(value: unknown): ImageLimitsInput {
    const out: ImageLimitsInput = { ...EMPTY_IMAGE_LIMITS_INPUT };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const window of IMAGE_LIMIT_WINDOWS) {
        const v = (value as Record<string, unknown>)[window];
        if (isLimit(v)) out[window] = String(v);
    }
    return out;
}

/**
 * The typed texts as the value to send: null when no window is set, an object
 * with the set windows otherwise, `undefined` when a text is not a whole
 * number from 0 to MAX_IMAGE_LIMIT.
 */
export function parseImageLimitsInput(input: ImageLimitsInput): ImageLimits | null | undefined {
    const out: ImageLimits = {};
    for (const window of IMAGE_LIMIT_WINDOWS) {
        const text = (input[window] ?? '').trim();
        if (text === '') continue;
        const n = Number(text);
        if (!isLimit(n)) return undefined;
        out[window] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/** True when a stored value sets at least one window (0 included). */
export function hasImageLimits(value: unknown): boolean {
    return parseImageLimitsInput(imageLimitsToInput(value)) !== null;
}

/** The windows of a quota that carry a real limit (above 0), shortest first. */
export function limitedWindows(quota: ImageQuota | null | undefined): Array<{ window: ImageLimitWindow; limit: number; used: number }> {
    if (!quota?.limits) return [];
    const rows: Array<{ window: ImageLimitWindow; limit: number; used: number }> = [];
    for (const window of IMAGE_LIMIT_WINDOWS) {
        const limit = quota.limits[window];
        if (typeof limit !== 'number' || limit <= 0) continue;
        const used = quota.used?.[window];
        rows.push({ window, limit, used: typeof used === 'number' && used > 0 ? used : 0 });
    }
    return rows;
}

/** The answer of /ai/user-settings as a quota, or null when it is not one. */
export function toImageQuota(value: unknown): ImageQuota | null {
    if (!value || typeof value !== 'object') return null;
    const q = value as { limits?: unknown; used?: unknown };
    if (!q.limits || typeof q.limits !== 'object') return null;
    const limits: ImageLimits = {};
    const used: Partial<Record<ImageLimitWindow, number>> = {};
    for (const window of IMAGE_LIMIT_WINDOWS) {
        const l = (q.limits as Record<string, unknown>)[window];
        if (isLimit(l)) limits[window] = l;
        const u = q.used && typeof q.used === 'object' ? (q.used as Record<string, unknown>)[window] : undefined;
        if (typeof u === 'number' && Number.isFinite(u)) used[window] = u;
    }
    return Object.keys(limits).length > 0 ? { limits, used } : null;
}
