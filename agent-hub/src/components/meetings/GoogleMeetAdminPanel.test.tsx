// Organisation → Meeting templates → Google Meet Meeting Notes: every switch and
// picker is named by its row title, and Save writes the org values.

import { screen, waitFor } from '@testing-library/react';
import { renderWithClient as render } from '../../test/render';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import GoogleMeetAdminPanel from './GoogleMeetAdminPanel';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => respond({ autoImport: false, autoRecordConfig: true, importScope: 'calendar', language: 'de' }));
});

it('renders nothing without an organisation', () => {
    const { container } = render(<GoogleMeetAdminPanel user={{ organizationId: null }} />);
    expect(container).toBeEmptyDOMElement();
});

it('names every control by its row title', async () => {
    render(<GoogleMeetAdminPanel user={{ organizationId: 'orgA' }} />);
    expect(await screen.findByRole('button', { name: 'Auto-import recorded Meet meetings', pressed: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pre-enable auto-recording for meetings members organize', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Which meetings' })).toHaveValue('calendar');
    expect(screen.getByRole('combobox', { name: 'Default language' })).toHaveValue('de');
});

it('saves the changed org values', async () => {
    const user = userEvent.setup();
    render(<GoogleMeetAdminPanel user={{ organizationId: 'orgA' }} />);
    await user.click(await screen.findByRole('button', { name: 'Auto-import recorded Meet meetings' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/gmeet-notes-settings/orgA', expect.objectContaining({ method: 'PUT' })));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1].body)).toEqual(expect.objectContaining({ autoImport: true, importScope: 'calendar' }));
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
});
