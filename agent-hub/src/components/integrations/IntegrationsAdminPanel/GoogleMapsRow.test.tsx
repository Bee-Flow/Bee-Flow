// The Google Maps key of Platform services > Connected apps: one key for the
// whole server, read from GET /ai/config (hasGoogleMapsKey) and written with
// POST /ai/config. The pins moved here from the Organisation integrations page,
// where the row lived before; the outcome of a save is now said through the
// panel's message (a toast), where the old row swallowed a failed save.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import GoogleMapsRow from './GoogleMapsRow';

let calls: RecordedCall[];

/** GET /ai/config says whether a key is stored (or the probe fails); POST answers `post` (a status, or a thrown error). */
function serve({ hasGoogleMapsKey = false, probe = 'ok' as 'ok' | 'fails', post = 200 as number | Error } = {}) {
    calls = stubRecordingFetch(({ method }) => {
        if (method !== 'POST') {
            if (probe === 'fails') throw new Error('offline');
            return jsonResponse({ hasGoogleMapsKey });
        }
        if (post instanceof Error) throw post;
        return post < 400 ? jsonResponse({ ok: true }) : jsonResponse({ error: 'bad key' }, post);
    });
}

const posts = () => calls.filter(c => c.method === 'POST');
const probed = () => calls.some(c => c.method === 'GET' && c.url.endsWith('/ai/config'));
const keyInput = () => screen.getByLabelText('Google Maps API key');
const saveButton = () => screen.getByRole('button', { name: 'Save' });

async function mount() {
    const setMessage = vi.fn();
    renderWithClient(<GoogleMapsRow setMessage={setMessage} />);
    await waitFor(() => expect(probed()).toBe(true));
    return setMessage;
}

beforeEach(() => { serve(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('GoogleMapsRow', () => {
    it('probes /ai/config on mount and shows no "Configured" chip while no key is stored', async () => {
        await mount();
        expect(screen.getByText('Google Maps')).toBeInTheDocument();
        expect(keyInput()).toHaveAttribute('placeholder', 'Google Maps API key');
        expect(screen.queryByText('Configured')).toBeNull();
    });

    it('marks a stored key "Configured" and masks the placeholder', async () => {
        serve({ hasGoogleMapsKey: true });
        await mount();
        expect(await screen.findByText('Configured')).toBeInTheDocument();
        expect(keyInput()).toHaveAttribute('placeholder', '••••••••••••••••');
    });

    it('reads a failed probe as "no key" (an unreachable config looks unconfigured)', async () => {
        serve({ probe: 'fails' });
        await mount();
        expect(screen.queryByText('Configured')).toBeNull();
        expect(keyInput()).toHaveAttribute('placeholder', 'Google Maps API key');
    });

    it('refuses to save an empty or whitespace-only key, on the button and on Enter', async () => {
        const user = userEvent.setup();
        await mount();
        expect(saveButton()).toBeDisabled();
        await user.type(keyInput(), '   ');
        expect(saveButton()).toBeDisabled();
        await user.keyboard('{Enter}');
        expect(posts()).toHaveLength(0);
    });

    it('POSTs the raw key to /ai/config, says so, empties the field and marks the key "Configured"', async () => {
        const user = userEvent.setup();
        const setMessage = await mount();
        await user.type(keyInput(), 'AIza-secret');
        await user.click(saveButton());

        await waitFor(() => expect(posts()).toHaveLength(1));
        expect(posts()[0]?.url).toMatch(/\/ai\/config$/);
        expect(posts()[0]?.body).toEqual({ googleMapsApiKey: 'AIza-secret' });

        expect(await screen.findByText('Configured')).toBeInTheDocument();
        expect(keyInput()).toHaveValue('');
        expect(setMessage).toHaveBeenCalledWith({ type: 'success', text: 'Google Maps key saved' });
    });

    it('saves on Enter as well as on the button', async () => {
        const user = userEvent.setup();
        await mount();
        await user.type(keyInput(), 'k{Enter}');
        await waitFor(() => expect(posts()).toHaveLength(1));
    });

    it.each([
        ['rejected', 400],
        ['thrown', new Error('offline')],
    ])('says a %s save, keeps the typed key and does not claim a stored one', async (_kind, post) => {
        serve({ post });
        const user = userEvent.setup();
        const setMessage = await mount();
        await user.type(keyInput(), 'wrong');
        await user.click(saveButton());

        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Could not save the Google Maps key' }));
        expect(saveButton()).toBeEnabled();
        expect(keyInput()).toHaveValue('wrong');
        expect(screen.queryByText('Configured')).toBeNull();
    });

    it('links out to the Google Cloud API library and names the three APIs to enable', async () => {
        await mount();
        const link = screen.getByRole('link', { name: 'Google Cloud Console' });
        expect(link).toHaveAttribute('href', 'https://console.cloud.google.com/apis/library');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(screen.getByText(/Directions API, Places API and Maps Embed API/)).toBeInTheDocument();
    });
});
