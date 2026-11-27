import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithClient } from '@/test/render';
import TeamsTranscriptSetupCard, { TEAMS_TRANSCRIPT_COMMANDS } from './TeamsTranscriptSetupCard';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const overview = (source: 'recording' | 'transcript' | null) => ({
    windowDays: 7, generatedAt: '2026-11-20T10:00:00.000Z', truncated: false,
    settings: { autoImport: null, autoRecordConfig: null, source }, checks: [],
    totals: { members: 0, connected: 0, missingPermissions: 0, needsReauth: 0, skipped: 0, failedImports: 0 },
    members: [],
});

const card = () => screen.getByTestId('teams-transcript-setup') as HTMLDetailsElement;

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('TeamsTranscriptSetupCard', () => {
    it('lists what must be in place and gives the Teams administrator both commands', async () => {
        fetchMock.mockResolvedValue(answer(overview('transcript')));
        renderWithClient(<TeamsTranscriptSetupCard />);
        await vi.waitFor(() => expect(card().open).toBe(true));
        expect(screen.getByText('Using the Teams transcript: what to switch on')).toBeTruthy();
        expect(screen.getByText('Transcription is allowed in the Teams meeting policy of your members.')).toBeTruthy();
        expect(screen.getByText(/Transcript API access is on/)).toBeTruthy();
        expect(screen.getByText(/Include speaker attribution is on/)).toBeTruthy();
        expect(screen.getByText(/OnlineMeetingTranscript\.Read\.All is approved with the approval link above/)).toBeTruthy();
        const commands = screen.getByTestId('teams-transcript-commands').textContent;
        expect(commands).toBe(TEAMS_TRANSCRIPT_COMMANDS);
        expect(commands).toContain('Set-CsTeamsMeetingPolicy -Identity Global -AllowTranscription $true');
        expect(commands).toContain('Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true');
        expect(screen.getByText(/For members nothing changes/)).toBeTruthy();
        // The organisation chose it: no pointer to the setting.
        expect(screen.queryByTestId('teams-transcript-not-chosen')).toBeNull();
    });

    it('copies the commands', async () => {
        fetchMock.mockResolvedValue(answer(overview('transcript')));
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
        renderWithClient(<TeamsTranscriptSetupCard />);
        await vi.waitFor(() => expect(card().open).toBe(true));
        await user.click(screen.getByRole('button', { name: 'Copy the commands' }));
        expect(writeText).toHaveBeenCalledWith(TEAMS_TRANSCRIPT_COMMANDS);
        expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    });

    it.each([['recording'], [null]] as const)('stays folded away with source %s, and says where to choose the Teams transcript', async (source) => {
        fetchMock.mockResolvedValue(answer(overview(source)));
        renderWithClient(<TeamsTranscriptSetupCard />);
        expect((await screen.findByTestId('teams-transcript-not-chosen')).textContent).toMatch(/choose it under "Where the text comes from"/);
        expect(card().open).toBe(false);
    });
});
