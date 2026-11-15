/**
 * Can this model be shown a picture? The strict answer, for automations.
 *
 * Resolved through the STORED provider type and its adapter: every adapter in
 * core/providers/ answers `supportsVision(modelId)` from its own model catalog
 * (claudeModels, openaiModels, mistralModels, scaleway/ionos catalogs, the
 * local runtime's declared or guessed capabilities; Gemini is multimodal
 * throughout; EU GPT and the generic OpenAI-compatible adapter answer no).
 *
 * Unknown is NO. App Studio's modelSupportsVision (appStudio/aiRuntime.js)
 * fails open on a model no provider owns, because there a refused request is
 * the worst case. An automation step decides whether a picture LEAVES the
 * box, so a model nobody can vouch for gets the text read from the image
 * instead, and the step says so.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface VisionAdapter { supportsVision?: (modelId: string) => boolean }

export interface ModelVisionDeps {
    getProviderForModel?: (modelId: string) => Promise<{ providerType?: string | null; url?: string } | null | undefined>;
    getAdapter?: (providerType: string | null | undefined, url: string | undefined) => VisionAdapter | null | undefined;
    baseAdapter?: unknown;
}

/** Whether `modelId` takes image input on the provider that serves it. Never throws. */
export async function modelAcceptsImages(modelId: string | null | undefined, deps: ModelVisionDeps = {}): Promise<boolean> {
    if (!modelId) return false;
    try {
        const providers = nodeRequire('../providers') as { getAdapter: NonNullable<ModelVisionDeps['getAdapter']>; baseAdapter: unknown };
        const getProviderForModel = deps.getProviderForModel
            || ((id: string) => (nodeRequire('../aiAgent') as { getProviderForModel: NonNullable<ModelVisionDeps['getProviderForModel']> }).getProviderForModel(id));
        const getAdapter = deps.getAdapter || providers.getAdapter;
        const generic = 'baseAdapter' in deps ? deps.baseAdapter : providers.baseAdapter;
        const cfg = await getProviderForModel(modelId);
        const adapter = getAdapter(cfg?.providerType, cfg?.url);
        if (!adapter || adapter === generic || typeof adapter.supportsVision !== 'function') return false;
        return adapter.supportsVision(modelId) === true;
    } catch {
        return false;
    }
}
