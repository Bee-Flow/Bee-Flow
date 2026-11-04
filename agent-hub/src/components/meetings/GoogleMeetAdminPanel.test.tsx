// Organisation → Meeting templates → Google Meet Meeting Notes: every switch and
// picker is named by its row title, Save writes the org values, and a field the
// org has no opinion on goes back as null so each member's own setting applies.

import { screen, waitFor } from '@testing-library/react';
import { renderWithClient as render } from '../../test/render';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import GoogleMeetAdminPanel from './GoogleMeetAdminPanel';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const SAVED = { autoImport: false, autoRecordConfig: true, importScope: 'calendar', language: 'de', lookbackHours: 48, updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: 'admin1' };
// What GET answers for an org that never saved: the server's built-in defaults, no stamp.
const NEVER_SAVED = { autoImport: false, autoRecordConfig: false, importScope: 'organizer', language: 'nl', lookbackHours: 24, excludedEventIds: [], excludedMeetingCodes: [] };

const putBody = () => {
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    return JSON.parse(put?.[1].body);
};

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => respond(SAVED));
});

it('renders nothing without an organisation', () => {
    const { container } = render(<GoogleMeetAdminPanel user={{ organizationId: null }} />);
    expect(container).toBeEmptyDOMElement();
});

it('names every control by its row title', async () => {
    render(<GoogleMeetAdminPanel user={{ organizationId: 'orgA' }} />);
    expect(await screen.findByRole('combobox', { name: 'Auto-import recorded Meet meetings' })).toHaveValue('off');
    expect(screen.getByRole('combobox', { name: 'Pre-enable auto-recording for meetings members organize' })).toHaveValue('on');
    expect(screen.getByRole('combobox', { name: 'Which meetings' })).toHaveValue('calendar');
    expect(screen.getByRole('combobox', { name: 'Default language' })).toHaveValue('de');
});

it('saves the changed org values', async () => {
    const user = userEvent.setup();
    render(<GoogleMeetAdminPanel user={{ organizationId: 'orgA' }} />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Auto-import recorded Meet meetings' }), 'on');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/gmeet-notes-settings/orgA', expect.objectContaining({ method: 'PUT' })));
    expect(putBody()).toEqual(expect.objectContaining({ autoImport: true, importScope: 'calendar', lookbackHours: 48 }));
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
});

it('leaves every untouched field to the members when an org that never saved changes one', async () => {
    fetchMock.mockImplementation(async () => respond(NEVER_SAVED));
    const user = userEvent.setup();
    render(<GoogleMeetAdminPanel user={{ organizationId: 'orgA' }} />);
    expect(await screen.findByRole('combobox', { name: 'Auto-import recorded Meet meetings' })).toHaveDisplayValue('Each member decides');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default language' }), 'en');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    expect(putBody()).toEqual(expect.objectContaining({ language: 'en', autoImport: null, autoRecordConfig: null, importScope: null, lookbackHours: null }));
});
