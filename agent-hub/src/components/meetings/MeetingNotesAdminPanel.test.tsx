// Organisation → Nextcloud Sync → Talk Meeting Notes: every switch and picker is
// named by its row title, and Save writes the org values.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import MeetingNotesAdminPanel from './MeetingNotesAdminPanel';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => respond({ autoRecord: true, autoTranscribe: false, language: 'en' }));
});

it('names every control by its row title', async () => {
    render(<MeetingNotesAdminPanel user={{ organizationId: 'orgA' }} />);
    expect(await screen.findByRole('button', { name: 'Auto-record Talk meetings', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto-transcribe Talk recordings', pressed: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post summary back into Talk' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Per-person meeting insights' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Which calls' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Recording quality' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Default language' })).toHaveValue('en');
    expect(screen.getByRole('textbox', { name: 'Recordings folder' })).toBeInTheDocument();
});

it('saves the changed org values', async () => {
    const user = userEvent.setup();
    render(<MeetingNotesAdminPanel user={{ organizationId: 'orgA' }} />);
    await user.click(await screen.findByRole('button', { name: 'Auto-transcribe Talk recordings' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/talk-notes-settings/orgA', expect.objectContaining({ method: 'PUT' })));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1].body)).toEqual(expect.objectContaining({ autoTranscribe: true, autoRecord: true }));
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
});
