import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import KnowledgeStudio from './index';
import { knowledgeApi } from './knowledgeApi';
import scopedStorage from '../../../../utils/scopedStorage';

vi.mock('./knowledgeApi', () => {
    const knowledgeApi = {
        list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
        setPublished: vi.fn(), remove: vi.fn(), categories: vi.fn(),
        listSources: vi.fn(), createSource: vi.fn(), updateSource: vi.fn(),
        removeSource: vi.fn(), refreshSource: vi.fn(), uploadFiles: vi.fn(),
        listSourceDocuments: vi.fn(), getSourceDocument: vi.fn(),
        documentContent: vi.fn(), removeDocument: vi.fn(),
        usage: vi.fn(), usageSummary: vi.fn(), suggestions: vi.fn(),
    };
    return { knowledgeApi, default: knowledgeApi };
});

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
}));

/**
 * Three screens behind one route. What is pinned is the routing itself:
 * which screen a URL lands on, that navigation writes the URL back, and that
 * `/new` — where the Studio "New" menu sends people — actually makes one.
 */

const KB = { id: 'kb1', name: 'Quote terms', is_published: false, shared_groups: [], lastContentAt: null };
const SOURCE = { id: 's1', kind: 'upload', name: 'Uploaded files', config: {}, refreshMode: 'manual', documentCount: 2 };

beforeEach(() => {
    vi.clearAllMocks();
    knowledgeApi.list.mockResolvedValue([KB]);
    knowledgeApi.categories.mockResolvedValue([]);
    knowledgeApi.get.mockResolvedValue(KB);
    knowledgeApi.listSources.mockResolvedValue({ sources: [SOURCE], totals: { sourceCount: 1, documentCount: 2, autoRefreshCount: 0 } });
    knowledgeApi.listSourceDocuments.mockResolvedValue({ documents: [], total: 0 });
    knowledgeApi.usageSummary.mockResolvedValue({ summary: {} });
    knowledgeApi.suggestions.mockResolvedValue({ suggestions: [] });
});

describe('KnowledgeStudio routing', () => {
    it('shows the overview with no id', async () => {
        render(<KnowledgeStudio />);
        expect(await screen.findByTestId('kb-overview')).toBeTruthy();
    });

    it('shows a knowledge base for an id', async () => {
        render(<KnowledgeStudio initialKbId="kb1" />);
        expect(await screen.findByTestId('kb-detail-page')).toBeTruthy();
    });

    it('shows a source for an id and a source id', async () => {
        render(<KnowledgeStudio initialKbId="kb1" initialKbTab="sources" initialSourceId="s1" />);
        expect(await screen.findByTestId('kb-source-detail')).toBeTruthy();
    });

    it('falls back to the sources tab for a tab segment it does not know', async () => {
        // A stale or hand-typed URL must land somewhere real, not on nothing.
        render(<KnowledgeStudio initialKbId="kb1" initialKbTab="not-a-tab" />);
        await screen.findByTestId('kb-detail-page');
        expect(screen.getByTestId('kb-tab-sources')).toBeTruthy();
    });

    it('drops back to the tab when the source id no longer resolves', async () => {
        const onNavigate = vi.fn();
        render(<KnowledgeStudio initialKbId="kb1" initialKbTab="sources" initialSourceId="gone" onNavigate={onNavigate} />);
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/kb1/sources'));
    });

    it('writes the tab and the source into the URL', async () => {
        const onNavigate = vi.fn();
        render(<KnowledgeStudio initialKbId="kb1" onNavigate={onNavigate} />);
        await screen.findByTestId('kb-tab-sources');
        fireEvent.click(screen.getByText('Uploaded files'));
        expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/kb1/sources/s1');
    });

    it('lets Back out of a knowledge base', async () => {
        // Adopting only truthy ids leaves the detail on screen after Back.
        const onNavigate = vi.fn();
        const { rerender } = render(<KnowledgeStudio initialKbId="kb1" onNavigate={onNavigate} />);
        await screen.findByTestId('kb-detail-page');
        rerender(<KnowledgeStudio initialKbId={null} onNavigate={onNavigate} />);
        expect(await screen.findByTestId('kb-overview')).toBeTruthy();
    });

    it('creates one and opens it on /new — there is no create form to land on', async () => {
        // studioApps.jsx's "New knowledge base" navigates here. It used to
        // render the overview with its create button disabled, which is the
        // one screen where the button had to work.
        knowledgeApi.create.mockResolvedValue({ id: 'kb_new' });
        const onNavigate = vi.fn();
        render(<KnowledgeStudio initialKbId="new" onNavigate={onNavigate} />);
        await waitFor(() => expect(knowledgeApi.create).toHaveBeenCalled());
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/kb_new/sources'));
    });

    it('does not create on /new without manage_knowledge', async () => {
        render(<KnowledgeStudio initialKbId="new" hasPermission={() => false} />);
        await screen.findByTestId('kb-overview');
        expect(knowledgeApi.create).not.toHaveBeenCalled();
    });

    it('reports a failed create instead of retrying it forever', async () => {
        knowledgeApi.create.mockRejectedValue(new Error('quota reached'));
        render(<KnowledgeStudio initialKbId="new" />);
        expect(await screen.findByText('quota reached')).toBeTruthy();
        await new Promise(r => setTimeout(r, 50));
        expect(knowledgeApi.create).toHaveBeenCalledTimes(1);
    });
});

/**
 * The overview's nudge (K5): a suggestion on a front page is seen far more
 * often than it is acted on, so what matters is that it can be waved away,
 * that accepting it goes through the ordinary agent save (and therefore the
 * ordinary validation), and that a failure to load it costs the nudge and
 * nothing else.
 */
describe('the suggestion banner', () => {
    const SUGGESTION = { kbId: 'kb1', kbName: 'Nextcloud handleidingen', agentId: 'ag1', agentName: 'Nextcloud Buddy', score: 2 };

    beforeEach(() => {
        // scopedStorage is per-account by design and a no-op with no user
        // registered, so a dismissal only persists for somebody signed in —
        // which is every real visit to this screen.
        scopedStorage.setCurrentUser('u1');
        scopedStorage.removeItem('knowledge.suggestions.hidden');
    });

    it('shows the highest-scoring nudge on the overview', async () => {
        knowledgeApi.suggestions.mockResolvedValue({ suggestions: [SUGGESTION] });
        render(<KnowledgeStudio />);
        const banner = await screen.findByTestId('kb-suggestion');
        expect(banner.textContent).toMatch(/Nextcloud handleidingen/);
        expect(banner.textContent).toMatch(/Nextcloud Buddy/);
    });

    it('links them through the ordinary agent save', async () => {
        // Not a shortcut that writes the id straight into the config: that
        // would be a second way to attach a knowledge base, and the one that
        // skips the usage-context check.
        knowledgeApi.suggestions.mockResolvedValue({ suggestions: [SUGGESTION] });
        const { authFetch } = await import('../../../../utils/helpers');
        authFetch.mockImplementation(async (url, opts) => ({
            ok: true, status: 200,
            json: async () => (opts?.method === 'PUT' ? {} : { id: 'ag1', config: { knowledge_base_ids: ['kb_other'] } }),
        }));

        render(<KnowledgeStudio />);
        fireEvent.click(await screen.findByText(/link them/i));

        await waitFor(() => {
            const put = authFetch.mock.calls.find(([, o]) => o?.method === 'PUT');
            expect(put).toBeTruthy();
            expect(JSON.parse(put[1].body).config.knowledge_base_ids).toEqual(['kb_other', 'kb1']);
        });
    });

    it('"Not now" hides it, and it stays hidden on the next visit', async () => {
        knowledgeApi.suggestions.mockResolvedValue({ suggestions: [SUGGESTION] });
        const first = render(<KnowledgeStudio user={{ id: 'u1' }} />);
        fireEvent.click(await screen.findByTestId('kb-suggestion-dismiss'));
        await waitFor(() => expect(screen.queryByTestId('kb-suggestion')).toBeNull());
        first.unmount();

        render(<KnowledgeStudio user={{ id: 'u1' }} />);
        await screen.findByTestId('kb-overview');
        expect(screen.queryByTestId('kb-suggestion')).toBeNull();
    });

    it('one colleague waving a pairing away is not the organisation deciding', async () => {
        // The dismissal is per account, per browser — scopedStorage, not a
        // server flag. A shared "hidden" would let one person silence a nudge
        // for everybody.
        knowledgeApi.suggestions.mockResolvedValue({ suggestions: [SUGGESTION] });
        const mine = render(<KnowledgeStudio user={{ id: 'u1' }} />);
        fireEvent.click(await screen.findByTestId('kb-suggestion-dismiss'));
        await waitFor(() => expect(screen.queryByTestId('kb-suggestion')).toBeNull());
        mine.unmount();

        scopedStorage.setCurrentUser('u2');
        render(<KnowledgeStudio user={{ id: 'u2' }} />);
        expect(await screen.findByTestId('kb-suggestion')).toBeTruthy();
    });

    it('a suggestions call that fails costs the nudge, not the list', async () => {
        knowledgeApi.suggestions.mockRejectedValue(new Error('down'));
        render(<KnowledgeStudio />);
        expect(await screen.findByTestId('kb-overview')).toBeTruthy();
        expect(screen.queryByTestId('kb-suggestion')).toBeNull();
    });

    it('a usage summary that fails leaves the pills off, never "used by nothing"', async () => {
        // The two are opposite claims and only one of them is safe to guess.
        knowledgeApi.usageSummary.mockRejectedValue(new Error('down'));
        render(<KnowledgeStudio />);
        await screen.findByTestId('kb-overview');
        await waitFor(() => expect(screen.queryByTestId('kb-usage-none')).toBeNull());
    });
});
