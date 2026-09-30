/**
 * The live card says which step a run is at by NAME.
 *
 * It printed "Step act_4d4307a · started 3 minutes ago": the id the live feed
 * carries, which nobody who built the routine has ever seen.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/automations/components/LiveRunCard.test.tsx
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { LiveRunCard } from './LiveRunCard';
import type { RunStreamState } from '../hooks/useRunStream';
import type { ActiveRun, AutomationDefinition, RunEvent } from '../model/types';

const RUN: ActiveRun = { runId: 'r1', automationId: 'a1', status: 'running', startedAt: new Date().toISOString(), triggerKind: 'manual' };

const DEF = {
    trigger: { id: 'trg', type: 'trigger' },
    steps: [
        { id: 'act_4d4307a', type: 'integration_action', label: 'Send the invoice', tool: 'gmail_send' },
        { id: 'call_1', type: 'call_layer', layerKey: 'lk' },
    ],
    layers: { lk: { title: 'Tidy', steps: [{ id: 'act_9f2c', type: 'set', label: 'Split the street' }] } },
} as unknown as AutomationDefinition;

const stream = (last: RunEvent | null): RunStreamState => ({ connected: true, statuses: {}, last });

async function draw(last: RunEvent | null, onStop = jest.fn()) {
    await renderWithProviders(<LiveRunCard run={RUN} stream={stream(last)} definition={DEF} onStop={onStop} />);
    return onStop;
}

describe('LiveRunCard', () => {
    it('names the step the run is at, never its id', async () => {
        await draw({ type: 'step.started', runId: 'r1', stepId: 'act_4d4307a', stepType: 'integration_action' });
        expect(screen.getByText(/^Now: Send the invoice · started /)).toBeTruthy();
        expect(screen.queryAllByText(/act_4d4307a/)).toEqual([]);
    });

    it('names a flowlet’s inner step by its own label', async () => {
        await draw({ type: 'step.started', runId: 'r1', stepId: 'call_1/act_9f2c', stepType: 'set' });
        expect(screen.getByText(/^Now: Split the street · /)).toBeTruthy();
    });

    it('says what kind of step it is when the definition does not know it', async () => {
        await draw({ type: 'step.started', runId: 'r1', stepId: 'act_new', stepType: 'ai_step' });
        expect(screen.getByText(/^Now: AI step · /)).toBeTruthy();
        expect(screen.queryAllByText(/act_new/)).toEqual([]);
    });

    it('ignores a step another run of the same routine reported', async () => {
        await draw({ type: 'step.started', runId: 'r2', stepId: 'act_4d4307a' });
        expect(screen.getByText(/^Started /)).toBeTruthy();
        expect(screen.queryAllByText(/Send the invoice/)).toEqual([]);
    });

    it('says when it started before any step has reported, and stops on request', async () => {
        const onStop = await draw(null);
        expect(screen.getByText(/^Started /)).toBeTruthy();
        await fireEvent.press(screen.getByText('Stop'));
        expect(onStop).toHaveBeenCalled();
    });
});
