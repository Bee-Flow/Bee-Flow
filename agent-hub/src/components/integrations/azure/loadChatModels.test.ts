import { describe, expect, it } from 'vitest';

import loadChatModels from './loadChatModels';

/**
 * The organisation Azure panel's tier picker asked a route the server never
 * had (`GET /ai/models`), so it showed "No models available" with providers
 * connected. It now reads the providers and each provider's models, the same
 * source the admin dashboard's tier cards use.
 */

const reply = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

function fakeServer(routes: Record<string, () => Promise<Response>>) {
    const asked: string[] = [];
    const fetcher = (url: string) => {
        asked.push(url);
        const route = routes[url];
        return route ? route() : reply({ error: 'not found' }, 404);
    };
    return { fetcher, asked };
}

describe('loadChatModels', () => {
    it('lists the models of every connected provider, tagged with that provider', async () => {
        const { fetcher, asked } = fakeServer({
            '/api-base/ai/providers': () => reply({ providers: [
                { id: 'p-claude', name: 'Anthropic', type: 'claude' },
                { id: 'p-openai', name: 'OpenAI', type: 'openai' },
            ] }),
            '/api-base/ai/providers/p-claude/models': () => reply({ models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] }),
            '/api-base/ai/providers/p-openai/models': () => reply({ models: [{ id: 'gpt-6.1-sol' }] }),
        });

        const models = await loadChatModels(fetcher, '/api-base');

        expect(models.map(m => [m.id, m.provider, m.providerType])).toEqual([
            ['claude-sonnet-5-5', 'Anthropic', 'claude'],
            ['gpt-6.1-sol', 'OpenAI', 'openai'],
        ]);
        expect(asked).not.toContain('/api-base/ai/models');
    });

    it('leaves out models a chat tier cannot run', async () => {
        const { fetcher } = fakeServer({
            '/api-base/ai/providers': () => reply({ providers: [{ id: 'p-mistral', name: 'Mistral', type: 'mistral' }] }),
            '/api-base/ai/providers/p-mistral/models': () => reply({ models: [
                { id: 'mistral-medium-latest' },
                { id: 'codestral-embed', cat: 'Embedding' },
                { id: 'mistral-ocr-latest', cat: 'OCR' },
            ] }),
        });

        const models = await loadChatModels(fetcher, '/api-base');

        expect(models.map(m => m.id)).toEqual(['mistral-medium-latest']);
    });

    it('keeps the providers that answer when one model list fails', async () => {
        const { fetcher } = fakeServer({
            '/api-base/ai/providers': () => reply({ providers: [
                { id: 'down', name: 'Broken', type: 'openai' },
                { id: 'up', name: 'Anthropic', type: 'claude' },
            ] }),
            '/api-base/ai/providers/down/models': () => Promise.reject(new Error('network')),
            '/api-base/ai/providers/up/models': () => reply({ models: [{ id: 'claude-haiku-5' }] }),
        });

        const models = await loadChatModels(fetcher, '/api-base');

        expect(models.map(m => m.id)).toEqual(['claude-haiku-5']);
    });

    it('is empty when the providers cannot be read', async () => {
        const { fetcher } = fakeServer({
            '/api-base/ai/providers': () => reply({ error: 'Unauthorized' }, 401),
        });

        await expect(loadChatModels(fetcher, '/api-base')).resolves.toEqual([]);
    });
});
