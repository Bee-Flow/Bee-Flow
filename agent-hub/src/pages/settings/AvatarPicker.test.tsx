import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings → Preferences → the avatar picker in the profile strip.
 *
 * Pinned: a new avatar is applied (onSaved, picker closed) only once the
 * server stored it. A refused or failed save keeps the picker open, says so,
 * and leaves the picker usable for another try.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
// AvatarDisplay lives in the settings shell; importing the real one pulls in
// the whole shell.
vi.mock('../AdvancedSettings', () => ({ AvatarDisplay: () => <span data-testid="avatar-display" /> }));

import AvatarPicker from './AvatarPicker';
import { Toaster } from '../../components/shared/Toast';
import { authFetch } from '../../utils/helpers';

const fetchMock = vi.mocked(authFetch);
const res = (status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) }) as unknown as Response;

function setup(user: Record<string, unknown> = { username: 'tom' }) {
    const onSaved = vi.fn();
    render(
        <>
            <AvatarPicker user={user} onSaved={onSaved} />
            <Toaster />
        </>,
    );
    return { onSaved, ui: userEvent.setup() };
}

const trigger = () => screen.getByRole('button', { name: 'Avatar' });

async function pickCustomEmoji(ui: ReturnType<typeof userEvent.setup>, emoji: string) {
    await ui.click(trigger());
    await ui.type(screen.getByPlaceholderText('Paste any emoji…'), emoji);
    await ui.click(screen.getByRole('button', { name: 'Use' }));
}

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { cleanup(); });

describe('AvatarPicker', () => {
    it('names its trigger and reports whether the picker is open', async () => {
        const { ui } = setup();
        expect(trigger()).toHaveAttribute('aria-expanded', 'false');
        await ui.click(trigger());
        expect(trigger()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByPlaceholderText('Paste any emoji…')).toBeInTheDocument();
    });

    it('applies an emoji and closes once the server stored it', async () => {
        fetchMock.mockResolvedValue(res(200));
        const { onSaved, ui } = setup();
        await pickCustomEmoji(ui, '🐝');

        await waitFor(() => expect(onSaved).toHaveBeenCalledWith('🐝', 'emoji'));
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/auth/update-profile');
        expect(JSON.parse(String(init.body))).toEqual({ avatar: '🐝', avatarType: 'emoji' });
        expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });

    it('keeps the old avatar and the picker open when the server refuses, and says so', async () => {
        fetchMock.mockResolvedValue(res(500));
        const { onSaved, ui } = setup();
        await pickCustomEmoji(ui, '🐝');

        expect(await screen.findByText('Save failed')).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();
        expect(trigger()).toHaveAttribute('aria-expanded', 'true');
        // Not stuck in "saving": the picker can be used again.
        expect(screen.getByRole('button', { name: 'Use' })).toBeEnabled();
    });

    it('treats a network error the same way', async () => {
        fetchMock.mockRejectedValue(new Error('offline'));
        const { onSaved, ui } = setup();
        await pickCustomEmoji(ui, '🐝');

        expect(await screen.findByText('Save failed')).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();
    });

    it('removes the avatar only when the server accepts it', async () => {
        fetchMock.mockResolvedValue(res(403));
        const { onSaved, ui } = setup({ username: 'tom', avatar: '🦊', avatarType: 'emoji' });
        await ui.click(trigger());
        await ui.click(screen.getByRole('button', { name: 'Remove' }));
        expect(await screen.findByText('Save failed')).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();

        fetchMock.mockResolvedValue(res(200));
        await ui.click(screen.getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null, null));
    });

    it('applies an uploaded image only when the server accepts it', async () => {
        fetchMock.mockResolvedValue(res(413));
        const { onSaved, ui } = setup();
        await ui.click(trigger());
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        const file = new File(['x'], 'me.png', { type: 'image/png' });

        await ui.upload(input, file);
        expect(await screen.findByText('Save failed')).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();

        fetchMock.mockResolvedValue(res(200));
        await ui.upload(input, file);
        await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), 'url'));
    });
});
