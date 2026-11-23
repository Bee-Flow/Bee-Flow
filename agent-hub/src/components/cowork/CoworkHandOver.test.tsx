// "Hand over to a colleague": the colleagues are read when the panel is shown (its Settings tab, see
// CoworkSettings.test.tsx), and the hand-over sends the one chosen.
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
    it('reads the colleagues once shown and hands the item to the one chosen', async () => {
        calls = stubRecordingFetch(({ method }) => jsonResponse(method === 'POST' ? { itemId: 'w9' } : { colleagues: [{ id: 'bob', name: 'Bob' }] }));
        renderWithClient(<CoworkHandOver coworkId="w1" />);
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Colleague'), 'bob');
        await user.click(screen.getByRole('button', { name: 'Hand over' }));
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
        expect(screen.getByRole('alertdialog')).toHaveTextContent('Hand it over to Bob? This item and its runs are deleted');
        await user.click(screen.getByRole('button', { name: 'Yes, hand it over' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.url).toMatch(/\/api\/cowork\/w1\/hand-over$/);
        expect(post?.body).toEqual({ toUserId: 'bob' });
    });
});
