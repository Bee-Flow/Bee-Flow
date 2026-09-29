import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import EntitlementsContext from '../../../../licensing/EntitlementsContext';
import TokenizeNode from './TokenizeNode';
import GuardNode from './GuardNode';
import UntokenizeNode from './UntokenizeNode';
import ApprovalNode from './ApprovalNode';

/**
 * A step the plan does not include, already on the canvas, carries a lock
 * chip (flow/planLockModel.ts). A chip and not a disabled card: the step may
 * be live and running, which it keeps doing after a lapse. "Show real values
 * again" never carries one, and nothing is locked before the plan is known.
 */

type Ent = { loading: boolean; error?: unknown; lockReason: (id: string) => string | null };
const plan = (locked: Record<string, string>): Ent => ({
    loading: false, error: null, lockReason: (id) => locked[id] ?? null,
});

function renderNode(Node: React.ComponentType<{ id: string; data: unknown }>, step: Record<string, unknown>, ent: Ent) {
    return render(
        <ReactFlowProvider>
            <EntitlementsContext.Provider value={ent as never}>
                <Node id={String(step.id)} data={{ step, issues: { errors: [], warnings: [] } }} />
            </EntitlementsContext.Provider>
        </ReactFlowProvider>,
    );
}

const tokenize = { id: 'tok1', type: 'tokenize', sourceRef: 'trigger.output.text' };
const guard = { id: 'g1', type: 'guard', sourceRef: 'trigger.output.text' };
const untokenize = { id: 'u1', type: 'untokenize', sourceRef: 'steps.tok1.output.text' };
const approval = { id: 'ap1', type: 'approval', prompt: 'OK?' };

describe('PlanLockChip on the canvas', () => {
    beforeEach(cleanup);

    it('Hide personal data carries the lock, with the plan\'s sentence as its tip', () => {
        renderNode(TokenizeNode, tokenize, plan({ automation_privacy_steps: 'ceiling' }));
        const chip = screen.getByText('Enterprise');
        expect(chip.closest('[title]')?.getAttribute('title')).toMatch(/part of the Enterprise plan/);
    });

    it('so does a check, and an approval without approvals', () => {
        renderNode(GuardNode, guard, plan({ automation_privacy_steps: 'ceiling' }));
        expect(screen.getByText('Enterprise')).toBeTruthy();
        cleanup();
        renderNode(ApprovalNode, approval, plan({ approvals: 'not_granted' }));
        expect(screen.getByText('Enterprise').closest('[title]')?.getAttribute('title')).toMatch(/administrator/);
    });

    it('Show real values again never carries it', () => {
        renderNode(UntokenizeNode, untokenize, plan({ automation_privacy_steps: 'ceiling' }));
        expect(screen.queryByText('Enterprise')).toBeNull();
    });

    it('no lock when the plan includes the step, or while the plan is not known', () => {
        renderNode(TokenizeNode, tokenize, plan({}));
        expect(screen.queryByText('Enterprise')).toBeNull();
        cleanup();
        renderNode(TokenizeNode, tokenize, { ...plan({ automation_privacy_steps: 'ceiling' }), loading: true });
        expect(screen.queryByText('Enterprise')).toBeNull();
        cleanup();
        renderNode(TokenizeNode, tokenize, { ...plan({ automation_privacy_steps: 'ceiling' }), error: 'HTTP 500' });
        expect(screen.queryByText('Enterprise')).toBeNull();
    });
});
