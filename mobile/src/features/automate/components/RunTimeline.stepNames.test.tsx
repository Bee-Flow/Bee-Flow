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
 * Run: cd mobile && ./node_modules/.bin/jest src/features/automate/components/RunTimeline.stepNames.test.tsx
 */

import { render, screen } from '@testing-library/react-native';
import React from 'react';

import { RunTimeline } from './RunTimeline';
import { ThemeProvider } from '../../../theme/ThemeProvider';
import type { AutomationRunStep } from '../types';

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

async function draw(steps: AutomationRunStep[]): Promise<void> {
    await render(
        <ThemeProvider>
            <RunTimeline steps={steps} definition={null} />
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
