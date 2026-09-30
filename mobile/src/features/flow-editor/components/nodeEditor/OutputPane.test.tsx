/**
 * The Output tab reads like the Automations screens read the same run, and
 * shows what was saved.
 *
 *   - An output is drawn readably first (a record's fields, a table, a list,
 *     a tree in words); the exact JSON tree — `{3}`, `[5]`, `"quoted"`,
 *     `null` — is behind "Show raw".
 *   - After "Save output" the tab showed the older test run's output and its
 *     status, as if the save had not taken, and Edit reopened on that run.
 *     A pinned or hand-written output is what the steps after this one see,
 *     so it is what the tab shows — badged Edited / Pinned, the last test's
 *     status on a line under it — and what Edit opens on.
 *   - "Test step" was offered here for a step the header hides it for (in a
 *     loop, a branch or a flowlet, or a note); a branch step's test always
 *     ended in a server error. The tab follows the header's rule now.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/flow-editor/components/nodeEditor/OutputPane.test.tsx
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import type { AutomationRunStep } from '@/features/automations';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { OutputPane } from './OutputPane';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

function runStep(output: unknown, over: Partial<AutomationRunStep> = {}): AutomationRunStep {
    return {
        runId: 'r1',
        stepId: 's1',
        parentStepId: null,
        stepType: 'set',
        attempts: 1,
        status: 'success',
        startedAt: null,
        finishedAt: null,
        input: null,
        output,
        error: null,
        errorClass: null,
        branchIndex: null,
        ...over,
    };
}

async function draw(step: Partial<FlowNode>, run: AutomationRunStep | null, patchStep = jest.fn(), canTest = true) {
    await renderScreen(
        <OutputPane
            step={{ id: 's1', type: 'set', ...step } as FlowNode}
            runStep={run}
            testError={null}
            testing={false}
            onTest={jest.fn()}
            canTest={canTest}
            patchStep={patchStep}
            disabled={false}
        />,
    );
    return patchStep;
}

describe('the output, readable first', () => {
    it('draws a record as fields, and the exact tree behind "Show raw"', async () => {
        await draw({}, runStep({ note_text: 'ok', waited: 60 }));
        expect(screen.getByText('Note text')).toBeTruthy();
        expect(screen.getByText('ok')).toBeTruthy();
        expect(screen.queryByText('"ok"')).toBeNull();

        await fireEvent.press(screen.getByTestId('output-raw'));
        expect(screen.getByText('"ok"')).toBeTruthy();
        expect(screen.getByText('note_text')).toBeTruthy();
        expect(screen.getByText('Show fields')).toBeTruthy();
    });

    it('draws a nested output as a tree in words, not in JSON', async () => {
        await draw({}, runStep({ messages: [{ id: 1, tags: ['a'] }], seen: null }));
        expect(screen.getByText('Messages')).toBeTruthy();
        expect(screen.getByText('1 item')).toBeTruthy();
        expect(screen.getByText('—')).toBeTruthy();
        expect(screen.queryByText('[1]')).toBeNull();
        expect(screen.queryByText('null')).toBeNull();

        await fireEvent.press(screen.getByTestId('output-raw'));
        expect(screen.getByText('[1]')).toBeTruthy();
        expect(screen.getByText('null')).toBeTruthy();
    });
});

describe('a saved output', () => {
    it('is what the tab shows over the last test run, badged Edited, with the run on a line under it', async () => {
        await draw({ pinnedOutput: { hand_written: 'yes please' }, pinnedSource: 'edited' }, runStep({ from_run: 'old' }));
        expect(screen.getByText('Edited')).toBeTruthy();
        expect(screen.getByText('Hand written')).toBeTruthy();
        expect(screen.queryByText('From run')).toBeNull();
        expect(screen.getByTestId('output-run-status')).toBeTruthy();
        expect(screen.getByText(/^Last test: /)).toBeTruthy();
    });

    it('is what Edit opens on — as named fields, and as the same JSON behind "Edit as JSON"', async () => {
        await draw({ pinnedOutput: { hand_written: 1 }, pinnedSource: 'edited' }, runStep({ from_run: 'old' }));
        await fireEvent.press(screen.getByTestId('output-edit'));
        expect(screen.getByTestId('output-fields-field-1-name').props.value).toBe('hand_written');
        await fireEvent.press(screen.getByTestId('output-raw-toggle'));
        expect(JSON.parse(screen.getByTestId('output-json').props.value)).toEqual({ hand_written: 1 });
    });

    it('a captured pin says Pinned, and no run line when the step never ran', async () => {
        await draw({ pinnedOutput: { captured: 1 } }, null);
        expect(screen.getByText('Pinned')).toBeTruthy();
        expect(screen.queryByTestId('output-run-status')).toBeNull();
    });

    it('with no pin, the run is what is shown and what Edit opens on', async () => {
        await draw({}, runStep({ from_run: 'fresh' }));
        expect(screen.getByText('From run')).toBeTruthy();
        expect(screen.queryByText(/^Last test: /)).toBeNull();
        await fireEvent.press(screen.getByTestId('output-edit'));
        expect(screen.getByLabelText('from_run value').props.value).toBe('fresh');
    });

    it('saves what was typed into the fields as the hand-written output', async () => {
        const patchStep = await draw({}, runStep({ total: 1 }));
        await fireEvent.press(screen.getByTestId('output-edit'));
        await fireEvent.changeText(screen.getByLabelText('total value'), '7');
        await fireEvent.press(screen.getByTestId('output-save'));
        expect(patchStep).toHaveBeenCalledWith(expect.objectContaining({ pinnedOutput: { total: 7 }, pinnedSource: 'edited' }));
    });
});

describe('"Test step"', () => {
    it('is offered where the header offers it', async () => {
        await draw({}, null);
        expect(screen.getByTestId('output-test')).toBeTruthy();
    });

    it('is not offered for a step with no test run of its own (in a loop, a branch or a flowlet, or a note), as in the header', async () => {
        await draw({}, null, jest.fn(), false);
        expect(screen.queryByTestId('output-test')).toBeNull();
        expect(screen.getByTestId('output-edit')).toBeTruthy();
    });
});
