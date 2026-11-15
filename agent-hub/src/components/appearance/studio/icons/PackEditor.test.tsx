import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { PackEditor } from './PackEditor';

/**
 * The pack editor offers AI generation only when the server has an image
 * model configured (GET /ai/user-settings `hasImageGen`), and its model
 * choice is the server's list (`imageModels`), not a fixed set of one
 * provider's ids.
 */

const fetchMock = vi.fn();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const PACK = { id: 'p1', name: 'Mine', icons: {} };
const CATEGORIES = [{ name: 'Tools', entries: [{ id: 'tools.search', label: 'Search', defaultEmoji: '🔍' }] }];

function serve(userSettings: Record<string, unknown>) {
    fetchMock.mockImplementation(async (url: string) => {
        const path = new URL(String(url), 'http://x').pathname;
        if (path.endsWith('/ai/user-settings')) return json(userSettings);
        if (path.endsWith('/api/icons')) return json({ packs: [PACK], activeIconPackId: null, categories: CATEGORIES });
        return json({});
    });
}

const renderEditor = () => render(withQueryClient(
    <PackEditor packId="p1" categories={CATEGORIES} isActive={false} onExport={vi.fn()} onPackChanged={vi.fn()} />,
));

describe('PackEditor AI generation', () => {
    beforeEach(() => {
        cleanup();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    // Choosing the pack you use moved to Settings > Appearance: the editor offers no switch of its own.
    it('has no button to make the pack the active one', async () => {
        serve({ hasGoogleKey: false, hasImageGen: false, imageModels: [] });
        renderEditor();
        expect(await screen.findByText('Editing "Mine"')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /set as active/i })).not.toBeInTheDocument();
    });

    it('shows no AI generation when no image model is configured', async () => {
        serve({ hasGoogleKey: false, hasImageGen: false, imageModels: [] });
        renderEditor();
        expect(await screen.findByText('Editing "Mine"')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Generate with AI' })).not.toBeInTheDocument();
    });

    it('offers the configured image models, under neutral labels', async () => {
        const user = userEvent.setup();
        serve({
            hasGoogleKey: false,
            hasImageGen: true,
            imageModels: [{ id: 'azure/icons-deploy', label: 'gpt-image-1.5 (icons-deploy)', provider: 'azure' }],
        });
        renderEditor();
        await user.click(await screen.findByRole('button', { name: 'Generate with AI' }));

        expect(screen.getByRole('dialog', { name: 'Generate all icons with AI' })).toBeInTheDocument();
        const select = screen.getByRole('combobox', { name: 'Image model' });
        expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['azure/icons-deploy']);
        expect(screen.queryByText(/Nano Banana/)).not.toBeInTheDocument();
    });
});
