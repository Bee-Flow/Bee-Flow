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
const serve = (needs: CoworkNeed[], mail = { enabled: false, timeZone: 'UTC', available: true }) => {
    calls = stubRecordingFetch(({ url, method, body }) => {
        if (!url.endsWith('/daily-mail')) return jsonResponse({ needs, count: needs.length });
        return jsonResponse(method === 'PUT' ? { ...(body as object), available: true } : mail);
    });
};
const needsCalls = () => calls.filter((c) => c.url.endsWith('/needs-you'));

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkNeedsYou', () => {
    it('lists what waits, a decision with a link to Approvals and the rest opening their item', async () => {
        serve([need({ kind: 'decision', itemId: 'w2', title: 'Invoices' }), need({ reason: 'Which discount applies?' }), need({ kind: 'plan', itemId: 'w3', title: 'Weekly report', runId: null, plan: 'first' })]);
        const onOpen = vi.fn();
        renderWithClient(<CoworkNeedsYou onOpen={onOpen} />);
        expect(await screen.findAllByTestId('cowork-need')).toHaveLength(3);
        expect(needsCalls()).toHaveLength(1);
        expect(screen.getByRole('link', { name: 'Decide in Approvals' })).toHaveAttribute('href', '/app/studio/approvals');
        expect(screen.getByText('Which discount applies?')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'See the plan' }));
        expect(onOpen).toHaveBeenCalledWith('w3');
    });

    it('while nothing waits, only the switch of the daily e-mail shows; it saves the browser\'s time zone', async () => {
        serve([]);
        renderWithClient(<CoworkNeedsYou onOpen={() => {}} />);
        const toggle = await screen.findByRole('switch', { name: 'E-mail me this list every morning' });
        expect(screen.queryByTestId('cowork-needs-you')).toBeNull();
        await userEvent.setup().click(toggle);
        await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
        const put = calls.find((c) => c.method === 'PUT');
        expect(put?.body).toEqual({ enabled: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    });

    it('no switch when the instance cannot send mail', async () => {
        serve([], { enabled: false, timeZone: 'UTC', available: false });
        renderWithClient(<CoworkNeedsYou onOpen={() => {}} />);
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/daily-mail'))).toBe(true));
        expect(screen.queryByTestId('cowork-daily-mail')).toBeNull();
    });
});
