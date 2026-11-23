// "Share with your team": read when the panel is shown (its Settings tab, see CoworkSettings.test.tsx); the saved
// shares show as chosen, a change is saved as the full list, and two deciders cannot be saved. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkShare from './CoworkShare';

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

function serve() {
    calls = stubRecordingFetch(({ method, url, body }) => {
        if (method === 'PUT') return jsonResponse({ shares: (body as { shares: unknown[] }).shares });
        if (url.endsWith('/colleagues')) return jsonResponse({ colleagues: [{ id: 'bob', name: 'Bob' }, { id: 'eve', name: 'Eve' }] });
        return jsonResponse({ shares: [{ userId: 'bob', role: 'viewer' }] });
    });
}

describe('CoworkShare', () => {
    it('shows who it is shared with, and saves the whole list', async () => {
        serve();
        renderWithClient(<CoworkShare coworkId="w1" />);
        const user = userEvent.setup();
        const bob = await screen.findByLabelText('What Bob may do');
        await waitFor(() => expect(bob).toHaveValue('viewer'));
        await user.selectOptions(screen.getByLabelText('What Eve may do'), 'approver');
        await user.click(screen.getByRole('button', { name: 'Save who it is shared with' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
        const put = calls.find((c) => c.method === 'PUT');
        expect(put?.url).toMatch(/\/api\/cowork\/w1\/shares$/);
        expect(put?.body).toEqual({ shares: [{ userId: 'bob', role: 'viewer' }, { userId: 'eve', role: 'approver' }] });
    });

    it('does not save two colleagues who both decide the questions', async () => {
        serve();
        renderWithClient(<CoworkShare coworkId="w1" />);
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('What Bob may do'), 'approver');
        await user.selectOptions(screen.getByLabelText('What Eve may do'), 'approver');
        expect(screen.getByRole('alert')).toHaveTextContent('One colleague decides the questions');
        expect(screen.getByRole('button', { name: 'Save who it is shared with' })).toBeDisabled();
    });
});
