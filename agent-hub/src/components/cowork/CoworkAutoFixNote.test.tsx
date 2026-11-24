// The note on an item whose broken reference Cowork fixed by itself: one line and Undo, which approves the version
// before it again. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkAutoFixNote from './CoworkAutoFixNote';
import type { CoworkProposal } from '@/api/coworkProposals';

const FIXED: CoworkProposal = {
    id: 'pr-auto', kind: 'repair', reasonCode: 'reference_fixed', stepId: 'sums', stepTitle: 'Get summaries', status: 'approved',
    fingerprint: 'f'.repeat(64), createdAt: '2026-11-24T08:00:00.000Z', decidedAt: '2026-11-24T08:00:00.000Z',
    changes: [], widens: [], replay: null, undoVersion: 1,
};

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkAutoFixNote', () => {
    it('says what was fixed, and Undo brings the version before it back', async () => {
        calls = stubRecordingFetch((call) => (call.url.endsWith('/plan/restore') ? jsonResponse({}) : jsonResponse({ proposals: [FIXED] })));
        renderWithClient(<CoworkAutoFixNote coworkId="w1" />);
        expect(await screen.findByTestId('cowork-auto-fix')).toHaveTextContent("Fixed automatically: step 'Get summaries' was reading the wrong field.");
        await userEvent.setup().click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/cowork/w1/plan/restore'))).toBe(true));
        expect(calls.find((c) => c.url.endsWith('/plan/restore'))?.body).toEqual({ version: 1 });
    });

    it('says nothing when nothing was fixed, or the fix was undone', async () => {
        calls = stubRecordingFetch(() => jsonResponse({ proposals: [{ ...FIXED, undoVersion: null }] }));
        renderWithClient(<CoworkAutoFixNote coworkId="w1" />);
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(screen.queryByTestId('cowork-auto-fix')).toBeNull();
    });
});
