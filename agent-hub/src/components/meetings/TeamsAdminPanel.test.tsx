import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

const state: { query: unknown; save: { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }; orgIds: unknown[] } = {
    query: null, save: { mutateAsync: vi.fn(), isPending: false }, orgIds: [],
};
vi.mock('../../api/queries/teamsMeetingNotes', () => ({
    useTeamsNotesOrgSettings: (orgId: unknown) => { state.orgIds.push(orgId); return state.query; },
    useSaveTeamsNotesOrgSettings: () => state.save,
}));

import TeamsAdminPanel from './TeamsAdminPanel';

const SAVED = { autoImport: false, autoRecordConfig: true, language: 'en', lookbackHours: 24, updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: 'admin1' };
// What GET answers for an org that never saved: the server's built-in defaults, no stamp.
const NEVER_SAVED = { autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24 };

describe('TeamsAdminPanel', () => {
    beforeEach(() => {
        cleanup();
        state.orgIds = [];
        state.save = { mutateAsync: vi.fn().mockResolvedValue({ ok: true }), isPending: false };
        state.query = { isLoading: false, data: SAVED };
    });

    it('renders nothing without an organisation', () => {
        const { container } = render(<TeamsAdminPanel user={{ organizationId: null }} />);
        expect(container.innerHTML).toBe('');
    });

    it('names the admin consent the Teams permissions need', () => {
        render(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect(screen.getByText(/OnlineMeetingRecording\.Read\.All/)).toBeTruthy();
        expect(state.orgIds).toContain('orgA');
    });

    it('loads the org values and saves the change', async () => {
        const user = userEvent.setup();
        render(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect((screen.getByRole('combobox', { name: 'Default language' }) as HTMLSelectElement).value).toBe('en');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Auto-import recorded Teams meetings' }), 'on');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ autoImport: true, autoRecordConfig: true, language: 'en' }));
        expect(await screen.findByText('Saved')).toBeTruthy();
    });

    it('names each setting by its row title', () => {
        render(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect((screen.getByRole('combobox', { name: 'Auto-import recorded Teams meetings' }) as HTMLSelectElement).value).toBe('off');
        expect((screen.getByRole('combobox', { name: 'Switch on Teams recording for meetings members organise' }) as HTMLSelectElement).value).toBe('on');
        expect(screen.getByRole('combobox', { name: 'Default language' })).toBeTruthy();
    });

    it('keeps members\' auto-import when an org that never saved changes only the language', async () => {
        state.query = { isLoading: false, data: NEVER_SAVED };
        const user = userEvent.setup();
        render(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect((screen.getByRole('combobox', { name: 'Auto-import recorded Teams meetings' }) as HTMLSelectElement).value).toBe('');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Default language' }), 'en');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ language: 'en', autoImport: null, autoRecordConfig: null, lookbackHours: null }));
    });

    it('hands a fixed setting back to the members as null', async () => {
        const user = userEvent.setup();
        render(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Switch on Teams recording for meetings members organise' }), '');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ autoRecordConfig: null, autoImport: false, language: 'en' }));
    });

    it('offers no Save when the org settings could not be loaded', () => {
        state.query = { isLoading: false, isError: true, data: undefined };
        render(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });
});
