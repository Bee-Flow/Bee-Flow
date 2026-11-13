/**
 * imageLimit.mts: how many images one user may generate per hour, day, week
 * and month.
 *
 * Three levels carry the same shape (`{ hour, day, week, month }`, each window
 * optional): the user's own limits (`users.image_limits`), a per-member limit
 * on a group (`groups.per_user_image_limits`, every member gets that amount
 * for themselves) and the organisation's default (`organizations.image_limits`).
 * They are resolved PER WINDOW: the user's own value, else the most generous
 * value among their groups, else the organisation's. A window nobody set has
 * no limit. `0` means "no limit" set on purpose: it stops the fall-through, so
 * one person or group can be exempt from the organisation's default.
 *
 * The windows are rolling (the last 60 minutes, 24 hours, 7 days, 30 days):
 * no time zone decides when a day starts, and a limit cannot be doubled by
 * generating on both sides of midnight. Pure functions only; the reads live in
 * imageQuota.mts.
 */

export const IMAGE_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
export type ImageWindow = typeof IMAGE_WINDOWS[number];

/** Limits as one level stores them: a whole number per window, 0 = no limit. */
export type ImageLimits = Partial<Record<ImageWindow, number>>;

/** Images generated inside each rolling window. */
export type ImageCounts = Record<ImageWindow, number>;

const HOUR_MS = 60 * 60 * 1000;

/** The length of each rolling window. */
export const IMAGE_WINDOW_MS: Record<ImageWindow, number> = {
    hour: HOUR_MS,
    day: 24 * HOUR_MS,
    week: 7 * 24 * HOUR_MS,
    month: 30 * 24 * HOUR_MS,
};

/** The highest limit one window accepts; a guard against a typo, not a product cap. */
export const MAX_IMAGE_LIMIT = 1_000_000;

/** True for a value one window can hold: a whole number from 0 to MAX_IMAGE_LIMIT. */
export function isValidImageLimit(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_IMAGE_LIMIT;
}

/**
 * Turn a stored value (a JSON text column, an object, or nothing) into limits,
 * or null when no window is set. A window that is not a valid whole number is
 * dropped: a damaged value never becomes a limit of its own making.
 */
export function toImageLimits(value: unknown): ImageLimits | null {
    let raw = value;
    if (typeof raw === 'string') {
        if (!raw.trim()) return null;
        try { raw = JSON.parse(raw); } catch { return null; }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: ImageLimits = {};
    for (const window of IMAGE_WINDOWS) {
        const v = (raw as Record<string, unknown>)[window];
        const n = typeof v === 'string' && v.trim() ? Number(v) : v;
        if (isValidImageLimit(n)) out[window] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/** The most generous of several values for one window; 0 (no limit) beats every number. */
function mostGenerous(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    return values.includes(0) ? 0 : Math.max(...values);
}

/**
 * The limits that apply to a user, per window: their own, else the most
 * generous among their groups, else the organisation's. Only windows with a
 * real limit (above 0) are returned; null when none applies.
 */
export function resolveEffectiveImageLimits(input: {
    userLimits: unknown;
    groupLimits: readonly unknown[];
    orgLimits: unknown;
}): ImageLimits | null {
    const own = toImageLimits(input.userLimits) || {};
    const groups = input.groupLimits.map(toImageLimits).filter((g): g is ImageLimits => g !== null);
    const org = toImageLimits(input.orgLimits) || {};
    const out: ImageLimits = {};
    for (const window of IMAGE_WINDOWS) {
        const fromGroups = mostGenerous(groups.map(g => g[window]).filter((v): v is number => v !== undefined));
        const limit = own[window] ?? fromGroups ?? org[window];
        if (limit !== undefined && limit > 0) out[window] = limit;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * The first window (shortest first) whose limit is used up, or null when the
 * user may generate another image.
 */
export function exceededImageWindow(
    limits: ImageLimits | null,
    counts: ImageCounts,
): { window: ImageWindow; limit: number; used: number } | null {
    if (!limits) return null;
    for (const window of IMAGE_WINDOWS) {
        const limit = limits[window];
        if (limit !== undefined && limit > 0 && counts[window] >= limit) {
            return { window, limit, used: counts[window] };
        }
    }
    return null;
}
