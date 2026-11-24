// The Settings tab of an item: four plain headed sections (how it starts, people, budget, changes), each open, and
// the budget read-only with the way to the edit form. The network is the seam (a recording fetch), no module is
// mocked.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkSettings from './CoworkSettings';
import type { CoworkItem } from '@/api/cowork.types';

const ITEM = { id: 'w1', title: 'Order log', prompt: 'Log it.', isActive: true } as CoworkItem;

let calls: RecordedCall[];
function serve() {
    calls = stubRecordingFetch(({ url }) => {
        if (url.endsWith('/colleagues')) return jsonResponse({ colleagues: [{ id: 'bob', name: 'Bob' }] });
        if (url.endsWith('/shares')) return jsonResponse({ shares: [] });
        if (url.endsWith('/audit')) return jsonResponse({ entries: [] });
        return jsonResponse({ kind: 'schedule', after: null, datatableId: null, inFolder: null, hasAddress: false });
    });
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkSettings', () => {
    it('has the four sections as headed blocks, none of them folded', async () => {
        serve();
        const { container } = renderWithClient(<CoworkSettings item={ITEM} onEdit={() => {}} />);
        const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
        expect(headings).toEqual(['How it starts', 'People', 'Budget', 'Changes']);
        for (const name of ['How it starts', 'People', 'Budget', 'Changes']) {
            expect(screen.getByRole('region', { name })).toBeInTheDocument();
        }
        expect(container.querySelector('details')).toBeNull();
        const people = screen.getByRole('region', { name: 'People' });
        expect(within(people).getByTestId('cowork-share')).toBeInTheDocument();
        expect(within(people).getByRole('heading', { name: 'Work on this together' })).toBeInTheDocument();
        expect(within(people).getByTestId('cowork-hand-over')).toBeInTheDocument();
        expect(await screen.findByLabelText('Starts')).toBeInTheDocument();
    });

    it('reads its panels once it is shown', async () => {
        serve();
        renderWithClient(<CoworkSettings item={ITEM} onEdit={() => {}} />);
        await vi.waitFor(() => {
            const urls = calls.map((c) => c.url);
            expect(urls.some((u) => u.endsWith('/api/cowork/w1/shares'))).toBe(true);
            expect(urls.some((u) => u.endsWith('/api/cowork/w1/hand-over/colleagues'))).toBe(true);
            expect(urls.some((u) => u.includes('/api/cowork/w1/start'))).toBe(true);
            expect(urls.some((u) => u.endsWith('/api/cowork/w1/audit'))).toBe(true);
        });
    });

    it('shows the monthly budget read-only, and Edit is where it changes', async () => {
        serve();
        const onEdit = vi.fn();
        renderWithClient(<CoworkSettings item={{ ...ITEM, monthlyBudget: 25 }} onEdit={onEdit} />);
        const budget = screen.getByRole('region', { name: 'Budget' });
        expect(budget).toHaveTextContent('€25.00 a month on AI');
        expect(within(budget).queryByRole('textbox')).toBeNull();
        await userEvent.setup().click(within(budget).getByRole('button', { name: 'Change it in Edit' }));
        expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it('says when there is no budget', () => {
        serve();
        renderWithClient(<CoworkSettings item={{ ...ITEM, monthlyBudget: null }} onEdit={() => {}} />);
        expect(screen.getByRole('region', { name: 'Budget' })).toHaveTextContent('No limit on what it may spend on AI.');
    });
});
