import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LimitsConfig from './LimitsConfig';
import { withQueryClient } from '@/test/queryWrapper';

/**
 * Setup status says what the server runs with right now. It read the KB
 * provider and the CPU reranker from the page's unsaved draft, so a click on
 * an option card changed "right now" before anything was saved. It reads the
 * stored configuration only, and each row jumps to the page that sets it.
 */

const STORED = {
    kbProvider: 'local',
    cpuRerankerEnabled: false,
    maxToolRoundsChat: null,
    toolRoundDefaults: { directChat: 15, notebookChat: 15, webpageChat: 20, nativeLoop: 20 },
    embeddingModel: 'mistral-embed',
    embeddingProviderId: 'mis',
    searchProvider: 'node-search',
    hasSerperKey: false,
};

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(STORED), { status: 200, headers: { 'content-type': 'application/json' } })));
});

const row = (label: string) => screen.getByText(label).closest('.\\@container\\/srow') as HTMLElement;

describe('LimitsConfig: setup status', () => {
    it('shows the stored values', async () => {
        render(withQueryClient(<LimitsConfig />));
        await screen.findByText('Setup status');
        expect(within(row('KB provider')).getByText('Local (in-process)')).toBeTruthy();
        expect(within(row('CPU cross-encoder reranker')).getByText('Disabled')).toBeTruthy();
        expect(within(row('Tool calls per chat turn')).getByText('Per-surface defaults (15 in direct chat)')).toBeTruthy();
        expect(within(row('Web search provider')).getByText(/needs Serper key/)).toBeTruthy();
        expect(within(row('Embedding model (global)')).getByText('mistral-embed · mis')).toBeTruthy();
        // Nothing to edit here: the settings live on the pages the rows point at.
        expect(screen.queryByRole('radio')).toBeNull();
        expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    });

    it('jumps to the section that sets a row', async () => {
        const user = userEvent.setup();
        const go = vi.fn();
        render(withQueryClient(<LimitsConfig onNavigateToTab={go} />));
        await screen.findByText('Setup status');
        await user.click(within(row('KB provider')).getByRole('button'));
        expect(go).toHaveBeenLastCalledWith('retrieval');
        await user.click(within(row('Tool calls per chat turn')).getByRole('button'));
        expect(go).toHaveBeenLastCalledWith('direct-chat');
    });
});
