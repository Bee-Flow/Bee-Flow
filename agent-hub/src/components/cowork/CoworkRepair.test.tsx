// A repair in the item's "Needs you" strip: one line, then the steps that change, what it may newly do and how it did
// on the past runs, with Approve / Not now. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkRepair from './CoworkRepair';
import type { CoworkProposal } from '@/api/coworkProposals';

const REPAIR: CoworkProposal = {
    id: 'pr-1', kind: 'repair', reasonCode: 'step_failed_twice', stepId: 'orders', stepTitle: 'Read the order table', status: 'open',
    fingerprint: 'f'.repeat(64), createdAt: '2026-11-24T08:00:00.000Z', decidedAt: null,
    changes: [{ id: 'orders', title: 'Read the order table', kind: 'fixed', change: 'changed' }],
    widens: ['google-drive: reads (drive_read)'],
    replay: { done: true, total: 2, same: 0, differs: 2, partial: 0, notReplayable: 0 },
    undoVersion: null,
};

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkRepair', () => {
    it('says what failed, and opens to what changes, what it may newly do and the replay', async () => {
        calls = stubRecordingFetch(() => jsonResponse({ proposals: [] }));
        renderWithClient(<CoworkRepair coworkId="w1" proposal={REPAIR} />);
        expect(screen.getByTestId('cowork-repair-line')).toHaveTextContent("Failed twice at 'Read the order table'. A fix is ready.");
        expect(screen.queryByTestId('cowork-proposal-details')).toBeNull();
        await userEvent.setup().click(screen.getByRole('button', { name: 'See the fix' }));
        expect(screen.getByTestId('cowork-proposal-change-orders')).toHaveTextContent('Changed · Read the order table');
        expect(screen.getByTestId('cowork-proposal-widens')).toHaveTextContent('google-drive: reads (drive_read)');
        expect(screen.getByTestId('cowork-proposal-replay')).toHaveTextContent('Replayed on 2 past runs: 0 the same, 2 different.');
        expect(screen.getByText('Nothing changes until you approve it.')).toBeInTheDocument();
        expect(calls).toEqual([]);
    });

    it('approve sends the fingerprint looked at; Not now puts it aside', async () => {
        calls = stubRecordingFetch(() => jsonResponse({ proposals: [] }));
        renderWithClient(<CoworkRepair coworkId="w1" proposal={REPAIR} />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'See the fix' }));
        await user.click(screen.getByRole('button', { name: 'Approve the fix' }));
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/cowork/w1/proposals/pr-1/approve'))).toBe(true));
        expect(calls.find((c) => c.url.endsWith('/approve'))?.body).toEqual({ fingerprint: REPAIR.fingerprint });
        await user.click(screen.getByRole('button', { name: 'Not now' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/cowork/w1/proposals/pr-1/dismiss'))).toBe(true));
    });

    it('a refusal is said in the server\'s words', async () => {
        calls = stubRecordingFetch(() => jsonResponse({ error: 'The plan changed since this was proposed, so the proposal no longer fits it.', code: 'cowork_proposal_stale' }, 409));
        renderWithClient(<CoworkRepair coworkId="w1" proposal={REPAIR} />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'See the fix' }));
        await user.click(screen.getByRole('button', { name: 'Approve the fix' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('The plan changed since this was proposed');
    });
});
