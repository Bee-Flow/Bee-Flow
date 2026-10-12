import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('./CaptureControls', () => ({ default: () => null }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../lib/microsoftOAuthPopup', () => ({ openMicrosoftOAuthPopup: vi.fn() }));

const queryState: { current: unknown } = { current: null };
const invalidate = vi.fn();
vi.mock('../../../api/queries/teamsMeetingNotes', () => ({
    useTeamsRecordings: () => queryState.current,
    useInvalidateTeamsMeetingNotes: () => invalidate,
}));

const recorderMock: { current: Record<string, unknown> | null } = { current: null };
vi.mock('../hooks/RecorderContext', () => ({ useRecorder: () => recorderMock.current }));

import TeamsImportPanel from './TeamsImportPanel';
import { openMicrosoftOAuthPopup } from '../../../lib/microsoftOAuthPopup';

const CONNECTED = { microsoftConnected: true, teamsScopesGranted: true, hasMeetingWriteScope: true, hasTranscriptScope: true, needsReauth: false };
const ITEMS = [
    { eventId: 'e1', title: 'Weekly sync', start: '2026-09-30T10:00:00Z', end: '2026-09-30T10:45:00Z', recordingState: 'available', importedNoteId: null },
    { eventId: 'e2', title: 'Board', start: '2026-09-30T12:00:00Z', end: '2026-09-30T13:00:00Z', recordingState: 'transcript_only', importedNoteId: null },
    { eventId: 'e3', title: 'Standup', start: '2026-09-30T09:00:00Z', end: '2026-09-30T09:15:00Z', recordingState: 'none', importedNoteId: null },
    { eventId: 'e4', title: 'Retro', start: '2026-09-29T15:00:00Z', end: '2026-09-29T16:00:00Z', recordingState: 'available', importedNoteId: 'n4' },
];

function query(over: Record<string, unknown> = {}) {
    return { data: { connection: CONNECTED, items: ITEMS }, isLoading: false, isFetching: false, error: null, refetch: vi.fn(), ...over };
}
function recorder(over: Record<string, unknown> = {}) {
    return {
        importFromTeams: vi.fn().mockResolvedValue({ ok: true }),
        settings: { language: 'nl', provider: '', contextTerms: 'AFAS' },
        uploading: false, uploadStage: '', uploadError: null, clearError: vi.fn(),
        ...over,
    };
}

describe('TeamsImportPanel', () => {
    beforeEach(() => {
        cleanup();
        vi.clearAllMocks();
        queryState.current = query();
        recorderMock.current = recorder();
    });

    it('shows one action per meeting state', () => {
        render(<TeamsImportPanel />);
        expect(screen.getAllByRole('button', { name: 'Transcribe' })).toHaveLength(2);
        expect(screen.getByText(/transcript only, no audio/)).toBeTruthy();
        expect(screen.getByText('No recording')).toBeTruthy();
        expect(screen.getByText('Note created')).toBeTruthy();
    });

    it('imports with the capture settings and closes on success', async () => {
        const user = userEvent.setup();
        const onComplete = vi.fn();
        render(<TeamsImportPanel onComplete={onComplete} />);
        await user.click(screen.getAllByRole('button', { name: 'Transcribe' })[0]);
        const importFromTeams = recorderMock.current!.importFromTeams as ReturnType<typeof vi.fn>;
        expect(importFromTeams).toHaveBeenCalledWith(ITEMS[0], { language: 'nl', contextTerms: 'AFAS' });
        expect(onComplete).toHaveBeenCalled();
    });

    it('a 202 from the server shows "Waiting for Teams" instead of closing', async () => {
        const user = userEvent.setup();
        recorderMock.current = recorder({ importFromTeams: vi.fn().mockResolvedValue({ ok: false, pending: true }) });
        const onComplete = vi.fn();
        render(<TeamsImportPanel onComplete={onComplete} />);
        await user.click(screen.getAllByRole('button', { name: 'Transcribe' })[0]);
        expect(await screen.findByText('Waiting for Teams')).toBeTruthy();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('connected without the Teams permissions → reconnect prompt, list hidden', async () => {
        const user = userEvent.setup();
        queryState.current = query({ data: { connection: { ...CONNECTED, teamsScopesGranted: false }, items: [] } });
        vi.mocked(openMicrosoftOAuthPopup).mockResolvedValue({ success: true });
        render(<TeamsImportPanel />);
        expect(screen.getByText('Microsoft Teams needs additional access')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Transcribe' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Reconnect Microsoft 365' }));
        expect(openMicrosoftOAuthPopup).toHaveBeenCalled();
        expect(invalidate).toHaveBeenCalled();
    });

    it('empty and error states', () => {
        queryState.current = query({ data: { connection: CONNECTED, items: [] } });
        render(<TeamsImportPanel />);
        expect(screen.getByText('No Teams meetings found')).toBeTruthy();
        cleanup();
        queryState.current = query({ data: undefined, error: new Error('Graph down') });
        render(<TeamsImportPanel />);
        expect(screen.getByText('Graph down')).toBeTruthy();
    });
});
