/**
 * embeddingChoice.mts: what a save of the AI configuration (POST /ai/config,
 * routes/ai/config/instanceConfig.js) does to the embedding model and the vector length asked of it.
 *
 * The length (./outputDimensions.mts) is decided only when the save CHANGES the embedding provider
 * or model. A save that leaves them as they are (the embeddings screen saved again, or any other
 * screen of the AI configuration) passes no decision, so the stored one, or its absence, stays: a
 * configuration whose vectors are stored at the model's own length keeps its full-length vectors.
 * Picking a model again whose full-length vectors are still the stored ones keeps them as well
 * (core/kb/embeddingMigration.js storesNativeVectorsOf), so that is not a re-embed either.
 */

import { createRequire } from 'node:module';
import { decideEmbeddingOutput, storedDimensions, type EmbeddingOutput } from './outputDimensions.mts';

const nodeRequire = createRequire(import.meta.url);

interface EmbeddingFields { embeddingProviderId?: string | null; embeddingModel?: string | null }

interface AiRecord extends EmbeddingFields {
    providers?: Array<{ id: string; type?: string | null }>;
    embeddingOutput?: unknown;
}

export interface EmbeddingChoiceDeps {
    readAi: () => Promise<AiRecord | null | undefined>;
    nativeVectorsStored: (providerId: string, modelId: string) => Promise<boolean>;
}

export interface EmbeddingChoice {
    providerId: string | null | undefined;
    modelId: string | null | undefined;
    /** The provider or the model differs from the stored one: the stored vectors get re-embedded. */
    changed: boolean;
    /** `ai.embeddingOutput` to store: undefined keeps what is stored, null clears it. */
    output: EmbeddingOutput | null | undefined;
}

function defaultDeps(): EmbeddingChoiceDeps {
    return {
        readAi: () => nodeRequire('../../stores/configStore.js').getConfig('ai'),
        nativeVectorsStored: (providerId, modelId) => nodeRequire('../kb/embeddingMigration.js').storesNativeVectorsOf(providerId, modelId),
    };
}

/**
 * The embedding provider and model a save leaves configured, whether that is a change, and the
 * vector-length decision to store with it. `sent` holds the request's fields (undefined = not sent).
 */
export async function embeddingChoice(existing: EmbeddingFields, sent: EmbeddingFields, deps: EmbeddingChoiceDeps = defaultDeps()): Promise<EmbeddingChoice> {
    const changed = (sent.embeddingModel !== undefined && sent.embeddingModel !== existing.embeddingModel)
        || (sent.embeddingProviderId !== undefined && sent.embeddingProviderId !== existing.embeddingProviderId);
    const providerId = sent.embeddingProviderId !== undefined ? sent.embeddingProviderId : existing.embeddingProviderId;
    const modelId = sent.embeddingModel !== undefined ? sent.embeddingModel : existing.embeddingModel;
    if (!changed) return { providerId, modelId, changed, output: undefined };
    if (!providerId || !modelId) return { providerId, modelId, changed, output: null };
    const ai = (await deps.readAi()) || {};
    const output = decideEmbeddingOutput(ai.providers, providerId, modelId, {
        nativeVectorsStored: await deps.nativeVectorsStored(providerId, modelId),
    });
    return { providerId, modelId, changed, output };
}

/** The vector length asked of the configured embedding model, null for its own (for the admin screen). */
export function savedDimensions(ai: AiRecord | null | undefined): number | null {
    return storedDimensions(ai?.embeddingOutput, ai?.embeddingProviderId, ai?.embeddingModel);
}
