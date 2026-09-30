/**
 * How a run ended: the error class in words rather than its token, and the
 * caught-failures banner in the singular — it said "1 step failure were
 * caught…".
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { RunOutcome } from './RunOutcome';
import type { AutomationRun } from '../model/types';

const run = (over: Partial<AutomationRun>): AutomationRun => ({
    id: 'r1',
    automationId: 'a1',
    version: 3,
    userId: 'u1',
    triggerKind: 'app_event',
    triggerPayload: null,
    mode: 'live',
    status: 'success',
    startedAt: '2026-09-27T09:00:00Z',
    finishedAt: '2026-09-27T09:00:05Z',
    durationMs: 5000,
    error: null,
    summary: null,
    parentRunId: null,
    rootRunId: 'r1',
    cancelRequested: false,
    awaitingStepId: null,
    awaitingStepExpiresAt: null,
    errorClass: null,
    handledErrorCount: 0,
    ...over,
});

describe('RunOutcome', () => {
    it('says one caught failure in the singular', async () => {
        await renderScreen(<RunOutcome run={run({ handledErrorCount: 1 })} failed={false} />);
        expect(screen.getByText('1 step failed and was caught by an error branch — the run still finished.')).toBeTruthy();
    });

    it('says several caught failures in the plural', async () => {
        await renderScreen(<RunOutcome run={run({ handledErrorCount: 3 })} failed={false} />);
        expect(screen.getByText('3 steps failed and were caught by an error branch — the run still finished.')).toBeTruthy();
    });

    it('names the error class in words, not as its token', async () => {
        await renderScreen(
            <RunOutcome run={run({ status: 'error', error: 'HTTP 429 from Gmail', errorClass: 'rate_limit' })} failed />,
        );
        expect(screen.getByText('(a connected app asked us to slow down)')).toBeTruthy();
        expect(screen.queryByText('rate_limit')).toBeNull();
    });

    it('shows no class at all for one nobody has put into words', async () => {
        await renderScreen(<RunOutcome run={run({ status: 'error', error: 'Boom', errorClass: 'HttpError' })} failed />);
        expect(screen.queryByText(/HttpError/)).toBeNull();
    });
});
