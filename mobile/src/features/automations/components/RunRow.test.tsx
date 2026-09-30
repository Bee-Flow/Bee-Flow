/** A run row says what started the run in words — "An app event", not "app_event". */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { RunRow } from './RunRow';
import type { AutomationRun } from '../model/types';

const run = (over: Partial<AutomationRun>): AutomationRun => ({
    id: 'r1',
    automationId: 'a1',
    version: 1,
    userId: 'u1',
    triggerKind: null,
    triggerPayload: null,
    mode: 'live',
    status: 'success',
    startedAt: null,
    finishedAt: null,
    durationMs: 1200,
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

describe('RunRow', () => {
    it.each([
        ['app_event', 'An app event'],
        ['manual_step', 'Started by hand'],
        ['agent_call', 'Called by an agent'],
    ])('says the trigger %s as words', async (kind, words) => {
        await renderScreen(<RunRow run={run({ triggerKind: kind })} />);
        expect(screen.getByText(new RegExp(`^${words} · `))).toBeTruthy();
        expect(screen.queryByText(new RegExp(kind))).toBeNull();
    });

    it('marks a test run and the failures it recovered from', async () => {
        await renderScreen(<RunRow run={run({ triggerKind: 'manual', mode: 'dry_run', handledErrorCount: 2 })} />);
        expect(screen.getByText(/Test run · 2 recovered$/)).toBeTruthy();
    });
});
