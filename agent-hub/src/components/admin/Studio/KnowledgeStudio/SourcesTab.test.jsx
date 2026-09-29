import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import SourcesTab from './SourcesTab';

/**
 * The source table's job is to let someone pick the RIGHT row out of five,
 * so the sublines — a different sentence per kind — and the refresh cell
 * are what is pinned here.
 */

const src = (over = {}) => ({
    id: 's1', kind: 'upload', name: 'Uploaded files', config: {},
    refreshMode: 'manual', status: 'idle', documentCount: 3,
    lastRefreshAt: new Date(Date.now() - 120_000).toISOString(),
    ...over,
});

describe('SourcesTab', () => {
    it('gives each kind its own second line', () => {
        render(<SourcesTab sources={[
            src({ id: 'a', kind: 'nextcloud_folder', name: 'Nextcloud · /Sales', documentCount: 38 }),
            src({ id: 'b', kind: 'datatable', name: 'Price list', documentCount: 212, config: { columns: ['Item', 'Price'], tableName: 'Prices' } }),
            src({ id: 'c', kind: 'meeting_tag', name: 'Tagged meetings', documentCount: 6, config: { tag: 'quotes', fields: ['summary', 'decisions'] } }),
            src({ id: 'd', kind: 'webpage', name: 'example.com/terms', documentCount: 1 }),
            src({ id: 'e', kind: 'text', name: 'FAQ', config: {}, createdBy: { id: 'u1', name: 'Tessa' } }),
        ]} />);
        expect(screen.getByText(/folder · 38 files/)).toBeTruthy();
        expect(screen.getByText(/columns Item, Price · 212 rows/)).toBeTruthy();
        // Built from the fields the source actually stores. It used to read
        // `config.mode`, and its other branch promised "full transcripts" —
        // which K7 never offers, deliberately.
        expect(screen.getByText(/summary, decisions · 6 meetings/)).toBeTruthy();
        expect(screen.getByText(/web page · 1 page/)).toBeTruthy();
        expect(screen.getByText(/pasted text · by Tessa/)).toBeTruthy();
    });

    it('says how each source refreshes, in its own words', () => {
        render(<SourcesTab sources={[
            src({ id: 'a', refreshMode: 'on_change' }),
            src({ id: 'b', refreshMode: 'live' }),
            src({ id: 'c', refreshMode: 'after_meeting' }),
            src({ id: 'd', refreshMode: 'schedule', refreshCron: '0 6 * * 1' }),
            src({ id: 'e', refreshMode: 'manual' }),
        ]} />);
        expect(screen.getByText('on change')).toBeTruthy();
        expect(screen.getByText('live')).toBeTruthy();
        expect(screen.getByText('after every meeting')).toBeTruthy();
        expect(screen.getByText('on a schedule')).toBeTruthy();
        expect(screen.getByText('manual')).toBeTruthy();
    });

    it('says "always current" for a live source rather than a stale timestamp', () => {
        render(<SourcesTab sources={[src({ refreshMode: 'live', lastRefreshAt: null })]} />);
        expect(screen.getByText('always current')).toBeTruthy();
    });

    it('never mentions chunks or re-indexing', () => {
        // Both were removed from Studio on purpose: they are facts about the
        // retrieval implementation, not about the person's material.
        const { container } = render(<SourcesTab sources={[src()]} totals={{ sourceCount: 1, documentCount: 3, autoRefreshCount: 0 }} />);
        expect(container.textContent).not.toMatch(/chunk/i);
        expect(container.textContent).not.toMatch(/re-?index/i);
    });

    it('summarises the sources above the table', () => {
        render(<SourcesTab sources={[src()]} totals={{ sourceCount: 5, documentCount: 61, autoRefreshCount: 3 }} />);
        expect(screen.getByText('5 sources · 61 documents · 3 refresh automatically')).toBeTruthy();
    });

    it('offers the row menu only to someone who can manage', () => {
        const { unmount } = render(<SourcesTab sources={[src()]} canManage={false} />);
        expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
        unmount();
        render(<SourcesTab sources={[src()]} canManage />);
        expect(screen.getByRole('button', { name: 'Actions for Uploaded files' })).toBeTruthy();
    });

    it('opens a source from its row', () => {
        const onOpen = vi.fn();
        render(<SourcesTab sources={[src()]} onOpen={onOpen} />);
        fireEvent.click(screen.getByText('Uploaded files'));
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    });

    it('marks a refreshing row so it can be seen working', () => {
        render(<SourcesTab sources={[src({ status: 'refreshing' })]} />);
        expect(screen.getByTestId('kb-source-row').dataset.status).toBe('refreshing');
    });

    it('invites a first source instead of showing an empty table', () => {
        render(<SourcesTab sources={[]} />);
        expect(screen.getByText(/No sources yet/)).toBeTruthy();
    });

    it('filters by name', () => {
        render(<SourcesTab sources={[src({ id: 'a', name: 'Quotes' }), src({ id: 'b', name: 'Warranty' })]} />);
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'warr' } });
        const rows = screen.getAllByTestId('kb-source-row');
        expect(rows).toHaveLength(1);
        expect(within(rows[0]).getByText('Warranty')).toBeTruthy();
    });
});

it('a meeting source says which parts of a meeting it holds', () => {
    // "6 meetings" alone does not tell somebody whether the open questions
    // are in there, and that is exactly what they came to check.
    render(<SourcesTab sources={[
        src({ id: 'a', kind: 'meeting_tag', name: 'Sales', documentCount: 6, config: { tag: 'sales', fields: ['summary', 'questions'] } }),
    ]} />);
    expect(screen.getByText(/summary, open questions · 6 meetings/)).toBeTruthy();
});

it('a meeting source with no stored fields reads as the default, not as empty', () => {
    render(<SourcesTab sources={[
        src({ id: 'a', kind: 'meeting_tag', name: 'Sales', documentCount: 1, config: { tag: 'sales' } }),
    ]} />);
    expect(screen.getByText(/summary, decisions · 1 meeting/)).toBeTruthy();
});
