// "Make it routine": the card shows what every past run used and asks the planner for fixed steps; the proof shows a
// try-out next to the last run the AI made. The network is the seam (a recording fetch), no module is mocked.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import CoworkRoutine from './CoworkRoutine';
import CoworkRoutineCompare from './CoworkRoutineCompare';

const t = (_k: string, en: string, vars?: Record<string, unknown>) => en.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? ''));
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkRoutine', () => {
    it('says what every run used, and proposes fixed steps on request', async () => {
        stubRecordingFetch(() => jsonResponse({ applicable: true, needed: 3, signals: { runs: 6, worthIt: true, readsOutsideText: true, habits: [], steady: [{ tool: 'web_search', app: 'web', inRuns: 6, callsPerRun: 4 }] } }));
        const onPropose = vi.fn();
        renderWithClient(<CoworkRoutine coworkId="w1" busy={false} onPropose={onPropose} t={t} />);
        expect(await screen.findByText('It went the same way in its last 6 runs. Every run used: web_search (about 4 a run).')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Propose fixed steps' }));
        expect(onPropose).toHaveBeenCalledTimes(1);
    });

    it('says nothing while there is not enough to go on', async () => {
        const calls = stubRecordingFetch(() => jsonResponse({ applicable: true, needed: 3, signals: { runs: 1, worthIt: false, readsOutsideText: false, habits: [], steady: [] } }));
        renderWithClient(<CoworkRoutine coworkId="w1" busy={false} onPropose={() => {}} t={t} />);
        await vi.waitFor(() => expect(calls.length).toBe(1));
        expect(screen.queryByTestId('cowork-routine')).toBeNull();
    });

    it('the proof: both results side by side, the items in common, and what only the AI found', async () => {
        stubRecordingFetch(() => jsonResponse({ before: 4, after: 3, same: 3, onlyBefore: ['An opinion piece'], onlyAfter: [], beforeText: 'AI text', afterText: 'Plan text', beforeMs: 190_000, afterMs: 38_000 }));
        renderWithClient(<CoworkRoutineCompare coworkId="w1" tryId="try-1" done t={t} />);
        expect(await screen.findByText(/Same items: 3 of 4\./)).toBeInTheDocument();
        expect(screen.getByText('AI text')).toBeInTheDocument();
        expect(screen.getByText('Plan text')).toBeInTheDocument();
        expect(screen.getByText('Only in the AI\'s run: An opinion piece')).toBeInTheDocument();
    });
});
