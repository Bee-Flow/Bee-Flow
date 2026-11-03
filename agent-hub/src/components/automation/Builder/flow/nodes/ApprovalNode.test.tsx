import { render, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect, beforeEach } from 'vitest';
import ApprovalNode from './ApprovalNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';
import { branchFromHandle } from '../branchEdges';
import { buildLayout } from '../layout';
import { reconcileRouteEdges } from '../routeEdges';
import { stub } from '@/test/mocks';
import type { StepNodeProps } from './nodeProps';
import type { FlowDefinition, FlowStep } from '../types';

/**
 * An approval's rejected branch on the canvas (D4a): the node draws two
 * ports, "Approved" (the plain way on) and "On rejected"; a line drawn from
 * the second carries `label: 'on_rejected'`, the layout sends each saved edge
 * out of its own port, and the branch does not survive a change of type.
 */
const STEP = { id: 'ap', type: 'approval', label: 'Sign off', prompt: 'Ship it?' };

function renderApproval() {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={stub({
                pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
            })}>
                <ApprovalNode id="ap" data={stub<StepNodeProps['data']>({
                    step: STEP, runStep: null, issues: { errors: [], warnings: [] }, stepLabelById: new Map(),
                })} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

const layoutOf = (def: unknown) => buildLayout(stub<Parameters<typeof buildLayout>[0]>(def), { runByStep: new Map(), issuesByStep: new Map() });

const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [STEP, { id: 'yes', type: 'set' }, { id: 'no', type: 'set' }],
    edges: [
        { from: 'trg', to: 'ap' },
        { from: 'ap', to: 'yes' },
        { from: 'ap', to: 'no', label: 'on_rejected' },
    ],
};

describe('ApprovalNode — the rejected branch', () => {
    beforeEach(() => { cleanup(); });

    it('draws an Approved and an On rejected port', () => {
        const { container, getByText } = renderApproval();
        const ids = [...container.querySelectorAll('.react-flow__handle-right')].map(h => h.getAttribute('data-handleid'));
        expect(ids).toEqual(['approved', 'on_rejected']);
        expect(getByText('Approved')).toBeTruthy();
        expect(getByText('On rejected')).toBeTruthy();
    });

    it('a line from the rejected port is an on_rejected edge; from the approved port a plain one', () => {
        expect(branchFromHandle('on_rejected')).toEqual({ label: 'on_rejected' });
        expect(branchFromHandle('approved')).toEqual({});
    });

    it('the layout sends each saved edge out of its own port, named there', () => {
        const edges = layoutOf(DEF).edges;
        const yes = edges.find(e => e.target === 'yes')!;
        const no = edges.find(e => e.target === 'no')!;
        expect(yes.sourceHandle).toBe('approved');
        expect(yes.data.kind).toBeNull();
        expect(no.sourceHandle).toBe('on_rejected');
        expect(no.data.kind).toBe('on_rejected');
        expect(no.data.labelledAtPort).toBe(true);
    });

    it('a plain approval still connects from its Approved port', () => {
        const def = { ...DEF, edges: DEF.edges.slice(0, 2) };
        expect(layoutOf(def).edges.find(e => e.target === 'yes')!.sourceHandle).toBe('approved');
    });

    it('the rejected branch goes with the type: it is dropped when the step stops being an approval', () => {
        const swapped = { ...STEP, type: 'notification' };
        const def = stub<FlowDefinition>({ ...DEF, steps: [swapped, ...DEF.steps.slice(1)] });
        const next = reconcileRouteEdges(def, 'ap', stub<FlowStep>(STEP), stub<FlowStep>(swapped));
        expect(next.edges?.some(e => e.label === 'on_rejected')).toBe(false);
        expect(next.edges?.some(e => e.from === 'ap' && e.to === 'yes')).toBe(true);
    });
});
