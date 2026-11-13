/**
 * The image models this server can generate with.
 *
 * Google's two image models are available with the Google API key. Azure
 * (Microsoft Foundry) image deployments are a list the admin keeps in AI Config
 * (`azure_image_models`): the deployment name, the model behind it (which
 * decides the API, see core/providers/azureImages.mts) and, optionally, what
 * one image costs. They use the endpoint and key of the Azure provider.
 *
 * A client names an Azure model as `azure/<deployment>`.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const GOOGLE_IMAGE_MODELS = [
    { id: 'gemini-3.1-flash-image-preview', label: 'Flash Image (Fast)' },
    { id: 'gemini-3-pro-image-preview', label: 'Pro Image (Quality)' },
] as const;

export const DEFAULT_GOOGLE_IMAGE_MODEL = GOOGLE_IMAGE_MODELS[0].id;

/** The config key of the Azure image deployment list. */
export const AZURE_IMAGE_MODELS_KEY = 'azure_image_models';

/** The currency an admin enters the price of one image in. */
export const IMAGE_PRICE_CURRENCY = 'EUR';

export const MAX_AZURE_IMAGE_MODELS = 20;

export interface AzureImageModel {
    /** The deployment name in Foundry; what the request carries as `model`. */
    deployment: string;
    /** The model behind it (`gpt-image-1.5`, `MAI-Image-2.6`); the deployment name when not given. */
    model: string;
    /** What one generated image costs, in IMAGE_PRICE_CURRENCY; null when not set. */
    pricePerImage: number | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A usable price: a finite number from zero up; anything else is "not set". */
function toPrice(v: unknown): number | null {
    const n = typeof v === 'string' && v.trim() ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The admin's list as stored (an array, or the same JSON as text). Entries
 * without a deployment name are dropped, a repeated deployment keeps its first
 * entry, and the list is cut at MAX_AZURE_IMAGE_MODELS.
 */
export function parseAzureImageModels(raw: unknown): AzureImageModel[] {
    let value = raw;
    if (typeof value === 'string') {
        if (!value.trim()) return [];
        try { value = JSON.parse(value); } catch { return []; }
    }
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: AzureImageModel[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as Record<string, unknown>;
        const deployment = text(entry.deployment).slice(0, 128);
        if (!deployment || seen.has(deployment)) continue;
        seen.add(deployment);
        out.push({
            deployment,
            model: text(entry.model).slice(0, 128) || deployment,
            pricePerImage: toPrice(entry.pricePerImage),
        });
        if (out.length >= MAX_AZURE_IMAGE_MODELS) break;
    }
    return out;
}

export type ImageBackend =
    | { provider: 'google'; model: string; apiKey: string }
    | { provider: 'azure'; model: string; deployment: string; endpoint: string; apiKey: string; pricePerImage: number | null };

interface ConfigStore {
    getConfig(key: string): Promise<unknown>;
    getSecret(key: string): Promise<string | null | undefined>;
}
const configStore = () => nodeRequire('../../stores/configStore') as ConfigStore;

/** What is configured right now: the Google key and the usable Azure deployments. */
export async function loadImageProviders(): Promise<{
    googleApiKey: string | null;
    azure: { endpoint: string; apiKey: string; models: AzureImageModel[] } | null;
}> {
    const store = configStore();
    const googleApiKey = (await store.getSecret('google_api_key')) || null;
    const models = parseAzureImageModels(await store.getConfig(AZURE_IMAGE_MODELS_KEY));
    let azure = null;
    if (models.length > 0) {
        const endpoint = text(await store.getConfig('azure_endpoint'));
        const apiKey = (await store.getSecret('azure_api_key')) || '';
        if (endpoint && apiKey) azure = { endpoint, apiKey, models };
    }
    return { googleApiKey, azure };
}

/** True when at least one image model can be used. */
export async function isImageGenerationAvailable(): Promise<boolean> {
    const { googleApiKey, azure } = await loadImageProviders();
    return !!googleApiKey || !!azure;
}

/** The models a user can pick from, Google first. No secrets, no prices. */
export async function listImageModels(): Promise<Array<{ id: string; label: string; provider: 'google' | 'azure' }>> {
    const { googleApiKey, azure } = await loadImageProviders();
    const out: Array<{ id: string; label: string; provider: 'google' | 'azure' }> = [];
    if (googleApiKey) {
        for (const m of GOOGLE_IMAGE_MODELS) out.push({ id: m.id, label: m.label, provider: 'google' });
    }
    for (const m of azure?.models || []) {
        out.push({ id: `azure/${m.deployment}`, label: m.model === m.deployment ? m.deployment : `${m.model} (${m.deployment})`, provider: 'azure' });
    }
    return out;
}

/**
 * The backend that serves a request. The model the caller asked for wins when
 * it is available; otherwise Google's default when there is a Google key, and
 * otherwise the first Azure deployment. null when nothing is configured.
 */
export async function resolveImageBackend(requested?: string | null): Promise<ImageBackend | null> {
    const { googleApiKey, azure } = await loadImageProviders();
    const wanted = text(requested);
    const azureBackend = (m: AzureImageModel): ImageBackend => ({
        provider: 'azure', model: m.model, deployment: m.deployment,
        endpoint: azure!.endpoint, apiKey: azure!.apiKey, pricePerImage: m.pricePerImage,
    });
    if (wanted.toLowerCase().startsWith('azure/')) {
        const hit = azure?.models.find(m => m.deployment === wanted.slice('azure/'.length));
        if (hit) return azureBackend(hit);
    } else if (wanted && googleApiKey) {
        return { provider: 'google', model: wanted, apiKey: googleApiKey };
    }
    if (googleApiKey) return { provider: 'google', model: DEFAULT_GOOGLE_IMAGE_MODEL, apiKey: googleApiKey };
    if (azure) return azureBackend(azure.models[0]);
    return null;
}
