/**
 * A step inside a flowlet is named like any other step (BFSF-457).
 *
 * The runner records such a step under its call step's id, `<callId>/<innerId>`,
 * and the timeline used to look only the bare id up in the top-level steps, so
 * every nested row read as its raw recorded path. model/stepLabels.ts indexes
 * the flowlets' steps too; this pins that the timeline uses it.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/automations/components/RunTimeline.flowletLabels.test.tsx
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
        stepType: 'ai',
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

const definition: AutomationDefinition = {
    steps: [
        { id: 'cl_a', type: 'call_layer', layerKey: 'outer', label: 'Research' },
        { id: 'cb_1', type: 'call_block', label: 'Shared step' },
    ],
    layers: {
        outer: {
            steps: [
                { id: 'ai_1', type: 'ai', label: 'Find keywords' },
                { id: 'cl_b', type: 'call_layer', layerKey: 'inner', label: 'Go deeper' },
            ],
        },
        inner: { steps: [{ id: 'http_1', type: 'http_request', label: 'Ask the API' }] },
    },
};

async function draw(steps: AutomationRunStep[]): Promise<void> {
    await render(
        <ThemeProvider>
            <RunTimeline steps={steps} definition={definition} />
        </ThemeProvider>,
    );
}

describe('steps inside a flowlet', () => {
    it('are named by their builder label, not their recorded path', async () => {
        await draw([
            step({ stepId: 'cl_a', stepType: 'call_layer' }),
            step({ stepId: 'cl_a/ai_1', parentStepId: 'cl_a' }),
        ]);
        expect(screen.queryAllByText('Find keywords').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('cl_a/ai_1')).toEqual([]);
    });

    it('are named one flowlet deeper too', async () => {
        await draw([step({ stepId: 'cl_a/cl_b/http_1', parentStepId: 'cl_a/cl_b', stepType: 'http_request' })]);
        expect(screen.queryAllByText('Ask the API').length).toBeGreaterThan(0);
    });

    it('fall back to the kind of step, never the recorded path, when the snapshot does not hold them', async () => {
        // A published Step runs a definition that is not in the run's
        // snapshot. The timeline names a step by its kind rather than print an
        // id nobody recognises (see model/stepLabels.ts).
        await draw([step({ stepId: 'cb_1/x_9', parentStepId: 'cb_1', stepType: 'http_request' })]);
        expect(screen.queryAllByText('Web service call').length).toBeGreaterThan(0);
        expect(screen.queryAllByText(/cb_1\/x_9/)).toEqual([]);
    });
});
