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

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
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
