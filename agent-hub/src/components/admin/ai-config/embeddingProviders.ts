// Which connected providers can serve embeddings, for the Embeddings pane's
// provider select. A provider that lists models but none that embed (a chat-only
// or voice provider) is left out: picking it would save a configuration the
// knowledge bases then re-index against and that cannot work.
import { getModelMeta } from './chatModelTiers/modelMeta';

export interface EmbeddingProviderLike {
    id: string;
    type?: string;
}

export interface EmbeddingModelLike {
    id: string;
    providerId?: string;
    embedding?: boolean;
    cat?: string;
}

/**
 * A model that turns text into vectors. The server flags them for the catalogues
 * that know (`embedding`, or the category `Embedding`); OpenAI and Google list
 * bare ids, where the id itself says it (`text-embedding-3-small`,
 * `gemini-embedding-001`). A model flagged `embedding: false` never counts.
 */
export function canEmbed(model: EmbeddingModelLike): boolean {
    if (model.embedding === true) return true;
    if (model.embedding === false) return false;
    const cat = model.cat || getModelMeta(model.id)?.cat;
    if (cat === 'Embedding') return true;
    return /embed/i.test(model.id);
}

/**
 * The providers the select offers: Azure (its embedding model is a deployment
 * name typed by hand), a provider whose model list is empty (a runtime or custom
 * endpoint: the model is typed by hand too), a provider with at least one model
 * that embeds, and always the providers in `keepIds` (the saved and the selected
 * one), so a stored choice never shows as blank. While no models are loaded at
 * all, nothing can be judged and every provider stays.
 */
export function embeddingProviders<P extends EmbeddingProviderLike>(
    providers: readonly P[],
    models: readonly EmbeddingModelLike[],
    keepIds: readonly string[] = [],
): P[] {
    if (models.length === 0) return [...providers];
    return providers.filter((p) => {
        if (keepIds.includes(p.id) || p.type === 'azure') return true;
        const own = models.filter(m => m.providerId === p.id);
        return own.length === 0 || own.some(canEmbed);
    });
}

/**
 * The model select's options for one provider: only the models that embed, so a
 * chat or rerank model cannot be picked by mistake, plus the saved model so an
 * earlier choice never shows as blank. When none of them embeds, all of them.
 */
export function embeddingModelChoices<M extends EmbeddingModelLike>(providerModels: readonly M[], savedModelId?: string): M[] {
    const embedding = providerModels.filter(m => canEmbed(m) || m.id === savedModelId);
    return embedding.length > 0 ? embedding : [...providerModels];
}
