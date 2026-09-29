import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import StepNodeBase from './StepNodeBase';
import DiagramPane from '../../DiagramPane';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * One failure, one language — whichever pane you read it in.
 *
 * The canvas validation pill has always swapped raw step ids for the author's
 * own labels (FloatingValidationPill → humanizeIssueText), while the card's
 * validation dot handed over the server's record verbatim:
 * `step.unknown_type: Step cond_a3f91b: unknown type`. Clicking a pill that
 * named your step and landing on a tooltip about a hex id reads as a second,
 * unrelated problem — which is the whole reason this is pinned here.
 *
 * The machine code is NOT gone: it moved to the tail of the same tooltip, the
 * only place on the card with room for it, so a support answer can still quote
 * it. The drawer's half of this lives in
 * flow/settings/formPrimitives.validation.test.jsx.
 */
const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', position: { x: 0, y: 0 } },
    steps: [
        { id: 'cond_a3f91b', type: 'condition', label: 'Is it urgent?', expr: 'x > 1', position: { x: 320, y: 0 } },
    ],
    edges: [{ from: 'trg', to: 'cond_a3f91b' }],
};

const VALIDATION = {
    errors: [{
        code: 'step.unknown_type',
        path: 'steps[cond_a3f91b].type',
        message: 'Step cond_a3f91b: unknown type "conditie"',
    }],
    warnings: [],
};

/** The real canvas, sized by hand — jsdom measures nothing (see DiagramPane.build.test.jsx). */
function renderCanvas(props = {}) {
    return render(
        <div style={{ width: 1200, height: 800 }}>
            <DiagramPane definition={DEF} validation={VALIDATION} editable onDefinitionChange={vi.fn()} {...props} />
        </div>,
    );
}

const dotOn = (label) => screen.getByText(label)
    .closest('.react-flow__node')
    .querySelector('[data-testid="node-validation-dot"]');

/** The bare card, with nothing in React Flow's store to read labels from. */
function renderCard(props = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                typeGroupById: new Map([['s7', 'ai']]),
                stepTypeById: new Map([['s7', 'ai_step']]),
                stepNumberById: new Map([['s7', 7]]),
            }}>
                <StepNodeBase nodeId="s7" icon={null} typeLabel="AI step" name="Forecast" sub="one line" {...props} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

describe('the validation dot speaks the pill\'s language', () => {
    beforeEach(cleanup);

    it('names the step the way its author does, and keeps the code at the tail', () => {
        renderCanvas();
        expect(dotOn('Is it urgent?').title)
            .toBe('Step "Is it urgent?": unknown type "conditie" (step.unknown_type)');
    });

    it('never opens with the validation code — that is not what is wrong', () => {
        renderCard({ issues: { errors: [{ code: 'ai_step.agent_unavailable', message: 'This step has no agent to run on.' }], warnings: [] } });
        const title = screen.getByTestId('node-validation-dot').title;
        expect(title.startsWith('This step has no agent to run on.')).toBe(true);
        expect(title).toBe('This step has no agent to run on. (ai_step.agent_unavailable)');
    });

    it('leaves an id it cannot name alone — a dangling reference IS the news', () => {
        renderCanvas({
            validation: {
                errors: [{ code: 'edge.unknown_target', path: 'steps[cond_a3f91b].next', message: 'Step cond_a3f91b points at ghost_99, which does not exist' }],
                warnings: [],
            },
        });
        expect(dotOn('Is it urgent?').title)
            .toBe('Step "Is it urgent?" points at ghost_99, which does not exist (edge.unknown_target)');
    });

    it('a record with no code is just the sentence — no empty brackets', () => {
        renderCard({ issues: { errors: [], warnings: [{ message: 'Runs before anything fills this list.' }] } });
        expect(screen.getByTestId('node-validation-dot').title).toBe('Runs before anything fills this list.');
    });
});
