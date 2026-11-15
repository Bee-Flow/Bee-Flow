import { describe, expect, it } from 'vitest';
import { applicableRecommendations, claudeFamilyVersion, hasClaudeModels, isClaudeCatalogModel, newestOfFamily, recommendedModelId } from './claudeRecommendations';

describe('isClaudeCatalogModel / hasClaudeModels', () => {
    it('counts Claude however it is served: by id (Azure, Vertex) or by the Anthropic provider type', () => {
        expect(isClaudeCatalogModel({ id: 'claude-sonnet-4-6' })).toBe(true);
        expect(isClaudeCatalogModel({ id: 'my-claude-deployment', providerType: 'azure' })).toBe(true);
        expect(isClaudeCatalogModel({ id: 'claude-opus-4-7@20260101', providerType: 'vertex' })).toBe(true);
        expect(isClaudeCatalogModel({ id: 'some-alias', providerType: 'claude' })).toBe(true);
        expect(isClaudeCatalogModel({ id: 'mistral-large-latest', providerType: 'mistral' })).toBe(false);
    });

    it('is false for a server with only other providers, true once one Claude model is there', () => {
        expect(hasClaudeModels([])).toBe(false);
        expect(hasClaudeModels([{ id: 'mistral-large-latest' }, { id: 'qwen3:8b', providerType: 'ollama' }])).toBe(false);
        expect(hasClaudeModels([{ id: 'mistral-large-latest' }, { id: 'claude-haiku-4-5-20251001' }])).toBe(true);
    });
});

describe('claudeFamilyVersion', () => {
    it('reads the family and version past a dated snapshot, and nothing else', () => {
        expect(claudeFamilyVersion('claude-sonnet-4-6')).toEqual({ family: 'sonnet', major: 4, minor: 6 });
        expect(claudeFamilyVersion('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', major: 4, minor: 5 });
        expect(claudeFamilyVersion('claude-sonnet-4-6@20250929')).toEqual({ family: 'sonnet', major: 4, minor: 6 });
        expect(claudeFamilyVersion('claude-opus-5')).toEqual({ family: 'opus', major: 5, minor: 0 });
        expect(claudeFamilyVersion('claude-fable-5-1')).toBeNull();
        expect(claudeFamilyVersion('my-claude-deployment')).toBeNull();
    });
});

describe('newestOfFamily', () => {
    // The catalogue (server/core/providers/claudeModels.js) moves on; the
    // recommendation follows it instead of pinning an older id.
    it('takes the newest model of a family the catalogue offers', () => {
        const catalogue = [{ id: 'claude-opus-4-7' }, { id: 'claude-opus-5' }, { id: 'claude-opus-4-8' }, { id: 'claude-sonnet-5' }, { id: 'claude-sonnet-4-6' }];
        expect(newestOfFamily('opus', catalogue)).toBe('claude-opus-5');
        expect(newestOfFamily('sonnet', catalogue)).toBe('claude-sonnet-5');
        expect(newestOfFamily('haiku', catalogue)).toBeNull();
    });

    it('returns the catalogue id, snapshot suffix and all', () => {
        expect(newestOfFamily('haiku', [{ id: 'claude-haiku-4-5-20251001' }])).toBe('claude-haiku-4-5-20251001');
        expect(newestOfFamily('sonnet', [{ id: 'claude-sonnet-4-6@20250929' }])).toBe('claude-sonnet-4-6@20250929');
    });
});

describe('recommendedModelId / applicableRecommendations', () => {
    it('resolves each tier to its family on this server, and only those it can serve', () => {
        const applicable = applicableRecommendations([{ id: 'claude-sonnet-4-6' }, { id: 'gpt-5.6' }]);
        expect(Object.keys(applicable).sort()).toEqual(['standard', 'swarm', 'thinking', 'writer']);
        expect(applicable.thinking).toBe('claude-sonnet-4-6');
        expect(applicableRecommendations([{ id: 'mistral-large-latest' }])).toEqual({});
    });

    it('is null for a tier without a recommendation or a server without its family', () => {
        expect(recommendedModelId('custom:x', [{ id: 'claude-sonnet-5' }])).toBeNull();
        expect(recommendedModelId('pro', [{ id: 'claude-sonnet-5' }])).toBeNull();
        expect(recommendedModelId('pro', [{ id: 'claude-opus-4-8' }])).toBe('claude-opus-4-8');
    });
});
