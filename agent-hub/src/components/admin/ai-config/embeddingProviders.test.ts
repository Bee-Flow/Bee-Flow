import { describe, expect, it } from 'vitest';
import { canEmbed, embeddingModelChoices, embeddingProviders } from './embeddingProviders';

const PROVIDERS = [
    { id: 'anth', type: 'claude' },
    { id: 'eugpt', type: 'eugpt' },
    { id: 'oai', type: 'openai' },
    { id: 'ionos', type: 'ionos' },
    { id: 'az', type: 'azure' },
    { id: 'ollama', type: 'ollama' },
];
const MODELS = [
    { id: 'claude-sonnet-4-6', providerId: 'anth' },
    { id: 'eugpt-auto', providerId: 'eugpt', embedding: false },
    { id: 'gpt-5.6', providerId: 'oai' },
    { id: 'text-embedding-3-small', providerId: 'oai' },
    { id: 'BAAI/bge-m3', providerId: 'ionos', embedding: true, cat: 'Embedding' },
    { id: 'meta-llama/Llama-3.3-70B-Instruct', providerId: 'ionos' },
    { id: 'gpt-4o', providerId: 'az' },
];

describe('canEmbed', () => {
    it('trusts the server flag and category, else the id; an explicit false never embeds', () => {
        expect(canEmbed({ id: 'x', embedding: true })).toBe(true);
        expect(canEmbed({ id: 'x', cat: 'Embedding' })).toBe(true);
        expect(canEmbed({ id: 'gemini-embedding-001' })).toBe(true);
        expect(canEmbed({ id: 'some-embed-model', embedding: false })).toBe(false);
        expect(canEmbed({ id: 'claude-sonnet-4-6' })).toBe(false);
    });
});

describe('embeddingProviders', () => {
    it('drops providers that list models but none that embed; keeps Azure and providers without a model list', () => {
        const ids = embeddingProviders(PROVIDERS, MODELS).map(p => p.id);
        expect(ids).toEqual(['oai', 'ionos', 'az', 'ollama']);
    });

    it('keeps the saved or selected provider even when it cannot embed', () => {
        expect(embeddingProviders(PROVIDERS, MODELS, ['anth']).map(p => p.id)).toContain('anth');
    });

    it('judges nothing while no models are loaded', () => {
        expect(embeddingProviders(PROVIDERS, [])).toHaveLength(PROVIDERS.length);
    });
});

describe('embeddingModelChoices', () => {
    it('lists only the embedding models plus the saved one, or everything when none embeds', () => {
        const oai = MODELS.filter(m => m.providerId === 'oai');
        expect(embeddingModelChoices(oai).map(m => m.id)).toEqual(['text-embedding-3-small']);
        expect(embeddingModelChoices(oai, 'gpt-5.6').map(m => m.id)).toEqual(['gpt-5.6', 'text-embedding-3-small']);
        const az = MODELS.filter(m => m.providerId === 'az');
        expect(embeddingModelChoices(az).map(m => m.id)).toEqual(['gpt-4o']);
    });
});
