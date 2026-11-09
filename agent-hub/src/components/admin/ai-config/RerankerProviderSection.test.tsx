import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RerankerProviderSection from './RerankerProviderSection';

const providers = [{ id: 'p1', name: 'IONOS', type: 'ionos' }];
const models = [
    { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama', providerId: 'p1' },
    { id: 'Qwen/Qwen3-VL-Reranker-8B', name: 'Qwen3-VL Reranker 8B', providerId: 'p1', rerank: true },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const setup = (config: Record<string, unknown>, modelList = models) => {
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)));
            return json({ success: true });
        }
        return json(config);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><RerankerProviderSection providers={providers} allModels={modelList} /></QueryClientProvider>);
    return posts;
};

afterEach(() => vi.unstubAllGlobals());

describe('RerankerProviderSection', () => {
    it('offers only rerank models and saves provider and model together', async () => {
        const user = userEvent.setup();
        const posts = setup({});
        await user.selectOptions(screen.getByLabelText('Rerank provider'), 'p1');
        const modelSelect = screen.getByLabelText('Rerank model');
        expect(screen.queryByRole('option', { name: 'Llama' })).toBeNull();
        await user.selectOptions(modelSelect, 'Qwen/Qwen3-VL-Reranker-8B');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(posts).toEqual([{ rerankProviderId: 'p1', rerankModel: 'Qwen/Qwen3-VL-Reranker-8B' }]));
    });

    it('falls back to a free-text model when the provider flags no rerank model', async () => {
        const user = userEvent.setup();
        setup({}, [{ id: 'x', name: 'x', providerId: 'p1' }]);
        await user.selectOptions(screen.getByLabelText('Rerank provider'), 'p1');
        expect(screen.getByLabelText('Rerank model').tagName).toBe('INPUT');
    });

    it('turns the tier off by sending both fields empty', async () => {
        const user = userEvent.setup();
        const posts = setup({ rerankProviderId: 'p1', rerankModel: 'Qwen/Qwen3-VL-Reranker-8B' });
        await user.click(await screen.findByRole('button', { name: 'Turn off' }));
        await waitFor(() => expect(posts).toEqual([{ rerankProviderId: '', rerankModel: '' }]));
    });
});
