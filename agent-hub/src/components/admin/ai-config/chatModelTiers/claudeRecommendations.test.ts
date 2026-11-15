import { describe, expect, it } from 'vitest';
import { applicableRecommendations, hasClaudeModels, isClaudeCatalogModel, resolveRecommendedModelId } from './claudeRecommendations';

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

describe('resolveRecommendedModelId', () => {
    it('takes the exact id, else a dated snapshot of it, else nothing', () => {
        expect(resolveRecommendedModelId('claude-sonnet-4-6', [{ id: 'claude-sonnet-4-6' }])).toBe('claude-sonnet-4-6');
        expect(resolveRecommendedModelId('claude-haiku-4-5', [{ id: 'claude-haiku-4-5-20251001' }])).toBe('claude-haiku-4-5-20251001');
        expect(resolveRecommendedModelId('claude-sonnet-4-6', [{ id: 'claude-sonnet-4-6@20250929' }])).toBe('claude-sonnet-4-6@20250929');
        expect(resolveRecommendedModelId('claude-opus-4-7', [{ id: 'claude-opus-4-8' }, { id: 'claude-opus-4-7-preview' }])).toBeNull();
        expect(resolveRecommendedModelId('claude-sonnet-5', [])).toBeNull();
    });
});

describe('applicableRecommendations', () => {
    it('lists only the tiers whose recommended model the catalogue offers', () => {
        const applicable = applicableRecommendations([{ id: 'claude-sonnet-4-6' }, { id: 'gpt-5.6' }]);
        expect(Object.keys(applicable).sort()).toEqual(['standard', 'swarm', 'writer']);
        expect(applicableRecommendations([{ id: 'mistral-large-latest' }])).toEqual({});
    });
});
