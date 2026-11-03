/**
 * Back from a run goes back, like the hardware Back.
 *
 * The header's arrow REPLACED the run with its automation's run list. Opened
 * from that list, that stacked a second list over the first; opened from a
 * Cowork card, the runs log or a form's answers, it sent the person to a list
 * they had never been on. Only a run opened cold (a link, a notification) has
 * nothing behind it, and lands on the list.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/automations/screens/RunDetailScreen.test.tsx
 */

import { fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { leaveRun, RunDetailScreen } from './RunDetailScreen';

const mockRouter = { back: jest.fn(), replace: jest.fn(), push: jest.fn(), navigate: jest.fn(), canGoBack: jest.fn(() => true) };

jest.mock('expo-router', () => ({ useRouter: () => mockRouter, Stack: { Screen: () => null } }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/sse', () => jest.requireActual('@/shared/testing/screenMocks').silentSse());

const RUN = { id: 'r1', automationId: 'a1', status: 'success', startedAt: '2026-09-20T10:00:00.000Z', finishedAt: '2026-09-20T10:00:03.000Z' };

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation(async (path: string) => {
        if (path === '/api/automation/runs/r1') return { run: RUN };
        if (path === '/api/automation/runs/r1/steps') return { steps: [], definition: null, version: 1 };
        return null;
    });
});

async function pressBack() {
    await renderScreen(<RunDetailScreen automationId="a1" runId="r1" />);
    await fireEvent.press(await screen.findByLabelText('Back'));
}

describe('Back from a run', () => {
    it('returns to where the run was opened from', async () => {
        mockRouter.canGoBack.mockReturnValue(true);
        await pressBack();
        expect(mockRouter.back).toHaveBeenCalledTimes(1);
        expect(mockRouter.replace).not.toHaveBeenCalled();
    });

    it('lands on the automation’s run list when nothing is behind it', async () => {
        mockRouter.canGoBack.mockReturnValue(false);
        await pressBack();
        expect(mockRouter.replace).toHaveBeenCalledWith('/automations/a1/runs');
        expect(mockRouter.back).not.toHaveBeenCalled();
    });

    it('leaveRun is the same decision, on its own', () => {
        const router = { back: jest.fn(), replace: jest.fn(), canGoBack: () => false };
        leaveRun(router, 'a9');
        expect(router.replace).toHaveBeenCalledWith('/automations/a9/runs');
    });
});

/**
 * Stop on every pause, and honest decisions (WI-13). The parts below the
 * screen are in components/RunActions.awaitingForm.test.tsx and
 * RunActions.decideOutcome.test.tsx.
 */
describe('a run that waits', () => {
    const FORM_WAIT = { ...RUN, status: 'awaiting_form', finishedAt: null, profile: { kind: 'test' } };
    const APPROVAL_WAIT = { ...RUN, status: 'awaiting_approval', finishedAt: null, profile: { kind: 'test' }, canDecide: true, approvalId: 'ap1' };

    function serve(run: Record<string, unknown>, pendingApproval: unknown = undefined) {
        (api.get as jest.Mock).mockImplementation(async (path: string) => {
            if (path === '/api/automation/runs/r1') return { run };
            if (path === '/api/automation/runs/r1/steps') return { steps: [], definition: null, version: 1 };
            if (path === '/api/automation/runs/r1/form') return { runId: 'r1', status: run.status, waiting: false, ...(pendingApproval ? { pendingApproval } : {}) };
            return null;
        });
    }

    it('discards a test run waiting on a form page: the cancel goes out and the screen says so', async () => {
        serve(FORM_WAIT);
        (api.post as jest.Mock).mockResolvedValueOnce({ accepted: true, run: { ...FORM_WAIT, status: 'cancelled' } });
        await renderScreen(<RunDetailScreen automationId="a1" runId="r1" />);
        await userEvent.setup().press(await screen.findByText('Discard this test run'));
        expect(api.post).toHaveBeenCalledWith('/api/automation/runs/r1/cancel', {}, { retry: false });
        expect(await screen.findByText('Test run discarded')).toBeTruthy();
    });

    it('shows an older server’s refusal of that cancel in its own words', async () => {
        serve(FORM_WAIT);
        (api.post as jest.Mock).mockRejectedValueOnce(new ApiError('Run is in awaiting_form state and cannot be cancelled', { status: 409 }));
        await renderScreen(<RunDetailScreen automationId="a1" runId="r1" />);
        await userEvent.setup().press(await screen.findByText('Discard this test run'));
        expect(await screen.findByText('Run is in awaiting_form state and cannot be cancelled')).toBeTruthy();
    });

    it('sends an approval that asks for answers to the approvals screen instead of posting without them', async () => {
        serve(APPROVAL_WAIT, { approvalId: 'ap1', prompt: 'Refund?', fields: [{ name: 'amount', type: 'number', required: true }], canDecide: true, isTest: true });
        await renderScreen(<RunDetailScreen automationId="a1" runId="r1" />);
        expect(await screen.findByText('Waiting for your decision (test)')).toBeTruthy();
        // Approve waits until the pending approval is read; then it goes to the sheet.
        const user = userEvent.setup();
        await waitFor(async () => {
            await user.press(screen.getByText('Approve'));
            expect(mockRouter.push).toHaveBeenCalledWith('/approvals/ap1?decide=approve');
        });
        expect(api.post).not.toHaveBeenCalled();
    });

    it('says a panel vote is a vote, not "Approved"', async () => {
        serve(APPROVAL_WAIT, { approvalId: 'ap1', prompt: 'Refund?', fields: [], canDecide: true, isTest: true });
        (api.post as jest.Mock).mockResolvedValueOnce({ accepted: true, decision: 'vote_recorded', votes: [] });
        await renderScreen(<RunDetailScreen automationId="a1" runId="r1" />);
        const user = userEvent.setup();
        await waitFor(async () => {
            await user.press(screen.getByText('Approve'));
            expect(api.post).toHaveBeenCalledWith('/api/automation/runs/r1/approve-step', { decision: 'approve' }, { retry: false });
        });
        expect(await screen.findByText('Your vote is recorded. It still waits for the others.')).toBeTruthy();
    });
});
