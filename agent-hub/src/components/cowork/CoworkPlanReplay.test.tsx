// "Replay on last month": only a changed plan offers it, next to the try-out and above Approve; one press starts the
// replay, which is read again until it is done, and then shows one headline that counts only full replays and one
// plain line per past run. The network is the seam (a recording fetch), no module is mocked.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextType } from 'react';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import EntitlementsContext from '../licensing/EntitlementsContext';
import CoworkPlanPanel from './CoworkPlanPanel';
import CoworkPlanReplay, { replayHeadline, replayLine } from './CoworkPlanReplay';
import { englishT, planState, supplierRadarDraft } from './coworkPlan.fixture';
import type { ReplayState } from '@/api/coworkReplay';

const run = (pastRunId: string, verdict: ReplayState['runs'][number]['verdict'], over: Partial<ReplayState['runs'][number]> = {}) => ({
    pastRunId, startedAt: null, verdict, reason: null, missingSteps: 0, differingSteps: [], ...over,
});
const DONE: ReplayState = {
    replayId: 'rp-1', status: 'done', done: true, fingerprint: 'f'.repeat(64), total: 5, same: 2, differs: 1, partial: 1, notReplayable: 1,
    runs: [run('r5', 'same'), run('r4', 'differs', { differingSteps: ['draft'] }), run('r3', 'partial', { missingSteps: 2 }), run('r2', 'same'), run('r1', 'not_replayable', { reason: 'too_old' })],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkPlanReplay — the words', () => {
    it('the headline counts only the runs replayed in full', () => {
        expect(replayHeadline(DONE, englishT)).toBe('2 of 3 the same, 1 differs');
        expect(replayHeadline({ ...DONE, same: 18, differs: 2 }, englishT)).toBe('18 of 20 the same, 2 differ');
        expect(replayHeadline({ ...DONE, same: 4, differs: 0 }, englishT)).toBe('4 of 4 the same');
        expect(replayHeadline({ ...DONE, same: 0, differs: 0 }, englishT)).toBe('None of the past runs could be replayed in full.');
        expect(replayHeadline({ ...DONE, done: false, status: 'running' }, englishT)).toBe('Replaying the plan on the past runs…');
    });

    it('one plain line per past run', () => {
        expect(replayLine(run('a', 'same'), englishT)).toBe('Replayed in full: it comes out the same.');
        expect(replayLine(run('a', 'differs'), englishT)).toBe('Replayed in full: it comes out different.');
        expect(replayLine(run('a', 'partial', { missingSteps: 1 }), englishT)).toBe('Replayed in part: 1 step had no recording. It is new, or asks something different than then.');
        expect(replayLine(run('a', 'partial', { missingSteps: 3 }), englishT)).toBe('Replayed in part: 3 steps had no recording. They are new, or ask something different than then.');
        expect(replayLine(run('a', 'not_replayable', { reason: 'no_plan' }), englishT)).toBe('Could not be replayed: it did not follow a plan.');
    });
});

describe('CoworkPlanReplay — a replay', () => {
    it('starts with an empty body and is read until it is done', async () => {
        let reads = 0;
        const calls = stubRecordingFetch(({ method }) => {
            if (method === 'POST') return jsonResponse({ replayId: 'rp-1', fingerprint: 'f'.repeat(64), total: 5 }, 202);
            reads += 1;
            return jsonResponse(reads === 1 ? { ...DONE, status: 'running', done: false, runs: [] } : DONE);
        });
        renderWithClient(<CoworkPlanReplay coworkId="w1" t={englishT} />);
        await userEvent.click(screen.getByTestId('cowork-replay-start'));
        expect(await screen.findByText('2 of 3 the same, 1 differs', {}, { timeout: 4000 })).toBeInTheDocument();
        expect(calls[0]).toMatchObject({ method: 'POST', body: {} });
        expect(calls[0]?.url).toMatch(/\/api\/cowork\/w1\/plan\/replay$/);
        expect(calls.slice(1).every((c) => c.method === 'GET' && c.url.endsWith('/api/cowork/w1/plan/replay/rp-1'))).toBe(true);
        expect(within(screen.getByTestId('cowork-replay-run-r1')).getByText(/Could not be replayed: it is older than the run history keeps\./)).toBeInTheDocument();
        expect(screen.getByTestId('cowork-replay-run-r3')).toHaveAttribute('data-verdict', 'partial');
        expect(screen.getByTestId('cowork-replay-start')).toHaveTextContent('Replay again');
    });

    it('says why when the replay is refused', async () => {
        stubRecordingFetch(() => jsonResponse({ error: 'A replay of this plan is already running. Wait until it is done.', code: 'cowork_replay_running' }, 409));
        renderWithClient(<CoworkPlanReplay coworkId="w1" t={englishT} />);
        await userEvent.click(screen.getByTestId('cowork-replay-start'));
        expect(await screen.findByRole('alert')).toHaveTextContent('A replay of this plan is already running.');
    });
});

describe('CoworkPlanReplay — on the Plan tab', () => {
    type Entitlements = ContextType<typeof EntitlementsContext>;
    const ALLOWED = { loading: false, can: (id: string) => id === 'automations' } as unknown as Entitlements;
    const draft = supplierRadarDraft();
    const approved = { version: 1, fingerprint: draft.fingerprint, approvedAt: null, permissions: draft.permissions };
    const LEVELS = { chosen: null, level: 'on_its_own', asksAvailable: false, letThrough: 0, needed: 10, options: [] };
    const show = async (plan: unknown) => {
        stubRecordingFetch(({ url }) => {
            if (url.endsWith('/independence')) return jsonResponse(LEVELS);
            if (url.endsWith('/trust')) return jsonResponse({ needed: 5, ceilingAllows: true, entries: [] });
            return jsonResponse(plan);
        });
        renderWithClient(<EntitlementsContext.Provider value={ALLOWED}><CoworkPlanPanel coworkId="w1" /></EntitlementsContext.Provider>);
        await screen.findByTestId('cowork-plan');
    };

    it('a changed plan offers the replay above Approve', async () => {
        await show(planState({ approved: { ...approved, fingerprint: 'older' } }));
        const replay = screen.getByTestId('cowork-replay');
        const approve = screen.getByTestId('cowork-plan-approve');
        expect(replay.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByTestId('cowork-plan-try')).toBeInTheDocument();
    });

    it('a first plan does not: there is nothing to compare it with', async () => {
        await show(planState());
        expect(screen.getByTestId('cowork-plan-try')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-replay')).toBeNull();
    });

    it('the approved plan does not: it is what ran', async () => {
        await show(planState({ approved, upToDate: true }));
        expect(screen.getByTestId('cowork-plan-try')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-replay')).toBeNull();
    });
});
