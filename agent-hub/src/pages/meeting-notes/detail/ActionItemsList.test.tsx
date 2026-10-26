import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ActionItemsList from './ActionItemsList';

/** "YYYY-MM-DD" `days` from today in the viewer's timezone. */
function localDate(days: number) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe('ActionItemsList due dates', () => {
    afterEach(cleanup);

    it('renders no due chip for items without a spoken deadline', () => {
        render(<ActionItemsList items={[{ id: 'ai-0', text: 'Geen deadline', assignee: 'Tom' }]} />);
        expect(screen.getByText('Geen deadline')).toBeTruthy();
        expect(screen.queryByText(/overdue/i)).toBeNull();
    });

    it('marks a past deadline overdue and leaves a future one neutral', () => {
        render(<ActionItemsList items={[
            { id: 'ai-0', text: 'Te laat', assignee: 'Tom', due: localDate(-1) },
            { id: 'ai-1', text: 'Nog tijd', assignee: 'Sandra', due: localDate(7) },
        ]} />);
        const overdueRow = screen.getByText('Te laat').closest('li');
        expect(within((overdueRow as HTMLElement)).getByText(/overdue/i)).toBeTruthy();
        const futureRow = screen.getByText('Nog tijd').closest('li');
        expect(within((futureRow as HTMLElement)).queryByText(/overdue/i)).toBeNull();
    });

    it('never calls a completed item overdue', () => {
        render(<ActionItemsList items={[{ id: 'ai-0', text: 'Af', due: localDate(-30), done: true }]} />);
        expect(screen.queryByText(/overdue/i)).toBeNull();
    });

    it('does not treat today as overdue (local date, not UTC)', () => {
        render(<ActionItemsList items={[{ id: 'ai-0', text: 'Vandaag', due: localDate(0) }]} />);
        expect(screen.queryByText(/overdue/i)).toBeNull();
    });

    it('sorts dated items by deadline, keeping undated ones in discussion order below', () => {
        render(<ActionItemsList items={[
            { id: 'ai-0', text: 'Geen datum A' },
            { id: 'ai-1', text: 'Later', due: '2026-09-01' },
            { id: 'ai-2', text: 'Geen datum B' },
            { id: 'ai-3', text: 'Eerder', due: '2026-08-01' },
        ]} />);
        const texts = screen.getAllByRole('listitem').map((li) => li.textContent);
        expect(texts[0]).toContain('Eerder');
        expect(texts[1]).toContain('Later');
        expect(texts[2]).toContain('Geen datum A');
        expect(texts[3]).toContain('Geen datum B');
    });

    it('leaves order untouched when nothing has a deadline', () => {
        const onToggle = vi.fn();
        render(<ActionItemsList
            items={[{ id: 'ai-0', text: 'Eerst' }, { id: 'ai-1', text: 'Daarna' }]}
            onToggle={onToggle}
        />);
        const texts = screen.getAllByRole('listitem').map((li) => li.textContent);
        expect(texts[0]).toContain('Eerst');
        expect(texts[1]).toContain('Daarna');
    });
});

/**
 * A point that the latest AI pass no longer produced, but that was kept because
 * someone had ticked it off or corrected the text (M4).
 *
 * Keeping it silently may not happen: then the card claims that the AI has just
 * produced this point, while it comes from an earlier round. Deleting it may not
 * happen either, because then the human input would be gone after all.
 */
describe('ActionItemsList kept-from-an-earlier-pass marker', () => {
    afterEach(cleanup);

    it('marks the item the newest AI pass no longer produced, and only that one', () => {
        render(<ActionItemsList items={[
            { id: 'ai-gen-1', text: 'Contract tekenen', assignee: 'Sandra', done: true, orphaned: true },
            { id: 'ai-0', text: 'Gewoon vers', assignee: 'Tom' },
        ]} />);
        const keptRow = screen.getByText('Contract tekenen').closest('li');
        expect(within((keptRow as HTMLElement)).getByText(/kept/i)).toBeTruthy();
        const freshRow = screen.getByText('Gewoon vers').closest('li');
        expect(within((freshRow as HTMLElement)).queryByText(/kept/i)).toBeNull();
    });

    it('explains why it is still there', () => {
        render(<ActionItemsList items={[{ id: 'ai-gen-1', text: 'Contract tekenen', done: true, orphaned: true }]} />);
        expect(screen.getByTitle(/no longer/i)).toBeTruthy();
    });
});
