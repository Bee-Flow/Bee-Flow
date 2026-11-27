// Cowork preferences, a page of Cowork: each switch saves through the API at once, the morning e-mail shows what it
// would say now, and "Suggest a task when I repeat a question" cannot be switched on while the organisation has turned
// it off. The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkSettingsPanel from './CoworkSettingsPanel';

afterEach(() => { vi.unstubAllGlobals(); });

const MORNING = 'E-mail me each morning what needs me';
const SUGGEST = 'Suggest a task when I repeat a question';

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
    it('is called Cowork preferences and says it holds for the reader only', async () => {
        serve();
        renderWithClient(<CoworkSettingsPanel />);
        expect(screen.getByRole('heading', { level: 1, name: 'Cowork preferences' })).toBeInTheDocument();
        expect(screen.getByText('Only for you.')).toBeInTheDocument();
        expect(await screen.findByRole('switch', { name: MORNING })).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: SUGGEST })).toBeInTheDocument();
    });

    it('saves the morning e-mail at once and then shows what tomorrow’s e-mail would say', async () => {
        const calls = serve();
        renderWithClient(<CoworkSettingsPanel />);
        const user = userEvent.setup();
        const morning = await screen.findByRole('switch', { name: MORNING });
        await waitFor(() => expect(morning).toBeEnabled());
        expect(screen.queryByTestId('cowork-digest-example')).toBeNull();
        await user.click(morning);
        await waitFor(() => expect(put(calls, '/api/cowork/daily-mail')?.body).toMatchObject({ enabled: true }));
        const example = await screen.findByTestId('cowork-digest-example');
        expect(example).toHaveTextContent('What tomorrow’s e-mail would say now');
        expect(example).toHaveTextContent('1 things need you');
        expect(example).toHaveTextContent('Supplier mails');
    });

    it('suggesting a task is off until switched on, and saves when it is', async () => {
        const calls = serve();
        renderWithClient(<CoworkSettingsPanel />);
        const suggest = await screen.findByRole('switch', { name: SUGGEST });
        await waitFor(() => expect(suggest).toBeEnabled());
        expect(suggest).not.toBeChecked();
        expect(screen.getByText('It never keeps your words or the answers.')).toBeInTheDocument();
        await userEvent.setup().click(suggest);
        await waitFor(() => expect(put(calls, '/api/cowork/habits')?.body).toEqual({ on: true }));
    });

    it('cannot be switched on while the organisation has turned it off, and says so', async () => {
        const calls = serve({ habits: { on: true, allowed: false } });
        renderWithClient(<CoworkSettingsPanel />);
        expect(await screen.findByText('Your organisation has turned this off.')).toBeInTheDocument();
        const suggest = screen.getByRole('switch', { name: SUGGEST });
        expect(suggest).toBeDisabled();
        expect(suggest).not.toBeChecked();
        await userEvent.setup().click(suggest);
        expect(put(calls, '/api/cowork/habits')).toBeUndefined();
    });

    it('where the server cannot send e-mail, the morning e-mail is off limits and says why', async () => {
        serve({ mail: { enabled: false, timeZone: 'UTC', available: false } });
        renderWithClient(<CoworkSettingsPanel />);
        expect(await screen.findByText('This Bee Flow cannot send e-mail yet. Ask your administrator.')).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: MORNING })).toBeDisabled();
    });
    it('keeps a failed read distinct from a disabled digest, and restores the saved value after a retry', async () => {
        let available = false;
        stubRecordingFetch(({url}) => {
            if (url.endsWith('/daily-mail')) return available ? jsonResponse({available: true, enabled: true}) : jsonResponse({}, 503);
            if (url.endsWith('/habits')) return jsonResponse({allowed: true, on: false});
            return jsonResponse({needs: []});
        });
        renderWithClient(<CoworkSettingsPanel />);
        const retry = await screen.findByRole('button', {name: 'Try again'});
        expect(screen.queryByRole('switch', {name: MORNING})).toBeNull();
        available = true;
        await userEvent.setup().click(retry);
        expect(await screen.findByRole('switch', {name: MORNING})).toBeChecked();
    });

});
