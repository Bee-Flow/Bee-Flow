/**
 * The Azure (Microsoft Foundry) image deployments of the Azure form: one row
 * per deployment, as typed, and the `azureImageModels` list POST /ai/config
 * takes (server/routes/ai/config/instanceConfig.js). The model decides the
 * API on the server: `gpt-image…` the OpenAI image API, `MAI-Image…` the MAI
 * one. The price is what one image costs, in euro, and shows up in Usage.
 */

/** The server's caps (instanceConfig.js AzureImageModelsBody). */
export const MAX_IMAGE_DEPLOYMENTS = 20;
export const MAX_IMAGE_PRICE = 1000;
export const MAX_DEPLOYMENT_NAME = 128;

/** Suggestions for the model field; any other text is allowed. */
export const AZURE_IMAGE_MODEL_SUGGESTIONS = [
    'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'MAI-Image-2.6', 'MAI-Image-2.5',
] as const;

/** One row as the form edits it. `key` only tells React the rows apart. */
export interface AzureImageRow {
    key: string;
    deployment: string;
    model: string;
    price: string;
}

/** One entry of `azureImageModels`, as GET /ai/config answers and POST takes it. */
interface AzureImageModelEntry {
    deployment: string;
    model?: string;
    pricePerImage?: number | null;
}

let nextKey = 0;
const newKey = () => `img-${++nextKey}`;

export function emptyImageRow(): AzureImageRow {
    return { key: newKey(), deployment: '', model: '', price: '' };
}

/** The stored list as rows; a model equal to the deployment name shows as such. */
export function rowsFromConfig(value: unknown): AzureImageRow[] {
    if (!Array.isArray(value)) return [];
    const rows: AzureImageRow[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const e = item as Record<string, unknown>;
        const deployment = typeof e.deployment === 'string' ? e.deployment : '';
        if (!deployment) continue;
        const price = typeof e.pricePerImage === 'number' && Number.isFinite(e.pricePerImage) ? String(e.pricePerImage) : '';
        rows.push({ key: newKey(), deployment, model: typeof e.model === 'string' ? e.model : '', price });
    }
    return rows;
}

/** What the rows say, without the React keys: to tell an edit from the stored list. */
export function rowsSignature(rows: readonly AzureImageRow[]): string {
    return JSON.stringify(rows.map(r => [r.deployment.trim(), r.model.trim(), r.price.trim()]));
}

export type ImageRowsResult =
    | { ok: true; value: AzureImageModelEntry[] }
    | { ok: false; reason: 'price' | 'too_many' };

/**
 * The rows as the request list. A row without a deployment name is left out
 * (an empty row just added), an empty price is "not set", and a price that is
 * not a number from 0 to MAX_IMAGE_PRICE refuses the whole list. A decimal
 * comma is accepted.
 */
export function rowsToConfig(rows: readonly AzureImageRow[]): ImageRowsResult {
    const value: AzureImageModelEntry[] = [];
    for (const row of rows) {
        const deployment = row.deployment.trim();
        if (!deployment) continue;
        const priceText = row.price.trim().replace(',', '.');
        let pricePerImage: number | null = null;
        if (priceText !== '') {
            const n = Number(priceText);
            if (!Number.isFinite(n) || n < 0 || n > MAX_IMAGE_PRICE) return { ok: false, reason: 'price' };
            pricePerImage = n;
        }
        const model = row.model.trim();
        value.push({ deployment, ...(model ? { model } : {}), pricePerImage });
    }
    if (value.length > MAX_IMAGE_DEPLOYMENTS) return { ok: false, reason: 'too_many' };
    return { ok: true, value };
}
