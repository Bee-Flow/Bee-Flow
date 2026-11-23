// "Hand over to a colleague": the colleagues are read when the section opens, and the hand-over sends the one chosen.
// The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkHandOver from './CoworkHandOver';

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkHandOver', () => {
    it('reads the colleagues when opened and hands the item to the one chosen', async () => {
        calls = stubRecordingFetch(({ method }) => jsonResponse(method === 'POST' ? { itemId: 'w9' } : { colleagues: [{ id: 'bob', name: 'Bob' }] }));
        renderWithClient(<CoworkHandOver coworkId="w1" />);
        expect(calls).toHaveLength(0);
        const user = userEvent.setup();
        await user.click(screen.getByText('Hand over to a colleague'));
        await user.selectOptions(await screen.findByLabelText('Colleague'), 'bob');
        await user.click(screen.getByRole('button', { name: 'Hand over' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.url).toMatch(/\/api\/cowork\/w1\/hand-over$/);
        expect(post?.body).toEqual({ toUserId: 'bob' });
    });
});
