// Which Claude recommendations this server can actually use. The "Claude
// models" block on the Models page only makes sense when a Claude model is
// configured. A recommendation names a model FAMILY per tier (Haiku, Sonnet,
// Opus), not a fixed id: it resolves to the newest model of that family in the
// catalogue the providers report (server/core/providers/claudeModels.js reaches
// the page through GET /ai/providers/:id/models). So a new Claude release
// updates the table by itself, and a server without that family gets nothing
// to apply: applying would point a tier at a model that cannot run.
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER, type ClaudeFamily } from './constants';
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

interface FamilyVersion {
    family: ClaudeFamily;
    major: number;
    minor: number;
}

const FAMILY_ID = /^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d{1,2}))?$/;

/**
 * The family and version an id names, read past a dated snapshot
 * (`claude-haiku-4-5-20251001` as Anthropic lists it, `claude-sonnet-4-6@20250929`
 * as Vertex does). Null for anything else (a custom Azure deployment name).
 */
export function claudeFamilyVersion(id: string): FamilyVersion | null {
    const bare = id.split('@')[0].replace(/-\d{8}$/, '');
    const match = FAMILY_ID.exec(bare);
    if (!match) return null;
    return { family: match[1] as ClaudeFamily, major: Number(match[2]), minor: match[3] ? Number(match[3]) : 0 };
}

const newer = (a: FamilyVersion, b: FamilyVersion) => a.major !== b.major ? a.major > b.major : a.minor > b.minor;

/** The catalogue id of the newest model of `family`, or null when this server offers none. */
export function newestOfFamily(family: ClaudeFamily, models: readonly ModelLike[]): string | null {
    let best: { id: string; version: FamilyVersion } | null = null;
    for (const model of models) {
        const version = claudeFamilyVersion(model.id || '');
        if (!version || version.family !== family) continue;
        if (!best || newer(version, best.version)) best = { id: model.id, version };
    }
    return best ? best.id : null;
}

/** The model a tier's recommendation would set on this server, or null (no recommendation, or no model of its family). */
export function recommendedModelId(tierKey: string, models: readonly ModelLike[]): string | null {
    const rec = Object.hasOwn(CLAUDE_RECOMMENDED, tierKey) ? CLAUDE_RECOMMENDED[tierKey] : undefined;
    return rec ? newestOfFamily(rec.family, models) : null;
}

/** Tier key → the catalogue id its recommendation would set, for the tiers this server can serve. */
export function applicableRecommendations(models: readonly ModelLike[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const tierKey of CLAUDE_REC_TIER_ORDER) {
        const id = recommendedModelId(tierKey, models);
        if (id) out[tierKey] = id;
    }
    return out;
}
