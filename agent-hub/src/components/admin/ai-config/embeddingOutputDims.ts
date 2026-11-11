// The vector length an embedding model will produce, for the warning on the
// embeddings screen. The rules mirror server/core/embed/outputDimensions.mts:
// a Matryoshka model above the vector-index limit is cut to REDUCED_DIMS
// when it is newly chosen; a model that stays selected keeps the length the
// server reports (`embeddingDimensions`, null = the model's own).

/** The longest vector pgvector's HNSW index accepts. */
const INDEX_MAX_DIMS = 2000;
/** The length the vectors of a newly chosen Matryoshka model above the limit are cut to. */
const REDUCED_DIMS = 1536;

export interface EmbeddingModelShape {
    dims?: number | null;
    matryoshka?: { min: number; max: number } | null;
}

/**
 * The vector length the chosen model will produce, or null when the catalog
 * does not say. `storedDimensions` is undefined for a model that is not the
 * saved one (a fresh choice), else the server's `embeddingDimensions`.
 */
export function expectedEmbeddingDims(model: EmbeddingModelShape | undefined, storedDimensions?: number | null): number | null {
    const dims = typeof model?.dims === 'number' && model.dims > 0 ? model.dims : null;
    if (storedDimensions !== undefined) return storedDimensions ?? dims;
    const range = model?.matryoshka;
    if (dims != null && dims > INDEX_MAX_DIMS && range && REDUCED_DIMS >= range.min && REDUCED_DIMS <= range.max) {
        return REDUCED_DIMS;
    }
    return dims;
}

/** True when vectors of this length cannot use the fast index. */
export function exceedsVectorIndex(dims: number | null): dims is number {
    return dims != null && dims > INDEX_MAX_DIMS;
}
