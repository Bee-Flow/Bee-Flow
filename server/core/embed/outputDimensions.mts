/**
 * outputDimensions.mts: how long the vectors of the configured embedding model are asked to be.
 *
 * pgvector's HNSW index takes vectors of at most 2000 dimensions. A model that returns more
 * (Scaleway's qwen3-embedding-8b: 4096) leaves `kb_chunks` without its index, so every knowledge
 * base search is a sequential scan, and its vectors do not fit the memory store at all
 * (stores/memoryVectors.js MAX_VECTOR_DIM). The vector of a Matryoshka model can be shortened:
 * its first n values, L2-normalised, are a valid n-dimension embedding (reduceVector). The native
 * vector is always requested; no `dimensions` field is sent, since not every host supports one.
 * This module decides when the reduction happens.
 *
 * ── DECIDED ONCE, WHEN THE MODEL IS CHOSEN ──────────────────────────
 * Asking an existing configuration for shorter vectors would put vectors of a new length next to
 * the stored ones, or (same provider, same model, so the same migration fingerprint) never
 * re-embed them at all. So the length is not derived from the catalog on every call. It is decided
 * when an admin picks the embedding model (./embeddingChoice.mts, from POST /ai/config) and stored next to
 * that choice as `ai.embeddingOutput = { providerId, modelId, dimensions }`:
 *   - a model picked from now on gets REDUCED_DIMS when it qualifies, and the re-embed that every
 *     model switch already starts (core/kb/embeddingMigration.js) writes vectors of that length;
 *   - a configuration made before this existed has no `embeddingOutput`, so nothing is sent and
 *     its stored vectors stay valid;
 *   - a stored decision only counts for the provider and model it was made for (storedDimensions),
 *     so a model changed by any other path never inherits it.
 * The decided length is part of the migration fingerprint, so a changed length always re-embeds.
 *
 * Only a model the catalog marks `matryoshka` is shortened: cutting the vector of a model that was
 * not trained for it (bge-multilingual-gemma2) throws away meaning. The admin screen warns about
 * those instead.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** The longest vector pgvector's HNSW index accepts. */
export const INDEX_MAX_DIMS = 2000;

/** The length a Matryoshka model above INDEX_MAX_DIMS is asked for. */
export const REDUCED_DIMS = 1536;

export interface MatryoshkaRange { min: number; max: number }

export interface EmbeddingShape {
    /** The length the model returns, or null when the catalog does not say. */
    dims: number | null;
    /** The range the model can be shortened to, or null when it cannot (or the catalog does not say). */
    matryoshka: MatryoshkaRange | null;
}

/** The decision stored next to the embedding model (`ai.embeddingOutput`). */
export interface EmbeddingOutput { providerId: string; modelId: string; dimensions: number }

interface CatalogEntry { dims?: number; matryoshka?: MatryoshkaRange }

const UNKNOWN: EmbeddingShape = Object.freeze({ dims: null, matryoshka: null });

function catalogEntry(providerType: string | null | undefined, modelId: string): CatalogEntry | null {
    if (providerType === 'scaleway') return nodeRequire('../providers/scalewayModels.js').getScalewayModel(modelId);
    if (providerType === 'ionos') return nodeRequire('../providers/ionosModels.js').getIonosModel(modelId);
    return null;
}

const isPositiveInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

/** What the catalog knows about the vector length of an embedding model. */
export function embeddingShape(providerType: string | null | undefined, modelId: string | null | undefined): EmbeddingShape {
    if (!modelId) return UNKNOWN;
    const entry = catalogEntry(providerType, modelId);
    if (!entry) return UNKNOWN;
    const dims = isPositiveInt(entry.dims) ? entry.dims : null;
    const m = entry.matryoshka;
    const matryoshka = m && isPositiveInt(m.min) && isPositiveInt(m.max) && m.min <= m.max ? { min: m.min, max: m.max } : null;
    return { dims, matryoshka };
}

/**
 * The length to shorten a newly chosen model's vectors to: REDUCED_DIMS for a Matryoshka model whose
 * own length is above INDEX_MAX_DIMS and that can be shortened to it, otherwise null (keep them).
 */
export function chooseDimensions(providerType: string | null | undefined, modelId: string | null | undefined): number | null {
    const { dims, matryoshka } = embeddingShape(providerType, modelId);
    if (dims == null || dims <= INDEX_MAX_DIMS || !matryoshka) return null;
    if (REDUCED_DIMS < matryoshka.min || REDUCED_DIMS > matryoshka.max) return null;
    return REDUCED_DIMS;
}

/**
 * The decision for an embedding model an admin just chose, to store as `ai.embeddingOutput`; null
 * when nothing is to be sent (store null, so an earlier decision does not linger).
 *
 * `nativeVectorsStored`: the knowledge-base vectors already come from this provider and model at
 * its own length (core/kb/embeddingMigration.js storesNativeVectorsOf), e.g. the model was cleared
 * and picked again. Those stay as they are: nothing is sent, and nothing is re-embedded.
 */
export function decideEmbeddingOutput(
    providers: ReadonlyArray<{ id: string; type?: string | null }> | null | undefined,
    providerId: string | null | undefined,
    modelId: string | null | undefined,
    { nativeVectorsStored = false }: { nativeVectorsStored?: boolean } = {},
): EmbeddingOutput | null {
    if (!providerId || !modelId || nativeVectorsStored) return null;
    const provider = (providers || []).find((p) => p.id === providerId);
    const dimensions = chooseDimensions(provider?.type, modelId);
    return dimensions == null ? null : { providerId, modelId, dimensions };
}

/**
 * The stored `dimensions` for the configured provider and model, or null. A decision made for
 * another provider or model, or one that is malformed, counts as none.
 */
export function storedDimensions(output: unknown, providerId: string | null | undefined, modelId: string | null | undefined): number | null {
    if (!output || typeof output !== 'object') return null;
    const o = output as Partial<EmbeddingOutput>;
    if (o.providerId !== providerId || o.modelId !== modelId) return null;
    return isPositiveInt(o.dimensions) && o.dimensions <= INDEX_MAX_DIMS ? o.dimensions : null;
}

/**
 * The Matryoshka (MRL) reduction of one returned vector: its first `dims` values, L2-normalised.
 * Done here rather than with a `dimensions` request field, which not every host of a model
 * supports (and none documents for qwen3-embedding-8b): the native vector is always requested.
 * A vector already at or below `dims` is returned as it is; an all-zero prefix stays zeros.
 */
export function reduceVector(vec: number[], dims: number | null | undefined): number[] {
    if (!dims || !Array.isArray(vec) || vec.length <= dims) return vec;
    const head = vec.slice(0, dims);
    let sum = 0;
    for (const v of head) sum += v * v;
    const norm = Math.sqrt(sum);
    return norm > 0 && Number.isFinite(norm) ? head.map((v) => v / norm) : head;
}
