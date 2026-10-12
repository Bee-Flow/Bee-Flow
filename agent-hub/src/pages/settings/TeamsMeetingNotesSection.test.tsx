import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../lib/microsoftOAuthPopup', () => ({ openMicrosoftOAuthPopup: vi.fn() }));

const state: { query: unknown; save: { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean } } = {
    query: null,
    save: { mutateAsync: vi.fn(), isPending: false },
};
const invalidate = vi.fn();
vi.mock('../../api/queries/teamsMeetingNotes', () => ({
    useTeamsNotesUserSettings: () => state.query,
    useSaveTeamsNotesUserSettings: () => state.save,
    useInvalidateTeamsMeetingNotes: () => invalidate,
}));

import TeamsMeetingNotesSection from './TeamsMeetingNotesSection';
import { openMicrosoftOAuthPopup } from '../../lib/microsoftOAuthPopup';

const FULL = { microsoftConnected: true, teamsScopesGranted: true, hasMeetingWriteScope: true, hasTranscriptScope: true, needsReauth: false };
const settings = (connection: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    isLoading: false, error: null,
    data: { autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24, connection, ...over },
});

describe('TeamsMeetingNotesSection', () => {
    beforeEach(() => {
        cleanup();
        vi.clearAllMocks();
        state.save = { mutateAsync: vi.fn().mockResolvedValue({ ok: true }), isPending: false };
    });

    it('hides itself while loading, when unlicensed and when Microsoft is not connected', () => {
        state.query = { isLoading: true, error: null, data: undefined };
        const { container, rerender } = render(<TeamsMeetingNotesSection />);
        expect(container.innerHTML).toBe('');
        state.query = { isLoading: false, error: new Error('403'), data: undefined };
        rerender(<TeamsMeetingNotesSection />);
        expect(container.innerHTML).toBe('');
        state.query = settings({ ...FULL, microsoftConnected: false });
        rerender(<TeamsMeetingNotesSection />);
        expect(container.innerHTML).toBe('');
    });

    it('saves the toggled settings', async () => {
        const user = userEvent.setup();
        state.query = settings(FULL);
        render(<TeamsMeetingNotesSection />);
        const [autoImport] = screen.getAllByRole('button', { pressed: false });
        await user.click(autoImport);
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ autoImport: true, autoRecordConfig: false, language: 'nl' }));
        expect(await screen.findByText('Saved')).toBeTruthy();
    });

    it('locks the auto-record toggle without the meeting write permission', () => {
        state.query = settings({ ...FULL, hasMeetingWriteScope: false });
        render(<TeamsMeetingNotesSection />);
        const toggles = screen.getAllByRole('button', { pressed: false });
        expect((toggles[1] as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/reconnect Microsoft 365 to grant it/)).toBeTruthy();
    });

    it('connected without the Teams permissions → reconnect prompt', async () => {
        const user = userEvent.setup();
        vi.mocked(openMicrosoftOAuthPopup).mockResolvedValue({ success: true });
        state.query = settings({ ...FULL, teamsScopesGranted: false });
        render(<TeamsMeetingNotesSection />);
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Reconnect Microsoft 365' }));
        expect(invalidate).toHaveBeenCalled();
    });
});
