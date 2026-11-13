/**
 * One image generation, for every surface that makes images (the chat tool,
 * the one-shot chat route, the icon generator): pick the backend, check the
 * user's image limit, generate, and write the usage row.
 *
 * The usage row is what the limit counts (source `image_generation`, one row
 * per image) and what the usage pages price. An Azure image is priced at what
 * the admin entered for its deployment; without that price the tokens the API
 * reported are rated like any other call. A Google image keeps its row as it
 * was.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Backend =
    | { provider: 'google'; model: string; apiKey: string }
    | { provider: 'azure'; model: string; deployment: string; endpoint: string; apiKey: string; pricePerImage: number | null };

interface ImageModels {
    resolveImageBackend(requested?: string | null): Promise<Backend | null>;
    IMAGE_PRICE_CURRENCY: string;
}
interface ImageQuota {
    checkImageLimit(userId: string | null | undefined): Promise<{ window: string; limit: number; used: number; message: string } | null>;
}
interface AzureImages {
    generateAzureImage(input: { endpoint: string; apiKey: string; deployment: string; model: string; prompt: string; aspectRatio?: string | null }):
        Promise<{ imageBase64: string; mimeType: string; usage: { inputTokens: number; outputTokens: number } | null }>;
}
interface GoogleAdapter {
    generateImage(apiKey: string, prompt: string, options: { model?: string; aspectRatio?: string; thinkingLevel?: string }):
        Promise<{ text: string | null; imageBase64: string | null; mimeType: string | null }>;
}
interface UsageStore { logUsage(entry: Record<string, unknown>): Promise<unknown> }
interface Log { warn(...args: unknown[]): void; info(...args: unknown[]): void; textForLog(text: string): string }

/**
 * The collaborators, resolved at call time. An object so a test can replace
 * one (the exports of an .mts module cannot be mocked in place).
 */
export const seams = {
    imageModels: () => nodeRequire('./imageModels.mts') as ImageModels,
    imageQuota: () => nodeRequire('../entitlements/imageQuota.mts') as ImageQuota,
    azureImages: () => nodeRequire('../providers/azureImages.mts') as AzureImages,
    providers: () => nodeRequire('../providers') as { googleAdapter: GoogleAdapter },
    usageStore: () => nodeRequire('../../stores/usageStore') as UsageStore,
};
const log = () => nodeRequire('../../telemetry/log') as Log;

/** Why an image was not generated; `message` is safe to show to the user. */
export class ImageGenerationError extends Error {
    code: 'not_configured' | 'limit_reached' | 'no_image' | 'provider_error';
    status: number;
    constructor(code: ImageGenerationError['code'], message: string, status: number) {
        super(message);
        this.name = 'ImageGenerationError';
        this.code = code;
        this.status = status;
    }
}

/** Who a generation is billed to: the fields of core/tools/mediaUsage.js. */
export interface ImageUsageFields {
    user_id: string | null;
    organization_id: string | null;
    agent_id: string | null;
    agent_name: string | null;
    conversation_id: string | null;
}

export interface GeneratedImage {
    imageBase64: string;
    mimeType: string;
    text: string | null;
    /** The model the image was made with (the model id, not an Azure deployment name). */
    model: string;
    provider: 'google' | 'azure';
}

async function logImageUsage(who: ImageUsageFields, backend: Backend, prompt: string, usage: { inputTokens: number; outputTokens: number } | null) {
    const base = { ...who, model: backend.model, source: 'image_generation' };
    let entry: Record<string, unknown>;
    if (backend.provider === 'azure') {
        const tokens = usage || { inputTokens: 0, outputTokens: 0 };
        entry = {
            ...base,
            provider_type: 'azure',
            prompt_tokens: tokens.inputTokens,
            completion_tokens: tokens.outputTokens,
            total_tokens: tokens.inputTokens + tokens.outputTokens,
            ...(backend.pricePerImage !== null
                ? { unit_cost: { amount: backend.pricePerImage, currency: seams.imageModels().IMAGE_PRICE_CURRENCY } }
                : {}),
        };
    } else {
        entry = { ...base, prompt_tokens: prompt.length, completion_tokens: 0, total_tokens: prompt.length };
    }
    try {
        await seams.usageStore().logUsage(entry);
    } catch (e) {
        log().warn('[ImageGen] Failed to log usage:', e instanceof Error ? e.message : String(e));
    }
}

/**
 * Generate one image for a user.
 * Throws ImageGenerationError: nothing configured (503), the user's image
 * limit is used up (429), the provider failed or produced no image (502).
 */
export async function generateImage(input: {
    prompt: string;
    aspectRatio?: string | null;
    /** A Google model id or `azure/<deployment>`; the default backend when absent or unavailable. */
    model?: string | null;
    thinkingLevel?: string;
    who: ImageUsageFields;
}): Promise<GeneratedImage> {
    const backend = await seams.imageModels().resolveImageBackend(input.model);
    if (!backend) {
        throw new ImageGenerationError('not_configured', 'Image generation is not configured. An administrator can add a Google API key or an Azure image deployment in AI Config.', 503);
    }
    const reached = await seams.imageQuota().checkImageLimit(input.who.user_id);
    if (reached) throw new ImageGenerationError('limit_reached', reached.message, 429);

    const aspectRatio = input.aspectRatio || '1:1';
    log().info(`[ImageGen] ${backend.provider} ${backend.model} (${aspectRatio}): "${log().textForLog(input.prompt)}"`);

    let image: { imageBase64: string; mimeType: string; text: string | null };
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    if (backend.provider === 'azure') {
        let result;
        try {
            result = await seams.azureImages().generateAzureImage({
                endpoint: backend.endpoint, apiKey: backend.apiKey, deployment: backend.deployment,
                model: backend.model, prompt: input.prompt, aspectRatio,
            });
        } catch (e) {
            const known = e instanceof Error && e.name === 'AzureImageError';
            if (!known) log().warn('[ImageGen] Azure image generation failed:', e instanceof Error ? e.message : String(e));
            throw new ImageGenerationError(
                known && (e as { code?: string }).code === 'no_image' ? 'no_image' : 'provider_error',
                known ? (e as Error).message : 'Image generation failed. Try again.',
                502,
            );
        }
        image = { imageBase64: result.imageBase64, mimeType: result.mimeType, text: null };
        usage = result.usage;
    } else {
        const result = await seams.providers().googleAdapter.generateImage(backend.apiKey, input.prompt, {
            aspectRatio, model: backend.model, ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        });
        if (!result?.imageBase64) {
            throw new ImageGenerationError('no_image', 'No image was generated. Try a different prompt.', 502);
        }
        image = { imageBase64: result.imageBase64, mimeType: result.mimeType || 'image/png', text: result.text ?? null };
    }

    await logImageUsage(input.who, backend, input.prompt, usage);
    return { ...image, model: backend.model, provider: backend.provider };
}
