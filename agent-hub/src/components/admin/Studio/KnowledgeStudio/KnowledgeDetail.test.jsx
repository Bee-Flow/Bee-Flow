import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import KnowledgeDetail from './KnowledgeDetail';
import { knowledgeApi } from './knowledgeApi';

vi.mock('./knowledgeApi', () => {
    const knowledgeApi = {
        list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
        setPublished: vi.fn(), remove: vi.fn(), categories: vi.fn(),
        listSources: vi.fn(), createSource: vi.fn(), updateSource: vi.fn(),
        removeSource: vi.fn(), refreshSource: vi.fn(), uploadFiles: vi.fn(),
        listSourceDocuments: vi.fn(), getSourceDocument: vi.fn(),
        documentContent: vi.fn(), removeDocument: vi.fn(),
    };
    return { knowledgeApi, default: knowledgeApi };
});

// useUsage's default transport goes through authFetch; K5 lands the endpoint,
// so until then a 404 is the honest answer and the tab must survive it.
vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) })),
}));

const KB = {
    id: 'kb1', name: 'Quote terms', is_published: false, shared_groups: [],
    lastContentAt: new Date(Date.now() - 120_000).toISOString(),
};

beforeEach(() => {
    vi.clearAllMocks();
    knowledgeApi.get.mockResolvedValue(KB);
    knowledgeApi.listSources.mockResolvedValue({
        sources: [{ id: 's1', kind: 'upload', name: 'Uploaded files', config: {}, refreshMode: 'manual', documentCount: 3 }],
        totals: { sourceCount: 5, documentCount: 61, autoRefreshCount: 3 },
    });
});

describe('KnowledgeDetail', () => {
    it('opens the tab it was deep-linked to', async () => {
        render(<KnowledgeDetail kbId="kb1" tab="usage" />);
        await screen.findByTestId('kb-detail-page');
        expect(screen.getByTestId('used-by')).toBeTruthy();
        expect(screen.queryByTestId('kb-tab-sources')).toBeNull();
    });

    it('reports a tab change so the caller can put it in the URL', async () => {
        // A tab held only in state is a tab nobody can link to — and "what
        // still uses this" is exactly the screen people send each other.
        const onTab = vi.fn();
        render(<KnowledgeDetail kbId="kb1" tab="sources" onTab={onTab} />);
        await screen.findByTestId('kb-tab-sources');
        fireEvent.click(screen.getByRole('radio', { name: /Used by/ }));
        expect(onTab).toHaveBeenCalledWith('usage');
    });

    it('counts the sources on the tab strip', async () => {
        render(<KnowledgeDetail kbId="kb1" />);
        const tab = await screen.findByRole('radio', { name: /Sources/ });
        expect(tab.textContent).toMatch(/5/);
    });

    it('dates the header from content, not from the last rename', async () => {
        render(<KnowledgeDetail kbId="kb1" />);
        expect(await screen.findByText(/Updated/)).toBeTruthy();
    });

    it('says so plainly when nothing has ever been added', async () => {
        knowledgeApi.get.mockResolvedValue({ ...KB, lastContentAt: null });
        render(<KnowledgeDetail kbId="kb1" />);
        expect(await screen.findByText('Nothing in it yet')).toBeTruthy();
    });

    it('keeps the page usable when the sources call fails', async () => {
        // The header, the audience capsule and the other tabs all still
        // work; replacing the page with one error hides the controls needed
        // to fix whatever broke.
        knowledgeApi.listSources.mockRejectedValue(new Error('sources are down'));
        render(<KnowledgeDetail kbId="kb1" />);
        expect(await screen.findByText('sources are down')).toBeTruthy();
        expect(screen.getByText('Quote terms')).toBeTruthy();
        expect(screen.getByRole('radio', { name: /Used by/ })).toBeTruthy();
    });

    it('reuses the existing upload bucket instead of making a second one', async () => {
        // The ingest wrappers always attach to the OLDEST upload source; a
        // second "Uploaded files" beside the first is two piles of the same
        // thing with no way to tell them apart.
        knowledgeApi.uploadFiles.mockResolvedValue({ accepted: 1, documents: [] });
        render(<KnowledgeDetail kbId="kb1" canManage />);
        await screen.findByTestId('kb-tab-sources');
        fireEvent.click(screen.getByTestId('kb-add-kind-upload'));
        const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
        fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });
        await waitFor(() => expect(knowledgeApi.uploadFiles).toHaveBeenCalledWith('kb1', 's1', [file]));
        expect(knowledgeApi.createSource).not.toHaveBeenCalled();
    });

    it('creates an upload bucket the first time there is none', async () => {
        knowledgeApi.listSources.mockResolvedValue({ sources: [], totals: null });
        knowledgeApi.createSource.mockResolvedValue({ source: { id: 's_new', kind: 'upload' } });
        knowledgeApi.uploadFiles.mockResolvedValue({ accepted: 1, documents: [] });
        render(<KnowledgeDetail kbId="kb1" canManage />);
        await screen.findByTestId('kb-tab-sources');
        fireEvent.click(screen.getByTestId('kb-add-kind-upload'));
        const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
        fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });
        await waitFor(() => expect(knowledgeApi.createSource).toHaveBeenCalledWith('kb1', expect.objectContaining({ kind: 'upload' })));
        await waitFor(() => expect(knowledgeApi.uploadFiles).toHaveBeenCalledWith('kb1', 's_new', [file]));
    });

    it('adds a pasted-text source', async () => {
        knowledgeApi.createSource.mockResolvedValue({ source: { id: 's2' } });
        render(<KnowledgeDetail kbId="kb1" canManage />);
        await screen.findByTestId('kb-tab-sources');
        fireEvent.click(screen.getByTestId('kb-add-kind-text'));
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'FAQ' } });
        fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Quotes are valid 30 days.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
        await waitFor(() => expect(knowledgeApi.createSource).toHaveBeenCalledWith('kb1', {
            kind: 'text', name: 'FAQ', config: { text: 'Quotes are valid 30 days.' },
        }));
    });

    it('turns the licence cap into a sentence with the number in it', async () => {
        // A cap that says only "too many" tells you nothing you can act on.
        const err = new Error('limit');
        err.code = 'source_limit_reached';
        err.body = { limit: 5 };
        knowledgeApi.createSource.mockRejectedValue(err);
        render(<KnowledgeDetail kbId="kb1" canManage />);
        await screen.findByTestId('kb-tab-sources');
        fireEvent.click(screen.getByTestId('kb-add-kind-text'));
        fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'hello there' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
        expect(await screen.findByText(/the most sources your plan allows \(5\)/)).toBeTruthy();
    });

    it('shows every source kind, with the unbuilt ones disabled', async () => {
        // Hiding them teaches that the product cannot do it; leaving them
        // live teaches that the product is broken. Greyed is the true one.
        render(<KnowledgeDetail kbId="kb1" canManage />);
        await screen.findByTestId('kb-tab-sources');
        // `meeting_tag` went live with K7, `datatable` with K8 and
        // `automation` with K10 — as a SIGNPOST, not a form, but live either
        // way. Still ahead: K9 (nextcloud_folder).
        for (const kind of ['text', 'upload', 'webpage', 'meeting_tag', 'datatable', 'automation']) {
            expect(screen.getByTestId(`kb-add-kind-${kind}`).dataset.disabled).toBe('false');
        }
        expect(screen.getByTestId('kb-add-kind-nextcloud_folder').dataset.disabled).toBe('true');
    });

    it('the automation card explains where the step lives instead of asking for one', async () => {
        // The relationship is backwards from every other card: an automation adds
        // itself. Somebody told "you cannot add this one" needs to know what
        // to do instead, in the same breath.
        render(<KnowledgeDetail kbId="kb1" canManage />);
        await screen.findByTestId('kb-tab-sources');
        fireEvent.click(screen.getByTestId('kb-add-kind-automation'));
        const panel = await screen.findByTestId('kb-signpost-automation');
        expect(panel.textContent).toMatch(/To knowledge base/);
        expect(screen.getByTestId('kb-signpost-automation-link')).toBeTruthy();
    });

    it('offers no source-adding at all without manage_knowledge', async () => {
        render(<KnowledgeDetail kbId="kb1" canManage={false} />);
        await screen.findByTestId('kb-tab-sources');
        expect(screen.getByTestId('kb-add-kind-text').dataset.disabled).toBe('true');
        expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    });

    it('makes the header action move focus to the add-source panel', async () => {
        // It used to be a <span> painted like a button: pressable-looking,
        // inert, and unreachable from the keyboard.
        render(<KnowledgeDetail kbId="kb1" canManage />);
        await screen.findByTestId('kb-tab-sources');
        const header = screen.getByTestId('studio-section-header');
        fireEvent.click(within(header).getByRole('button', { name: /Add a source/ }));
        expect(screen.getByTestId('kb-add-source').contains(document.activeElement)).toBe(true);
    });

    it('never shows chunks or a re-index button', async () => {
        const { container } = render(<KnowledgeDetail kbId="kb1" canManage />);
        await screen.findByTestId('kb-tab-sources');
        expect(container.textContent).not.toMatch(/chunk/i);
        expect(container.textContent).not.toMatch(/re-?index/i);
    });
});
