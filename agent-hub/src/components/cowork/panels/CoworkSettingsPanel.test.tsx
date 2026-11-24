// Settings in the Cowork sheet: each switch saves through the API at once, the daily digest shows an example of what
// it holds, and "Notice what I ask again and again" cannot be switched on while the organisation has turned it off.
// The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import { CoworkSettingsPanel } from './CoworkSettingsPanel';

afterEach(() => { vi.unstubAllGlobals(); });

function serve({ habits = { on: false, allowed: true }, mail = { enabled: false, timeZone: 'UTC', available: true } } = {}) {
    return stubRecordingFetch(({ method, url }) => {
        if (url.endsWith('/api/cowork/habits')) return jsonResponse(method === 'PUT' ? { ...habits, on: true } : habits);
        if (url.endsWith('/api/cowork/daily-mail')) return jsonResponse(method === 'PUT' ? { ...mail, enabled: true } : mail);
        if (url.includes('/api/cowork/needs-you')) return jsonResponse({ needs: [{ kind: 'review', itemId: 'a', title: 'Supplier mails', runId: 'r1', since: null, reason: null, plan: null }] });
        return jsonResponse({});
    });
}
const put = (calls: RecordedCall[], path: string) => calls.find((c) => c.method === 'PUT' && c.url.endsWith(path));

describe('CoworkSettingsPanel', () => {
    it('saves the daily digest at once and then shows what tomorrow’s e-mail would hold', async () => {
        const calls = serve();
        renderWithClient(<CoworkSettingsPanel onClose={() => {}} />);
        const user = userEvent.setup();
        const digest = await screen.findByRole('switch', { name: 'Send me a daily digest e-mail' });
        await waitFor(() => expect(digest).toBeEnabled());
        expect(screen.queryByTestId('cowork-digest-example')).toBeNull();
        await user.click(digest);
        await waitFor(() => expect(put(calls, '/api/cowork/daily-mail')?.body).toMatchObject({ enabled: true }));
        expect(await screen.findByTestId('cowork-digest-example')).toHaveTextContent('1 things need you');
        expect(screen.getByTestId('cowork-digest-example')).toHaveTextContent('Supplier mails');
    });

    it('"Notice what I ask again and again" is off until switched on, and saves when it is', async () => {
        const calls = serve();
        renderWithClient(<CoworkSettingsPanel onClose={() => {}} />);
        const notice = await screen.findByRole('switch', { name: 'Notice what I ask again and again' });
        await waitFor(() => expect(notice).toBeEnabled());
        expect(notice).not.toBeChecked();
        expect(screen.getByText('It never keeps your words or the answers.')).toBeInTheDocument();
        await userEvent.setup().click(notice);
        await waitFor(() => expect(put(calls, '/api/cowork/habits')?.body).toEqual({ on: true }));
    });

    it('cannot be switched on while the organisation has turned it off, and says so', async () => {
        const calls = serve({ habits: { on: true, allowed: false } });
        renderWithClient(<CoworkSettingsPanel onClose={() => {}} />);
        expect(await screen.findByText('Your organisation has turned this off.')).toBeInTheDocument();
        const notice = screen.getByRole('switch', { name: 'Notice what I ask again and again' });
        expect(notice).toBeDisabled();
        expect(notice).not.toBeChecked();
        await userEvent.setup().click(notice);
        expect(put(calls, '/api/cowork/habits')).toBeUndefined();
    });

    it('where the server cannot send e-mail, the digest switch is off limits and says why', async () => {
        serve({ mail: { enabled: false, timeZone: 'UTC', available: false } });
        renderWithClient(<CoworkSettingsPanel onClose={() => {}} />);
        expect(await screen.findByText('This Bee Flow cannot send e-mail yet. Ask your administrator.')).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: 'Send me a daily digest e-mail' })).toBeDisabled();
    });

    it('closes on Escape', async () => {
        serve();
        const onClose = vi.fn();
        renderWithClient(<CoworkSettingsPanel onClose={onClose} />);
        const digest = await screen.findByRole('switch', { name: 'Send me a daily digest e-mail' });
        await waitFor(() => expect(digest).toBeEnabled());
        digest.focus();
        await userEvent.setup().keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledOnce();
    });
});
