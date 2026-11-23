// "Waiting for you" on the Cowork home: the list from the server, each entry with the place to act on it. The network
// is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkNeedsYou from './CoworkNeedsYou';
import type { CoworkNeed } from '@/api/coworkNeedsYou';

const need = (over: Partial<CoworkNeed>): CoworkNeed => ({ kind: 'review', itemId: 'w1', title: 'Offers', runId: 'r1', since: null, reason: null, plan: null, ...over });

let calls: RecordedCall[];
const serve = (needs: CoworkNeed[]) => { calls = stubRecordingFetch(() => jsonResponse({ needs, count: needs.length })); };

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkNeedsYou', () => {
    it('lists what waits, a decision with a link to Approvals and the rest opening their item', async () => {
        serve([need({ kind: 'decision', itemId: 'w2', title: 'Invoices' }), need({ reason: 'Which discount applies?' }), need({ kind: 'plan', itemId: 'w3', title: 'Weekly report', runId: null, plan: 'first' })]);
        const onOpen = vi.fn();
        renderWithClient(<CoworkNeedsYou onOpen={onOpen} />);
        expect(await screen.findAllByTestId('cowork-need')).toHaveLength(3);
        expect(calls[0].url).toMatch(/\/api\/cowork\/needs-you$/);
        expect(screen.getByRole('link', { name: 'Decide in Approvals' })).toHaveAttribute('href', '/app/studio/approvals');
        expect(screen.getByText('Which discount applies?')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'See the plan' }));
        expect(onOpen).toHaveBeenCalledWith('w3');
    });

    it('says nothing while nothing waits', async () => {
        serve([]);
        renderWithClient(<CoworkNeedsYou onOpen={() => {}} />);
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(screen.queryByTestId('cowork-needs-you')).toBeNull();
    });
});
