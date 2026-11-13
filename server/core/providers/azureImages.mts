/**
 * Image generation on Microsoft Foundry (Azure AI Foundry).
 *
 * Two API shapes, told apart by the MODEL behind the deployment (verified
 * against Microsoft Learn, 2026-11-13):
 *
 *   - OpenAI image models (gpt-image-1, -1-mini, -1.5, -2, -2.5-*): the v1
 *     Image API, `POST <endpoint>/openai/v1/images/generations?api-version=preview`
 *     ("How to use image generation models from OpenAI"). The deployment name
 *     goes in the body as `model`; the answer is always base64 (`data[].b64_json`).
 *     Sizes are the three every model of the family accepts.
 *   - MAI image models (MAI-Image-2.5, -2.6, ...): `POST <endpoint>/mai/v1/images/generations`
 *     ("Deploy and use MAI image models"), with `width` / `height` (at least
 *     768 each, at most 1024x1024 pixels in total on the 2.5 models), always PNG.
 *
 * Both take the key in the `api-key` header. FLUX models are NOT served here:
 * FLUX.2 only answers on the Black Forest Labs provider route, whose response
 * shape Microsoft does not document.
 *
 * The request goes through the SSRF guard (`safeFetch`): the endpoint is an
 * admin-typed URL.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type AzureImageFamily = 'openai' | 'mai' | 'flux';

/** Which API a model is served on. Unknown ids are treated as OpenAI image models. */
export function azureImageFamily(model: string): AzureImageFamily {
    const id = String(model || '').trim().toLowerCase();
    if (id.startsWith('mai-image')) return 'mai';
    if (id.startsWith('flux')) return 'flux';
    return 'openai';
}

type Shape = 'square' | 'landscape' | 'portrait';

/** '16:9' is landscape, '3:4' portrait, anything else (or nothing) square. */
function shapeOf(aspectRatio: string | null | undefined): Shape {
    const [w, h] = String(aspectRatio || '').split(':').map(Number);
    if (!(w > 0) || !(h > 0) || w === h) return 'square';
    return w > h ? 'landscape' : 'portrait';
}

/** The three sizes every gpt-image model accepts. */
const OPENAI_SIZES: Record<Shape, string> = {
    square: '1024x1024',
    landscape: '1536x1024',
    portrait: '1024x1536',
};

/** MAI: each edge at least 768, and inside the 1024x1024 pixel budget of the 2.5 models. */
const MAI_SIZES: Record<string, [number, number]> = {
    '1:1': [1024, 1024],
    '16:9': [1360, 768],
    '9:16': [768, 1360],
    '4:3': [1152, 864],
    '3:4': [864, 1152],
};

export interface AzureImageRequest {
    url: string;
    body: Record<string, unknown>;
}

/** The URL and JSON body of one generation. Throws for a model this adapter does not serve. */
export function buildAzureImageRequest(input: {
    endpoint: string;
    deployment: string;
    model: string;
    prompt: string;
    aspectRatio?: string | null;
}): AzureImageRequest {
    const family = azureImageFamily(input.model);
    if (family === 'flux') {
        throw new AzureImageError('unsupported_model', 'FLUX models are not supported for image generation yet. Use a GPT-Image or MAI-Image deployment.');
    }
    if (family === 'mai') {
        const origin = new URL(String(input.endpoint).trim()).origin;
        const [width, height] = MAI_SIZES[String(input.aspectRatio || '1:1')] || MAI_SIZES['1:1'];
        return {
            url: `${origin}/mai/v1/images/generations`,
            body: { model: input.deployment, prompt: input.prompt, width, height },
        };
    }
    const { toV1BaseUrl } = nodeRequire('../../utils/azureUrl') as { toV1BaseUrl(endpoint: string): string };
    return {
        url: `${toV1BaseUrl(input.endpoint)}/images/generations?api-version=preview`,
        body: { model: input.deployment, prompt: input.prompt, n: 1, size: OPENAI_SIZES[shapeOf(input.aspectRatio)] },
    };
}

/** A failed generation, with a message that is safe to show. */
export class AzureImageError extends Error {
    code: string;
    status: number | undefined;
    constructor(code: string, message: string, status?: number) {
        super(message);
        this.name = 'AzureImageError';
        this.code = code;
        this.status = status;
    }
}

export interface AzureImageResult {
    imageBase64: string;
    mimeType: string;
    /** Tokens as the API reported them (gpt-image models), or null. */
    usage: { inputTokens: number; outputTokens: number } | null;
}

const CONTENT_FILTER_CODES = new Set(['contentfilter', 'content_filter', 'content_policy_violation', 'moderation_blocked', 'responsibleaipolicyviolation']);

/** Turn a non-2xx answer into an error the user can act on. */
function errorFrom(status: number, payload: unknown): AzureImageError {
    const err = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = String(err?.code || '').toLowerCase();
    if (CONTENT_FILTER_CODES.has(code)) {
        return new AzureImageError('content_filtered', 'The image was blocked by the content filter. Try a different prompt.', status);
    }
    if (status === 401 || status === 403) {
        return new AzureImageError('unauthorized', 'Azure refused the API key for image generation.', status);
    }
    if (status === 404) {
        return new AzureImageError('deployment_not_found', 'Azure does not know this image deployment. Check its name in AI Config.', status);
    }
    if (status === 429) {
        return new AzureImageError('rate_limited', 'Azure is rate limiting image generation. Try again in a moment.', status);
    }
    const detail = typeof err?.message === 'string' ? `: ${err.message.slice(0, 300)}` : '';
    return new AzureImageError('provider_error', `Azure image generation failed (HTTP ${status})${detail}`, status);
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Read the image and the usage out of a 200 answer of either API. */
export function parseAzureImageResponse(payload: unknown): AzureImageResult {
    const doc = payload as { data?: Array<{ b64_json?: unknown }>; usage?: { input_tokens?: unknown; output_tokens?: unknown }; output_format?: unknown; error?: unknown } | null;
    if (doc?.error) throw errorFrom(200, doc);
    const b64 = doc?.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) {
        throw new AzureImageError('no_image', 'Azure returned no image. Try a different prompt.');
    }
    const usage = doc?.usage && typeof doc.usage === 'object'
        ? { inputTokens: count(doc.usage.input_tokens), outputTokens: count(doc.usage.output_tokens) }
        : null;
    const mimeType = doc?.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return { imageBase64: b64, mimeType, usage: usage && (usage.inputTokens || usage.outputTokens) ? usage : null };
}

interface FetchResponse { ok: boolean; status: number; json(): Promise<unknown> }
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<FetchResponse>;

/** How long one generation may take; the high-quality models need well over a minute. */
const TIMEOUT_MS = 180_000;

/**
 * Generate one image on a Foundry deployment.
 * `fetchImpl` is the injection point for the tests; production uses safeFetch.
 */
export async function generateAzureImage(input: {
    endpoint: string;
    apiKey: string;
    deployment: string;
    model: string;
    prompt: string;
    aspectRatio?: string | null;
    fetchImpl?: FetchLike;
}): Promise<AzureImageResult> {
    const request = buildAzureImageRequest(input);
    const doFetch: FetchLike = input.fetchImpl
        || (nodeRequire('../http/ssrfGuard') as { safeFetch: FetchLike }).safeFetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: FetchResponse;
    try {
        res = await doFetch(request.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': input.apiKey },
            body: JSON.stringify(request.body),
            signal: controller.signal,
        });
    } catch (err) {
        if (controller.signal.aborted) throw new AzureImageError('timeout', 'Azure took too long to generate the image. Try again.');
        throw new AzureImageError('unreachable', `Azure image generation could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        clearTimeout(timer);
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw errorFrom(res.status, payload);
    return parseAzureImageResponse(payload);
}
