import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import TeamsHowItWorksCard from './TeamsHowItWorksCard';

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

const way = (name: 'recording' | 'transcript') => document.querySelector(`li[data-way="${name}"]`) as HTMLElement;

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('TeamsHowItWorksCard', () => {
    it('says that Teams records, and names the two ways the text can be made', () => {
        fetchMock.mockResolvedValue(answer({ error: 'no' }, 403));
        renderWithClient(<TeamsHowItWorksCard />);
        expect(screen.getByRole('heading', { name: 'How a meeting becomes a note, and who turns speech into text' })).toBeTruthy();
        expect(screen.getByText(/Someone presses record in Teams, or Bee Flow sets the meeting to record automatically/)).toBeTruthy();
        expect(screen.getByText(/Teams makes a transcript along with the recording\. No bot joins the call\./)).toBeTruthy();

        expect(within(way('recording')).getByText('Bee Flow transcribes the recording')).toBeTruthy();
        expect(way('recording').textContent).toMatch(/transcription service chosen for Bee Flow \(Admin, Platform services, Transcription\)/);
        expect(way('recording').textContent).toMatch(/Microsoft does not do the transcription/);

        expect(within(way('transcript')).getByText('The Teams transcript')).toBeTruthy();
        expect(way('transcript').textContent).toMatch(/Teams makes the text during the meeting and Bee Flow imports it/);
        expect(way('transcript').textContent).toMatch(/Bee Flow has no transcription cost\. The note has no audio/);

        expect(screen.getByText(/The summary and the action items come from your own AI models\. Microsoft Copilot is not used\./)).toBeTruthy();
        expect(screen.getByTestId('teams-how-way-back').textContent).toMatch(/Bee Flow uses the other one, so a note still comes/);
    });

    it('marks no way while the organisation\'s choice is unknown', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'no' }, 403));
        renderWithClient(<TeamsHowItWorksCard />);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.queryByText('In use')).toBeNull();
        expect(screen.queryByText('Each member chooses')).toBeNull();
    });

    it.each([
        ['recording', 'transcript'],
        ['transcript', 'recording'],
    ] as const)('marks %s as in use when the organisation chose it, and not %s', async (chosen, other) => {
        fetchMock.mockResolvedValue(answer(overview(chosen)));
        renderWithClient(<TeamsHowItWorksCard />);
        expect(await within(way(chosen)).findByText('In use')).toBeTruthy();
        expect(within(way(other)).queryByText('In use')).toBeNull();
    });

    it('says each member chooses while the organisation has no opinion', async () => {
        fetchMock.mockResolvedValue(answer(overview(null)));
        renderWithClient(<TeamsHowItWorksCard />);
        expect(await within(way('recording')).findByText('Each member chooses')).toBeTruthy();
        expect(within(way('transcript')).getByText('Each member chooses')).toBeTruthy();
        expect(screen.queryByText('In use')).toBeNull();
    });
});
