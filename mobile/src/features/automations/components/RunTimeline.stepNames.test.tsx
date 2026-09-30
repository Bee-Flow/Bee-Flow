/**
 * A run, read on a phone, says what each step WAS.
 *
 * The timeline printed `step.stepType` straight out of the payload, so a run
 * read "integration_action · 1.2s", "knowledge_write", "stop_error" — the
 * engine's own identifiers, and the only description of a step a phone shows
 * at all. The browser, on the very same run, says "Action", "To knowledge
 * base", "Stop". One run reading as two different routines depending on which
 * screen you opened is the thing this closes.
 *
 * stepLockstep.test.ts pins that every server step type HAS a name.
 * This pins that the timeline actually uses it — the wiring, which a name
 * table cannot check about itself and which nothing else here renders.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/automations/components/RunTimeline.stepNames.test.tsx
 */

import { render, screen } from '@testing-library/react-native';
import React from 'react';

import { ThemeProvider } from '@/core/theme/ThemeProvider';

import { RunTimeline } from './RunTimeline';
import type { AutomationDefinition, AutomationRunStep } from '../model/types';

function step(over: Partial<AutomationRunStep> = {}): AutomationRunStep {
    return {
        runId: 'r1',
        stepId: 's1',
        parentStepId: null,
        stepType: 'integration_action',
        attempts: 1,
        status: 'succeeded',
        startedAt: '2026-09-21T10:00:00.000Z',
        finishedAt: '2026-09-21T10:00:01.000Z',
        input: null,
        output: null,
        error: null,
        errorClass: null,
        branchIndex: null,
        ...over,
    };
}

async function draw(steps: AutomationRunStep[], definition: AutomationDefinition | null = null): Promise<void> {
    await render(
        <ThemeProvider>
            <RunTimeline steps={steps} definition={definition} />
        </ThemeProvider>,
    );
}

describe('the step line', () => {
    it('SAYS "Action", not "integration_action"', async () => {
        await draw([step()]);
        expect(screen.queryAllByText(/Action/).length).toBeGreaterThan(0);
        expect(screen.queryAllByText(/integration_action/)).toEqual([]);
    });

    it('names the other identifiers a run is full of', async () => {
        await draw([
            step({ stepId: 'a', stepType: 'knowledge_write' }),
            step({ stepId: 'b', stepType: 'stop_error' }),
            step({ stepId: 'c', stepType: 'http_request' }),
        ]);
        expect(screen.queryAllByText(/To knowledge base/).length).toBeGreaterThan(0);
        expect(screen.queryAllByText(/Stop/).length).toBeGreaterThan(0);
        expect(screen.queryAllByText(/Web service call/).length).toBeGreaterThan(0);
        for (const raw of [/knowledge_write/, /stop_error/, /http_request/]) {
            expect(screen.queryAllByText(raw)).toEqual([]);
        }
    });

    it('prints a type this build has never heard of rather than swallowing it', async () => {
        // A server can be newer than the app. A step we cannot name is still a
        // step that ran, and the identifier is the only clue left about it.
        await draw([step({ stepType: 'invented_next_year' })]);
        expect(screen.queryAllByText(/invented_next_year/).length).toBeGreaterThan(0);
    });

    it('a step with no type at all draws without an empty separator', async () => {
        // The line joins its parts with ' · '; a null name must drop out
        // rather than leave a leading bullet with nothing in front of it.
        await draw([step({ stepType: null, attempts: 1 })]);
        expect(screen.queryAllByText(/^ · /)).toEqual([]);
    });
});

describe('the step title', () => {
    // The ids a run records, and the tool ids a step without a label carries.
    const DEF = {
        trigger: { id: 'trg_1', type: 'trigger', label: 'New invoice mail' },
        steps: [
            { id: 'act_4d4307a', type: 'integration_action', label: 'Send the invoice', tool: 'gmail_send' },
            { id: 'act_2', type: 'integration_action', tool: 'gmail_send' },
            { id: 'ai_77', type: 'ai_step' },
            { id: 'call_1', type: 'call_layer', layerKey: 'addr' },
        ],
        layers: { addr: { title: 'Tidy the address', steps: [{ id: 'act_9f2c', type: 'set', label: 'Split the street' }] } },
    } as unknown as AutomationDefinition;

    it('is the name the routine gave the step, never its id or its tool', async () => {
        await draw(
            [
                step({ stepId: 'trg_1', stepType: 'trigger' }),
                step({ stepId: 'act_4d4307a' }),
                step({ stepId: 'act_2' }),
                step({ stepId: 'ai_77', stepType: 'ai_step' }),
                step({ stepId: 'call_1', stepType: 'call_layer' }),
                step({ stepId: 'call_1/act_9f2c', stepType: 'set', parentStepId: 'call_1' }),
            ],
            DEF,
        );
        for (const name of ['New invoice mail', 'Send the invoice', 'Gmail Send', 'AI step', 'Tidy the address', 'Split the street']) {
            expect(screen.getByText(name)).toBeTruthy();
        }
        for (const raw of [/trg_1/, /act_4d4307a/, /gmail_send/, /ai_step/, /ai_77/, /call_1/, /act_9f2c/]) {
            expect(screen.queryAllByText(raw)).toEqual([]);
        }
    });

    it('is the step’s kind when the definition is gone, without saying it twice', async () => {
        await draw([step({ stepId: 'act_4d4307a' })]);
        expect(screen.getByText('Action')).toBeTruthy();
        expect(screen.queryAllByText(/act_4d4307a/)).toEqual([]);
        expect(screen.queryAllByText(/Action ·/)).toEqual([]);
    });

    it('names a step to a screen reader by the same title', async () => {
        await draw([step({ stepId: 'act_4d4307a', output: { ok: true } })], DEF);
        expect(screen.getByLabelText(/^Step 1, Send the invoice, /)).toBeTruthy();
    });
});
