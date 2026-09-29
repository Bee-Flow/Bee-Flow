import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect, beforeEach } from 'vitest';
import ParallelNode, { parallelSummary, parallelStepCount, parallelBranches } from './ParallelNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';
import { NODE_TYPES } from '../nodeTypes';
import { PALETTE_ABSENT, NODE_DEFS } from '../nodeDefs';

/**
 * The parallel card.
 *
 * The bug this pins: `parallel` runs in the engine and validates cleanly, but
 * had no entry in NODE_TYPES, so React Flow drew its own default node — an
 * unstyled box with no name — for every definition that carried one. The
 * shipped `nc-onboarding` template is exactly such a definition, so the first
 * thing a user saw after picking it was a blank grey rectangle.
 *
 * The generic completeness test next door (flow/nodeDefs.test.js, "every
 * record is renderable, or documented as not") cannot catch a regression here:
 * it is satisfied by a component OR a PALETTE_ABSENT reason, and parallel
 * still — deliberately — has the reason. Removing the component would leave
 * that test green, which is precisely why the registry assertion below names
 * `parallel` out loud, the way the note test does for its own type.
 */
function renderNode(step, runtime = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(),
                triggerIds: new Set(), attachedIds: new Set(), ...runtime,
            }}>
                <ParallelNode id={step.id} data={{ step, runStep: null, issues: { errors: [], warnings: [] }, stepLabelById: new Map() }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

const branchStep = (id, type, label) => ({ id, type, ...(label ? { label } : {}) });

describe('parallel is drawable — the canvas can no longer fall back to a bare node', () => {
    it('NODE_TYPES registers a component for parallel', () => {
        expect(NODE_TYPES.parallel, 'parallel has no canvas component — React Flow will draw a bare default node').toBeTruthy();
        expect(NODE_TYPES.parallel).toBe(ParallelNode);
    });

    it('stays out of the palette, with a reason that no longer claims it is undrawable', () => {
        // Drawable-but-not-addable is the deliberate outcome: nothing in the
        // builder renders an editor for `branches`, so a palette entry would
        // add a shell the user cannot fill. The reason text has to say that
        // rather than "no canvas component yet", which is now false.
        expect(PALETTE_ABSENT.parallel, 'parallel must stay documented as palette-absent').toBeTruthy();
        expect(PALETTE_ABSENT.parallel).not.toMatch(/no canvas component/);
        expect(NODE_DEFS.parallel.family).toBe('branch');
    });
});

describe('ParallelNode', () => {
    beforeEach(cleanup);

    it('says what it holds and how many branches, in the words that make it parallel', () => {
        renderNode({
            id: 'par_1', type: 'parallel', label: 'Onboard the new hire',
            branches: [
                [branchStep('mkdir', 'integration_action', 'Create welcome folder')],
                [branchStep('greet', 'integration_action', 'Send a Talk welcome')],
            ],
        });
        expect(screen.getByTestId('node-name').textContent).toBe('Onboard the new hire');
        expect(screen.getByTestId('node-sub').textContent)
            .toBe('Create welcome folder · Send a Talk welcome — all at the same time');
        expect(screen.getByText('⇉ 2 branches')).toBeTruthy();
    });

    it('names an unnamed branch head by its step type, never by the raw type name', () => {
        renderNode({
            id: 'par_1', type: 'parallel',
            branches: [[branchStep('a', 'notification')], [branchStep('b', 'http_request')]],
        });
        const sub = screen.getByTestId('node-sub').textContent;
        expect(sub).not.toMatch(/http_request|notification/);
        expect(sub).toBe('Notification · Call a web service — all at the same time');
    });

    it('names the first step that RUNS, skipping a note at the head of a branch', () => {
        // execFlow's buildLinearEdges filters notes out of the synthesized
        // chain (BFSF-411), so a note at the top of a branch is the one step
        // in it that never runs. Naming it would make the card say "this runs
        // at the same time" about a canvas annotation. The chip still counts
        // it, because the chip counts what the branch HOLDS.
        renderNode({
            id: 'par_1', type: 'parallel',
            branches: [
                [branchStep('n1', 'note', 'Ask Bram before changing this'), branchStep('a', 'notification', 'Ping the team')],
                [branchStep('n2', 'note', 'TODO')],
            ],
        });
        const sub = screen.getByTestId('node-sub').textContent;
        expect(sub).toBe('Ping the team · empty — all at the same time');
        expect(screen.getByText('⇉ 2 branches').getAttribute('title')).toContain('holding 3 steps');
    });

    it('counts a single branch in the singular', () => {
        renderNode({ id: 'par_1', type: 'parallel', branches: [[branchStep('a', 'notification', 'Ping me')]] });
        expect(screen.getByText('⇉ 1 branch')).toBeTruthy();
    });

    it('says so in words when there are no branches yet — the state the validator errors on', () => {
        renderNode({ id: 'par_1', type: 'parallel', branches: [] });
        expect(screen.getByTestId('node-sub').textContent).toBe('no branches yet — nothing runs here');
        expect(screen.getByText('⇉ 0 branches')).toBeTruthy();
    });

    it('survives the malformed shapes the validator reports rather than refuses', () => {
        // parallel.branch_shape / parallel.branches_missing are REPORTED, so
        // this data reaches the canvas. A node component that throws blanks
        // the whole React Flow tree, pill and all.
        expect(() => renderNode({ id: 'par_1', type: 'parallel', branches: 'nope' })).not.toThrow();
        cleanup();
        expect(() => renderNode({ id: 'par_1', type: 'parallel', branches: [null, [], [branchStep('a', 'notification', 'Ping')]] })).not.toThrow();
        expect(screen.getByTestId('node-sub').textContent).toBe('empty · empty · Ping — all at the same time');
    });

    it('holds ONE output port — the branches are held, not wired', () => {
        const { container } = renderNode({
            id: 'par_1', type: 'parallel',
            branches: [[branchStep('a', 'notification', 'A')], [branchStep('b', 'notification', 'B')], [branchStep('c', 'notification', 'C')]],
        });
        // Three branches, still one source handle: an edge per branch would
        // invite the user to wire something execParallel never reads.
        expect(container.querySelectorAll('.react-flow__handle-right').length).toBe(1);
        expect(container.querySelectorAll('.react-flow__handle-left').length).toBe(1);
    });

    it('spells out the failure semantics on the count chip, because nothing else on the canvas does', () => {
        renderNode({
            id: 'par_1', type: 'parallel',
            branches: [[branchStep('a', 'notification', 'A')], [branchStep('b', 'notification', 'B')]],
        });
        expect(screen.getByText('⇉ 2 branches').getAttribute('title'))
            .toContain('A branch that fails does not stop the others');
        cleanup();
        renderNode({
            id: 'par_1', type: 'parallel', failOnAnyBranchError: true,
            branches: [[branchStep('a', 'notification', 'A')], [branchStep('b', 'notification', 'B')]],
        });
        expect(screen.getByText('⇉ 2 branches').getAttribute('title'))
            .toContain('If any branch fails, this step fails.');
    });
});

describe('parallelSummary / parallelStepCount', () => {
    it('names up to three branch heads and counts the rest', () => {
        const four = [1, 2, 3, 4].map(n => [branchStep(`s${n}`, 'notification', `B${n}`)]);
        expect(parallelSummary({ branches: four })).toBe('B1 · B2 · B3 · +1 — all at the same time');
    });

    it('treats a missing or malformed branches array as no branches at all', () => {
        expect(parallelSummary({})).toEqual({ muted: 'no branches yet — nothing runs here' });
        expect(parallelSummary({ branches: 'nope' })).toEqual({ muted: 'no branches yet — nothing runs here' });
        expect(parallelBranches({ branches: 'nope' })).toEqual([]);
    });

    it('counts every step across the branches, skipping the shapes that hold nothing', () => {
        expect(parallelStepCount({ branches: [[1, 2], [3], 'nope', null] })).toBe(3);
        expect(parallelStepCount({})).toBe(0);
    });
});
