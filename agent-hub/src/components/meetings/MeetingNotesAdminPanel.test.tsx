// Organisation → Nextcloud Sync → Talk Meeting Notes: every switch and picker is
// named by its row title, Save writes the org values, and a field the org has
// no opinion on goes back as null so each member's own setting keeps applying.

import { screen, waitFor } from '@testing-library/react';
import { renderWithClient as render } from '../../test/render';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import MeetingNotesAdminPanel from './MeetingNotesAdminPanel';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const SAVED = { autoRecord: true, autoTranscribe: false, language: 'en', updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: 'admin1' };
// What GET answers for an org that never saved: the server's built-in defaults, no stamp.
const NEVER_SAVED = { autoTranscribe: false, postSummaryBack: false, recordingFolder: '/Talk/Recording', language: 'nl', autoRecord: false, autoRecordScope: 'calendar', recordingMode: 'audio', excludedEventUids: [], excludedRoomTokens: [], defaultOwnerUserId: null, insightsPerPersonStats: true };

const putBody = () => {
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    return JSON.parse(put?.[1].body);
};

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => respond(SAVED));
});

it('names every control by its row title', async () => {
    render(<MeetingNotesAdminPanel user={{ organizationId: 'orgA' }} />);
    expect(await screen.findByRole('combobox', { name: 'Auto-record Talk meetings' })).toHaveValue('on');
    expect(screen.getByRole('combobox', { name: 'Auto-transcribe Talk recordings' })).toHaveValue('off');
    expect(screen.getByRole('combobox', { name: 'Post summary back into Talk' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Per-person meeting insights' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Which calls' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Recording quality' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Default language' })).toHaveValue('en');
    expect(screen.getByRole('textbox', { name: 'Recordings folder' })).toBeInTheDocument();
});

it('saves the changed org values', async () => {
    const user = userEvent.setup();
    render(<MeetingNotesAdminPanel user={{ organizationId: 'orgA' }} />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Auto-transcribe Talk recordings' }), 'on');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/talk-notes-settings/orgA', expect.objectContaining({ method: 'PUT' })));
    expect(putBody()).toEqual(expect.objectContaining({ autoTranscribe: true, autoRecord: true }));
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
});

it('leaves every untouched field to the members when an org that never saved changes one', async () => {
    fetchMock.mockImplementation(async () => respond(NEVER_SAVED));
    const user = userEvent.setup();
    render(<MeetingNotesAdminPanel user={{ organizationId: 'orgA' }} />);
    expect(await screen.findByRole('combobox', { name: 'Auto-transcribe Talk recordings' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Auto-transcribe Talk recordings' })).toHaveDisplayValue('Each member decides');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default language' }), 'en');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    expect(putBody()).toEqual(expect.objectContaining({
        language: 'en', autoTranscribe: null, postSummaryBack: null, recordingFolder: null,
        autoRecord: null, autoRecordScope: null, recordingMode: null, insightsPerPersonStats: true,
    }));
});

it('hands a fixed setting back to the members as null', async () => {
    const user = userEvent.setup();
    render(<MeetingNotesAdminPanel user={{ organizationId: 'orgA' }} />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Auto-record Talk meetings' }), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    expect(putBody()).toEqual(expect.objectContaining({ autoRecord: null, autoTranscribe: false, language: 'en' }));
});

it('offers no Save when the org settings could not be loaded', async () => {
    fetchMock.mockImplementation(async () => respond({ error: 'boom' }, 500));
    render(<MeetingNotesAdminPanel user={{ organizationId: 'orgA' }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
});
