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

describe('TeamsAdminPanel', () => {
    beforeEach(() => {
        cleanup();
        state.orgIds = [];
        state.save = { mutateAsync: vi.fn().mockResolvedValue({ ok: true }), isPending: false };
        state.query = { isLoading: false, data: { autoImport: false, autoRecordConfig: true, language: 'en', lookbackHours: 24 } };
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
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('en');
        await user.click(screen.getByRole('button', { pressed: false }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ autoImport: true, autoRecordConfig: true, language: 'en' }));
        expect(await screen.findByText('Saved')).toBeTruthy();
    });
});
