import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import KnowledgeOverview from './KnowledgeOverview';
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

/**
 * The overview answers one question — is each knowledge base actually
 * working — so what is pinned here is the ways it could answer it wrongly:
 * a KB hidden behind a missing chip, an alarm raised on a KB nobody uses,
 * and a categories outage taking the whole list with it.
 */

const MINUTE = 60_000;
const kb = (over = {}) => ({
    id: 'kb1', name: 'Quote terms', category_id: 'c_sales',
    sourceCount: 5, documentCount: 61, lastContentAt: new Date(Date.now() - 2 * MINUTE).toISOString(),
    is_published: false, shared_groups: [],
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    knowledgeApi.categories.mockResolvedValue([
        { id: 'c_sales', name: 'Sales' },
        { id: 'c_support', name: 'Support' },
        { id: 'c_unused', name: 'Legal' },
    ]);
});

describe('KnowledgeOverview', () => {
    it('lists each base with its category, sources, documents and audience', async () => {
        knowledgeApi.list.mockResolvedValue([kb()]);
        render(<KnowledgeOverview />);
        const row = await screen.findByTestId('kb-row');
        expect(within(row).getByText('Quote terms')).toBeTruthy();
        expect(within(row).getByText(/Sales · 5 sources · 61 documents · personal/)).toBeTruthy();
    });

    it('offers an "Uncategorised" chip only when a base is actually in it', async () => {
        knowledgeApi.list.mockResolvedValue([kb()]);
        const { unmount } = render(<KnowledgeOverview />);
        await screen.findByTestId('kb-row');
        expect(screen.queryByRole('button', { name: 'Uncategorised' })).toBeNull();
        unmount();

        knowledgeApi.list.mockResolvedValue([kb(), kb({ id: 'kb2', name: 'Scratch', category_id: null })]);
        render(<KnowledgeOverview />);
        await waitFor(() => expect(screen.getAllByTestId('kb-row')).toHaveLength(2));
        fireEvent.click(screen.getByRole('button', { name: 'Uncategorised' }));
        const rows = screen.getAllByTestId('kb-row');
        expect(rows).toHaveLength(1);
        expect(within(rows[0]).getByText('Scratch')).toBeTruthy();
    });

    it('only offers chips for categories that hold a base', async () => {
        // "Legal" exists but holds nothing: a chip that always lands on an
        // empty list reads as a broken filter.
        knowledgeApi.list.mockResolvedValue([kb()]);
        render(<KnowledgeOverview />);
        await screen.findByTestId('kb-row');
        expect(screen.getByRole('button', { name: 'Sales' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Legal' })).toBeNull();
    });

    it('keeps the list when /categories fails', async () => {
        // Categories are chrome; the list is the page.
        knowledgeApi.list.mockResolvedValue([kb()]);
        knowledgeApi.categories.mockRejectedValue(new Error('boom'));
        render(<KnowledgeOverview />);
        expect(await screen.findByText('Quote terms')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Sales' })).toBeNull();
    });

    it('says when content last arrived', async () => {
        knowledgeApi.list.mockResolvedValue([kb()]);
        render(<KnowledgeOverview />);
        const cell = await screen.findByTestId('kb-freshness');
        expect(cell.dataset.tone).toBe('ok');
        expect(cell.textContent).toMatch(/updated/);
    });

    it('flags an empty base that something depends on', async () => {
        knowledgeApi.list.mockResolvedValue([kb({ documentCount: 0, lastContentAt: null })]);
        render(<KnowledgeOverview usageByKb={{ kb1: { counts: { agent: 1 } } }} />);
        const cell = await screen.findByTestId('kb-freshness');
        expect(cell.dataset.tone).toBe('problem');
        expect(cell.textContent).toMatch(/empty, but in use/);
    });

    it('does not accuse a base of being unused before usage has loaded', async () => {
        // usageByKb null = K5's summary has not answered. "Used by nothing"
        // there would be a wrong accusation dressed as a fact.
        knowledgeApi.list.mockResolvedValue([kb({ documentCount: 0, lastContentAt: null })]);
        render(<KnowledgeOverview usageByKb={null} />);
        const cell = await screen.findByTestId('kb-freshness');
        expect(cell.dataset.tone).not.toBe('problem');
        expect(screen.queryByTestId('kb-usage-none')).toBeNull();
    });

    it('shows the used-by pills once usage is known', async () => {
        knowledgeApi.list.mockResolvedValue([kb()]);
        render(<KnowledgeOverview usageByKb={{ kb1: { counts: { agent: 3, skill: 1 } } }} />);
        const row = await screen.findByTestId('kb-row');
        expect(within(row).getByText(/3\s+agents/)).toBeTruthy();
        expect(within(row).getByText(/1\s+skill/)).toBeTruthy();
    });

    it('marks a base nothing uses, once that is actually known', async () => {
        knowledgeApi.list.mockResolvedValue([kb()]);
        render(<KnowledgeOverview usageByKb={{ kb1: { counts: {} } }} />);
        expect(await screen.findByTestId('kb-usage-none')).toBeTruthy();
    });

    it('hides the search box until the list is long enough to need it', async () => {
        knowledgeApi.list.mockResolvedValue([kb()]);
        const { unmount } = render(<KnowledgeOverview />);
        await screen.findByTestId('kb-row');
        expect(screen.queryByRole('textbox')).toBeNull();
        unmount();

        knowledgeApi.list.mockResolvedValue(
            Array.from({ length: 5 }, (_, i) => kb({ id: `kb${i}`, name: `Base ${i}` })),
        );
        render(<KnowledgeOverview />);
        await waitFor(() => expect(screen.getAllByTestId('kb-row')).toHaveLength(5));
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Base 3' } });
        expect(screen.getAllByTestId('kb-row')).toHaveLength(1);
    });

    it('hides the create button without manage_knowledge', async () => {
        knowledgeApi.list.mockResolvedValue([kb()]);
        render(<KnowledgeOverview hasPermission={() => false} />);
        await screen.findByTestId('kb-row');
        expect(screen.queryByTestId('kb-create')).toBeNull();
    });

    it('keeps the onboarding tour anchor on the create button', async () => {
        // onboarding/tourSteps.js points at [data-tour="knowledge-create"];
        // losing it is a tour that silently stops at step 3.
        knowledgeApi.list.mockResolvedValue([kb()]);
        const { container } = render(<KnowledgeOverview />);
        await screen.findByTestId('kb-row');
        expect(container.querySelector('[data-tour="knowledge-create"]')).toBeTruthy();
    });

    it('opens a base by id', async () => {
        const onOpen = vi.fn();
        knowledgeApi.list.mockResolvedValue([kb()]);
        render(<KnowledgeOverview onOpen={onOpen} />);
        fireEvent.click(await screen.findByTestId('kb-row'));
        expect(onOpen).toHaveBeenCalledWith('kb1');
    });

    it('reports a failed list instead of showing an empty state', async () => {
        // An empty state over a failed load invites the person to create a
        // second copy of something they already have.
        knowledgeApi.list.mockRejectedValue(new Error('offline'));
        render(<KnowledgeOverview />);
        expect(await screen.findByText('offline')).toBeTruthy();
        expect(screen.queryByText(/No knowledge bases yet/)).toBeNull();
    });
});
