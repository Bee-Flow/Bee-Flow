// Which Claude recommendations this server can actually use. The "Claude
// models" block on the chat-model page only makes sense when a Claude model is
// configured, and a recommendation can only be applied when its model is in
// the catalogue the providers report: on a server without it, applying would
// point a tier at a model that cannot run.
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER } from './constants';
import type { CatalogModel } from './tierTypes';

/** A catalogue row, with the stored type of the provider it came from when known. */
type ModelLike = Pick<CatalogModel, 'id'> & { providerType?: unknown };

/**
 * A Claude model, however it is served: through Anthropic (provider type
 * `claude`), or through Azure or Vertex (the id names Claude). The same test
 * the server's empty-answer retry uses (usecases/ai/directChat/finalizeContent.js).
 */
export function isClaudeCatalogModel(model: ModelLike): boolean {
    return /claude/i.test(model.id || '') || model.providerType === 'claude';
}

/** True when at least one configured chat model is a Claude model. */
export function hasClaudeModels(models: readonly ModelLike[]): boolean {
    return models.some(isClaudeCatalogModel);
}

/**
 * The catalogue id for a recommended model, or null when this server does not
 * offer it. The exact id wins; otherwise a dated snapshot of it
 * (`claude-haiku-4-5-20251001` as Anthropic lists it, `claude-sonnet-4-6@20250929`
 * as Vertex does).
 */
export function resolveRecommendedModelId(recommendedId: string, models: readonly ModelLike[]): string | null {
    if (models.some(m => m.id === recommendedId)) return recommendedId;
    const snapshot = models.find((m) => {
        if (!m.id.startsWith(recommendedId)) return false;
        const rest = m.id.slice(recommendedId.length);
        return /^-\d{8}$/.test(rest) || /^@[\w.-]+$/.test(rest);
    });
    return snapshot ? snapshot.id : null;
}

/** Tier key → the catalogue id its recommendation would set, for the tiers this server can serve. */
export function applicableRecommendations(models: readonly ModelLike[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const tierKey of CLAUDE_REC_TIER_ORDER) {
        const rec = CLAUDE_RECOMMENDED[tierKey];
        if (!rec) continue;
        const id = resolveRecommendedModelId(rec.modelId, models);
        if (id) out[tierKey] = id;
    }
    return out;
}
