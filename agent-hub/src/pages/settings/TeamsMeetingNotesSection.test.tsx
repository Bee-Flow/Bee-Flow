import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { renderWithClient } from '@/test/render';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../api/microsoftOAuthPopup', () => ({ openMicrosoftOAuthPopup: vi.fn() }));

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
import { openMicrosoftOAuthPopup } from '../../api/microsoftOAuthPopup';
import { authFetch } from '../../utils/helpers';

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
        const { container, rerender } = renderWithClient(<TeamsMeetingNotesSection />);
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
        renderWithClient(<TeamsMeetingNotesSection />);
        const [autoImport] = screen.getAllByRole('button', { pressed: false });
        await user.click(autoImport);
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ autoImport: true, autoRecordConfig: false, language: 'nl' }));
        expect(await screen.findByText('Saved')).toBeTruthy();
    });

    it('locks the auto-record toggle without the meeting write permission', () => {
        state.query = settings({ ...FULL, hasMeetingWriteScope: false });
        renderWithClient(<TeamsMeetingNotesSection />);
        const toggles = screen.getAllByRole('button', { pressed: false });
        expect((toggles[1] as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/reconnect Microsoft 365 to grant it/)).toBeTruthy();
    });

    it('connected without the Teams permissions → reconnect prompt', async () => {
        const user = userEvent.setup();
        vi.mocked(openMicrosoftOAuthPopup).mockResolvedValue({ success: true });
        state.query = settings({ ...FULL, teamsScopesGranted: false });
        renderWithClient(<TeamsMeetingNotesSection />);
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Reconnect Microsoft 365' }));
        expect(invalidate).toHaveBeenCalled();
    });

    it('a stored connection that needs reauth → expired notice and reconnect, not a vanished section', async () => {
        const user = userEvent.setup();
        vi.mocked(openMicrosoftOAuthPopup).mockResolvedValue({ success: true });
        state.query = settings({ microsoftConnected: false, teamsScopesGranted: true, hasMeetingWriteScope: false, hasTranscriptScope: false, needsReauth: true });
        renderWithClient(<TeamsMeetingNotesSection />);
        expect(screen.getByText('Microsoft Teams Meeting Notes')).toBeTruthy();
        expect(screen.getByText(/connection has expired/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Reconnect Microsoft 365' }));
        expect(openMicrosoftOAuthPopup).toHaveBeenCalled();
        expect(invalidate).toHaveBeenCalled();
    });

    it('offers "Test my connection" and shows the checklist the server answers', async () => {
        const user = userEvent.setup();
        vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({
            level: 'user', ranAt: '2026-11-10T10:00:00.000Z', overall: 'warn',
            checks: [{ id: 'a.scope_transcripts', option: 'A', status: 'warn', code: 'scope_missing', params: { permission: 'OnlineMeetingTranscript.Read.All' }, remediation: 'teams_setup.fix.admin_consent_needed', fixer: 'entra_admin', dependsOn: ['a.connection'] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
        state.query = settings(FULL);
        renderWithClient(<TeamsMeetingNotesSection />);
        await user.click(screen.getByRole('button', { name: 'Test my connection' }));
        expect(await screen.findByText('Microsoft did not grant OnlineMeetingTranscript.Read.All.')).toBeTruthy();
        expect(vi.mocked(authFetch).mock.calls[0][0]).toMatch(/\/api\/teams-setup\/me\/diagnostics$/);
        // The settings rows are still there.
        expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    });

    it('covered by organisation-wide import but not connected → visible, with the notice and the settings, no own test', async () => {
        const user = userEvent.setup();
        state.query = settings(
            { microsoftConnected: false, teamsScopesGranted: false, hasMeetingWriteScope: false, hasTranscriptScope: false, needsReauth: false },
            { orgImport: { active: true } },
        );
        renderWithClient(<TeamsMeetingNotesSection />);
        expect(screen.getByText('Microsoft Teams Meeting Notes')).toBeTruthy();
        expect(screen.getByRole('status').textContent)
            .toBe('Your organisation imports the Teams meetings you organise. You do not need to connect Microsoft 365 for that.');
        // No reconnect prompt: the organisation's import does not need the person's connection.
        expect(screen.queryByRole('button', { name: 'Reconnect Microsoft 365' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Test my connection' })).toBeNull();
        // The auto-record toggle stays locked: it needs the person's own meeting write permission.
        const toggles = screen.getAllByRole('button', { pressed: false });
        expect((toggles[1] as HTMLButtonElement).disabled).toBe(true);
        await user.click(toggles[0]);
        await user.click(screen.getByRole('button', { name: 'Save' }));
        const sent = state.save.mutateAsync.mock.calls[0][0] as Record<string, unknown>;
        expect(sent).toEqual(expect.objectContaining({ autoImport: true }));
        // Read-only facts never go back in the strict PUT body.
        expect(sent).not.toHaveProperty('orgImport');
        expect(sent).not.toHaveProperty('connection');
    });

    it('connected and covered → the notice next to the usual rows and test', () => {
        state.query = settings(FULL, { orgImport: { active: true } });
        renderWithClient(<TeamsMeetingNotesSection />);
        expect(screen.getByText(/Your organisation imports the Teams meetings you organise/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Test my connection' })).toBeTruthy();
    });

    it('no notice when organisation-wide import does not cover the person', () => {
        state.query = settings(FULL, { orgImport: { active: false } });
        renderWithClient(<TeamsMeetingNotesSection />);
        expect(screen.queryByText(/Your organisation imports the Teams meetings you organise/)).toBeNull();
        state.query = settings({ ...FULL, microsoftConnected: false }, { orgImport: { active: false } });
        const { container } = renderWithClient(<TeamsMeetingNotesSection />);
        expect(container.innerHTML).toBe('');
    });

    it('offers the test also when the Teams permissions are missing', () => {
        state.query = settings({ ...FULL, teamsScopesGranted: false });
        renderWithClient(<TeamsMeetingNotesSection />);
        expect(screen.getByRole('button', { name: 'Test my connection' })).toBeTruthy();
    });
});
