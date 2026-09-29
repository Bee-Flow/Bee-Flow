import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import RunStepTimeline from './RunStepTimeline';

/**
 * The step list is the one surface that holds the whole recorded row, so it
 * is the one that can say WHY a step was skipped.
 *
 * Before, it could not: fifteen different reasons were flattened to the
 * status word `skipped` by runDag, and the timeline printed one grey "Not
 * needed" for all of them. A knowledge step that found nothing to write —
 * the case the Runs artboard is built around — looked exactly like a step
 * somebody had switched off, and neither looked like anything worth reading.
 */

const step = (over = {}) => ({
    runId: 'run1',
    stepId: 's1',
    parentStepId: null,
    stepType: 'ai',
    attempts: 1,
    status: 'success',
    output: null,
    error: null,
    ...over,
});

const definition = { steps: [{ id: 's1', label: 'Write the summary' }, { id: 's2', label: 'Send it' }] };

function keys(container) {
    return [...container.querySelectorAll('[data-status-key]')].map(el => el.getAttribute('data-status-key'));
}

describe('RunStepTimeline — the two kinds of skip', () => {
    beforeEach(cleanup);

    it('leaves a switched-off step grey and calls it "Skipped"', () => {
        const { container } = render(
            <RunStepTimeline steps={[step({ status: 'skipped', output: { disabled: true } })]} definition={definition} />,
        );
        expect(keys(container)).toEqual(['run_status.skipped']);
        expect(screen.getByText('Skipped')).toBeTruthy();
    });

    it('marks a step that ran and found nothing to do as "Nothing to do"', () => {
        const { container } = render(
            <RunStepTimeline
                steps={[step({ status: 'skipped', output: { written: false, chunks: 0, skipped: 'There was nothing to write this run.' } })]}
                definition={definition}
            />,
        );
        expect(keys(container)).toEqual(['run_status.nothing_to_do']);
        expect(screen.getByText('Nothing to do')).toBeTruthy();
    });

    it('gives the two skips different colours in the same run', () => {
        const { container } = render(
            <RunStepTimeline
                steps={[
                    step({ stepId: 's1', status: 'skipped', output: { disabled: true } }),
                    step({ stepId: 's2', status: 'skipped', output: { skipped: 'nothing to write' } }),
                ]}
                definition={definition}
            />,
        );
        const [off, empty] = [...container.querySelectorAll('[data-status-key]')];
        expect(off.getAttribute('class')).not.toBe(empty.getAttribute('class'));
    });

    it('does not guess amber for a skip whose reason it cannot recover', () => {
        // A warning nobody can act on is worse than no warning. Grey claims
        // less, and an old row with no output is exactly that case.
        const { container } = render(
            <RunStepTimeline steps={[step({ status: 'skipped', output: null })]} definition={definition} />,
        );
        expect(keys(container)).toEqual(['run_status.skipped']);
    });
});

describe('RunStepTimeline — the rest of the vocabulary', () => {
    beforeEach(cleanup);

    it('names each step by its own status, in the dictionary\'s words', () => {
        const { container } = render(
            <RunStepTimeline
                steps={[step({ stepId: 's1', status: 'success' }), step({ stepId: 's2', status: 'error', error: 'Mailbox not connected' })]}
                definition={definition}
                runStatus="error"
            />,
        );
        expect(keys(container)).toEqual(['run_status.success', 'run_status.error']);
        expect(screen.getByText('Finished')).toBeTruthy();
        expect(screen.getByText('Failed')).toBeTruthy();
        expect(screen.getByText('Write the summary')).toBeTruthy();
    });

    it('says a classified failure by its plain title, the raw message in the hover', () => {
        const raw = '550 5.1.1 Recipient address rejected';
        render(
            <RunStepTimeline
                steps={[step({ stepId: 's2', status: 'error', error: raw, errorInfo: { title: 'A setting has a value this step cannot use' } })]}
                definition={definition}
                runStatus="error"
            />,
        );
        const line = screen.getByText('A setting has a value this step cannot use');
        expect(line.getAttribute('title')).toBe(raw);
        expect(screen.queryByText(raw)).toBeNull();
    });

    it('still marks where a failed run stopped', () => {
        render(
            <RunStepTimeline
                steps={[step({ stepId: 's1', status: 'error', error: 'boom' }), step({ stepId: 's2', status: 'queued' })]}
                definition={definition}
                runStatus="error"
            />,
        );
        expect(screen.getByText(/This is where it stopped/)).toBeTruthy();
    });
});

describe('RunStepTimeline — steps inside a flowlet (BFSF-457)', () => {
    beforeEach(cleanup);

    const nestedDef = {
        steps: [{ id: 'cl_1', type: 'call_layer', layerKey: 'lk', label: 'Look things up' }],
        layers: { lk: { trigger: { id: 'in', label: 'Input' }, steps: [{ id: 'ai_1', type: 'ai', label: 'Think of variants' }] } },
    };

    it('names a nested row by its builder label, the recorded id kept as its tooltip', () => {
        render(
            <RunStepTimeline
                steps={[step({ stepId: 'cl_1' }), step({ stepId: 'cl_1/ai_1', parentStepId: 'cl_1' })]}
                definition={nestedDef}
            />,
        );
        const row = screen.getByText('Think of variants').closest('button');
        expect(row.getAttribute('title')).toBe('cl_1/ai_1');
        expect(screen.queryByText('cl_1/ai_1')).toBeNull();
    });

    it('reads a step it has no definition for as "<call step> › <id>"', () => {
        render(
            <RunStepTimeline
                steps={[step({ stepId: 'cl_1/x_9', parentStepId: 'cl_1' })]}
                definition={{ steps: [{ id: 'cl_1', type: 'call_block', blockId: 'b1', label: 'Shared step' }] }}
            />,
        );
        expect(screen.getByText('Shared step › x_9')).toBeTruthy();
    });
});
