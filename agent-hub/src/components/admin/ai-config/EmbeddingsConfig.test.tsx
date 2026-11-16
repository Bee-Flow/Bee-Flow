import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EmbeddingsConfig from './EmbeddingsConfig';
import { expectedEmbeddingDims, exceedsVectorIndex } from './embeddingOutputDims';
import { withQueryClient } from '@/test/queryWrapper';

// The catalog rows GET /ai/providers/:id/models returns for Scaleway.
const QWEN = { id: 'qwen3-embedding-8b', name: 'Qwen3 Embedding 8B', providerId: 'scw', embedding: true, dims: 4096, matryoshka: { min: 32, max: 4096 } };
const GEMMA = { id: 'bge-multilingual-gemma2', name: 'BGE Multilingual Gemma2', providerId: 'scw', embedding: true, dims: 3584, matryoshka: null };
const PROVIDERS = [{ id: 'scw', name: 'Scaleway', type: 'scaleway' }];

let stored: Record<string, unknown> = {};

beforeEach(() => {
    stored = { embeddingProviderId: 'scw', embeddingModel: '', embeddingDimensions: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(stored), { status: 200, headers: { 'content-type': 'application/json' } })));
});

const renderConfig = () => render(withQueryClient(
    <EmbeddingsConfig providers={PROVIDERS} allModels={[QWEN, GEMMA]} fetchAllModels={() => {}} />,
));

describe('expectedEmbeddingDims', () => {
    it('a newly chosen Matryoshka model over the limit is shortened to 1536', () => {
        expect(expectedEmbeddingDims(QWEN)).toBe(1536);
        expect(expectedEmbeddingDims(GEMMA)).toBe(3584);
        expect(expectedEmbeddingDims({ dims: 1024 })).toBe(1024);
        expect(expectedEmbeddingDims(undefined)).toBeNull();
    });

    it('the saved model keeps the length the server reports, its own when none', () => {
        expect(expectedEmbeddingDims(QWEN, null)).toBe(4096);
        expect(expectedEmbeddingDims(QWEN, 1536)).toBe(1536);
    });

    it('only a length above 2000 exceeds the index', () => {
        expect(exceedsVectorIndex(2000)).toBe(false);
        expect(exceedsVectorIndex(2001)).toBe(true);
        expect(exceedsVectorIndex(null)).toBe(false);
    });
});

describe('EmbeddingsConfig: the index warning', () => {
    it('warns for a model that cannot be shortened, not for one that can', async () => {
        const user = userEvent.setup();
        renderConfig();
        const select = await screen.findByLabelText('Embedding Model');
        expect(screen.queryByRole('status')).toBeNull();

        await user.selectOptions(select, GEMMA.id);
        expect(screen.getByRole('status').textContent).toContain('3584 dimensions');
        expect(screen.getByRole('status').textContent).toContain('cannot use the fast index');

        await user.selectOptions(select, QWEN.id);
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('warns for a saved configuration that still runs at the full length', async () => {
        stored = { embeddingProviderId: 'scw', embeddingModel: QWEN.id, embeddingDimensions: null };
        renderConfig();
        expect((await screen.findByRole('status')).textContent).toContain('4096 dimensions');
    });
});

describe('EmbeddingsConfig: only providers that can embed', () => {
    const MIXED = [
        ...PROVIDERS,
        { id: 'anth', name: 'Anthropic', type: 'claude' },
        { id: 'mis', name: 'Mistral', type: 'mistral' },
        { id: 'az', name: 'Azure', type: 'azure' },
    ];
    const MIXED_MODELS = [
        QWEN, GEMMA,
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', providerId: 'anth' },
        { id: 'mistral-embed', name: 'Mistral Embed', providerId: 'mis', cat: 'Embedding' },
        { id: 'mistral-large-latest', name: 'Mistral Large', providerId: 'mis' },
    ];
    const renderMixed = () => render(withQueryClient(
        <EmbeddingsConfig providers={MIXED} allModels={MIXED_MODELS} fetchAllModels={() => {}} />,
    ));

    it('leaves out a provider without embedding models and keeps Azure', async () => {
        renderMixed();
        const select = await screen.findByLabelText('Embedding Provider');
        const names = Array.from(select.querySelectorAll('option')).map(o => o.value).filter(Boolean);
        expect(names).toEqual(['scw', 'mis', 'az']);
    });

    it('shows the Mistral hint only for Mistral, a neutral hint for the others', async () => {
        const user = userEvent.setup();
        renderMixed();
        expect(await screen.findByText(/Pick an embedding model this provider offers/)).toBeTruthy();
        expect(screen.queryByText(/mistral-embed/)).toBeNull();
        await user.selectOptions(screen.getByLabelText('Embedding Provider'), 'mis');
        expect(screen.getByText(/"mistral-embed" is recommended/)).toBeTruthy();
        const models = Array.from(screen.getByLabelText('Embedding Model').querySelectorAll('option')).map(o => o.value).filter(Boolean);
        expect(models).toEqual(['mistral-embed']);
    });

    it('says so when no connected provider offers embeddings', async () => {
        render(withQueryClient(
            <EmbeddingsConfig providers={[{ id: 'anth', name: 'Anthropic', type: 'claude' }]} allModels={[{ id: 'claude-sonnet-4-6', providerId: 'anth' }]} fetchAllModels={() => {}} />,
        ));
        expect(await screen.findByText(/No connected provider offers embedding models/)).toBeTruthy();
    });
});
