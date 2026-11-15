/**
 * The validator's `imageModels` fact for one automation definition: which of
 * the owner's model tiers, and the data-extraction model, can read an image
 * (core/llm/modelVision.mts). validate/stepRules/imageRules.mts refuses a
 * step with `images` on a model that cannot.
 *
 * Asked only when a step of the definition has `images`: every other
 * automation pays nothing. Null when there is nothing to ask or the lookup
 * fails: a missing fact never blocks, the run checks again and falls back to
 * the text read from the images.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface ImageModelsFact {
    tiers: Record<string, boolean>;
    dataExtraction: boolean | null;
}

export interface ImageModelsDeps {
    getUserTierMap?: (o: { userOrgId: string | null; userId: string }) => Promise<Record<string, { modelId?: string | null } | undefined>>;
    resolveDataExtractionModel?: (o: { userOrgId: string | null; userId: string }) => Promise<{ modelId?: string | null }>;
    modelAcceptsImages?: (modelId: string) => Promise<boolean>;
}

const MAX_DEPTH = 12;

/** Which step types with images the definition holds (root, layers, loop bodies, branches). */
export function imageStepTypes(definition: unknown): Set<string> {
    const found = new Set<string>();
    const walk = (v: unknown, depth: number) => {
        if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return;
        const rec = v as Record<string, unknown>;
        if ((rec.type === 'ai_step' || rec.type === 'data_extraction') && Array.isArray(rec.images) && rec.images.length) found.add(rec.type);
        for (const item of Array.isArray(v) ? v : Object.values(rec)) walk(item, depth + 1);
    };
    walk(definition, 0);
    return found;
}

type Who = { userOrgId: string | null; userId: string };

/** Whether each of the owner's tiers' models can read an image. */
async function tierVision(who: Who, accepts: (m: string) => Promise<boolean>, deps: ImageModelsDeps): Promise<Record<string, boolean>> {
    const getUserTierMap = deps.getUserTierMap
        || ((o: Who) => (nodeRequire('../core/llm/modelResolver') as { getUserTierMap: NonNullable<ImageModelsDeps['getUserTierMap']> }).getUserTierMap(o));
    const map = (await getUserTierMap(who)) || {};
    const tiers: Record<string, boolean> = {};
    for (const [key, tier] of Object.entries(map)) {
        if (tier?.modelId) tiers[key] = await accepts(tier.modelId);
    }
    return tiers;
}

/** Whether the data-extraction model can read an image; null when none is set. */
async function extractionVision(who: Who, accepts: (m: string) => Promise<boolean>, deps: ImageModelsDeps): Promise<boolean | null> {
    const resolve = deps.resolveDataExtractionModel
        || ((o: Who) => (nodeRequire('../core/automationRunner/dataExtractionModel') as { resolveDataExtractionModel: NonNullable<ImageModelsDeps['resolveDataExtractionModel']> }).resolveDataExtractionModel(o));
    const { modelId } = await resolve(who);
    return modelId ? accepts(modelId) : null;
}

export async function imageModelsFor(
    definition: unknown,
    { userId, orgId }: { userId: string | null | undefined; orgId: string | null | undefined },
    deps: ImageModelsDeps = {},
): Promise<ImageModelsFact | null> {
    const types = imageStepTypes(definition);
    if (!types.size || !userId) return null;
    try {
        const accepts = deps.modelAcceptsImages
            || ((id: string) => (nodeRequire('../core/llm/modelVision.mts') as { modelAcceptsImages: (m: string) => Promise<boolean> }).modelAcceptsImages(id));
        const who = { userOrgId: orgId || null, userId };
        return {
            tiers: types.has('ai_step') ? await tierVision(who, accepts, deps) : {},
            dataExtraction: types.has('data_extraction') ? await extractionVision(who, accepts, deps) : null,
        };
    } catch {
        return null;
    }
}

/** The fact for a stored automation: its owner and organisation (the caller as owner when the row has none). */
export function imageModelsForAutomation(
    definition: unknown,
    automation: { userId?: string | null; organizationId?: string | null },
    fallbackUserId: string | null | undefined,
): Promise<ImageModelsFact | null> {
    return imageModelsFor(definition, { userId: automation.userId || fallbackUserId, orgId: automation.organizationId || null });
}
