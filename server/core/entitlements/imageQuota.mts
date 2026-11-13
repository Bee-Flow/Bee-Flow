/**
 * The image limit of one user, checked before every image generation (see
 * imageLimit.mts for how the limits of user, group and organisation resolve).
 * Called from core/media/imageGeneration.mts, which every image path goes
 * through, so chat, agents, automations and the icon generator share one count.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type ImageWindow = 'hour' | 'day' | 'week' | 'month';
type ImageLimits = Partial<Record<ImageWindow, number>>;
type ImageCounts = Record<ImageWindow, number>;

// A plain require: the SPA's typecheck follows imports into this file, and an
// import path ending in .mts is an error there.
const { resolveEffectiveImageLimits, exceededImageWindow, IMAGE_WINDOW_MS } = nodeRequire('./imageLimit.mts') as {
    resolveEffectiveImageLimits(input: { userLimits: unknown; groupLimits: readonly unknown[]; orgLimits: unknown }): ImageLimits | null;
    exceededImageWindow(limits: ImageLimits | null, counts: ImageCounts): { window: ImageWindow; limit: number; used: number } | null;
    IMAGE_WINDOW_MS: Record<ImageWindow, number>;
};

interface UserStore {
    getImageLimitInputs(userId: string): Promise<{ userLimits: unknown; groupLimits: unknown[]; orgLimits: unknown }>;
}
interface UsageStore {
    getUserImageCounts(userId: string, windowMs: Record<ImageWindow, number>): Promise<ImageCounts>;
}
interface Log { warn(message: string): void }
interface HttpErrors { unavailable(code: string, message: string): Error }

// Resolved at call time so a test can swap the store's functions.
const userStore = () => nodeRequire('../../stores/userStore') as UserStore;
const usageStore = () => nodeRequire('../../stores/usageStore') as UsageStore;
const log = () => nodeRequire('../../telemetry/log') as Log;
const httpErrors = () => nodeRequire('../../shared/httpErrors') as HttpErrors;

const WINDOW_TEXT: Record<ImageWindow, string> = {
    hour: 'hour',
    day: '24 hours',
    week: '7 days',
    month: '30 days',
};

/** What a used-up limit looks like to the caller. */
export interface ImageLimitReached {
    window: ImageWindow;
    limit: number;
    used: number;
    message: string;
}

/** The limits that apply to a user and how much of each is used; null when no limit applies. */
export async function getImageQuota(userId: string): Promise<{ limits: ImageLimits; used: ImageCounts } | null> {
    const limits = resolveEffectiveImageLimits(await userStore().getImageLimitInputs(userId));
    if (!limits) return null;
    return { limits, used: await usageStore().getUserImageCounts(userId, IMAGE_WINDOW_MS) };
}

/**
 * The used-up limit of a user, or null when they may generate another image.
 * A call without a user (a system job) has no limit to check.
 *
 * Fails CLOSED, like the monthly AI budget: when the limits or the count
 * cannot be read this throws (503) instead of returning null, because null
 * would lift the limit for as long as the database hiccups.
 */
export async function checkImageLimit(userId: string | null | undefined): Promise<ImageLimitReached | null> {
    if (!userId) return null;
    try {
        const quota = await getImageQuota(userId);
        if (!quota) return null;
        const hit = exceededImageWindow(quota.limits, quota.used);
        if (!hit) return null;
        return {
            ...hit,
            message: `You have reached your image limit (${hit.limit} per ${WINDOW_TEXT[hit.window]}). Try again later or contact your administrator.`,
        };
    } catch (err) {
        log().warn(`[Limits] image limit lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        throw httpErrors().unavailable('image_limit_unavailable', 'Your image limit could not be checked');
    }
}
