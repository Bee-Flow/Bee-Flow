// The plan of a Cowork item as a card: its steps with their kind, what it may do, where it stands, and the two
// things its owner can do. Everything comes in as props, so nothing is mocked.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CoworkPlanCard from './CoworkPlanCard';
import { englishT as t, planState, supplierRadarDraft } from './coworkPlan.fixture';
import type { PlanState } from '@/api/coworkPlan.types';

function renderCard(state: PlanState, props: Partial<Parameters<typeof CoworkPlanCard>[0]> = {}) {
    const onApprove = vi.fn();
    const onRemove = vi.fn();
    render(<CoworkPlanCard state={state} t={t} onApprove={onApprove} onRemove={onRemove} {...props} />);
    return { onApprove, onRemove };
}

const approvedState = (over: Partial<PlanState> = {}): PlanState => {
    const draft = supplierRadarDraft();
    return planState({ approved: { version: 2, fingerprint: draft.fingerprint, approvedAt: '2026-11-23T09:14:00.000Z', permissions: draft.permissions }, widens: [], upToDate: true, ...over });
};

describe('CoworkPlanCard', () => {
    it('shows nothing for an item without a plan', () => {
        renderCard(planState({ automationId: null, draft: null }));
        expect(screen.queryByTestId('cowork-plan')).toBeNull();
    });

    it('lists every step in order with the kind of work it is', () => {
        renderCard(planState());
        const rows = screen.getAllByRole('listitem').filter((li) => li.getAttribute('data-testid')?.startsWith('cowork-plan-step-'));
        expect(rows.map((li) => li.getAttribute('data-testid'))).toEqual([
            'cowork-plan-step-mail', 'cowork-plan-step-orders', 'cowork-plan-step-overdue', 'cowork-plan-step-table',
            'cowork-plan-step-reply', 'cowork-plan-step-draft', 'cowork-plan-step-digest',
        ]);
        expect(within(screen.getByTestId('cowork-plan-step-mail')).getByText('Fixed')).toBeTruthy();
        expect(within(screen.getByTestId('cowork-plan-step-orders')).getByText('AI')).toBeTruthy();
        expect(within(screen.getByTestId('cowork-plan-step-digest')).getByText('Result')).toBeTruthy();
    });

    it('says in words how much of the work is fixed and how much is AI', () => {
        renderCard(planState());
        expect(screen.getByTestId('cowork-plan-makeup').textContent).toContain('4 fixed, 2 AI, 1 result for you');
    });

    it('marks the AI steps that read outside text, and only those', () => {
        renderCard(planState());
        expect(within(screen.getByTestId('cowork-plan-step-orders')).getByText('Reads outside text')).toBeTruthy();
        expect(within(screen.getByTestId('cowork-plan-step-reply')).getByText('Reads outside text')).toBeTruthy();
        expect(within(screen.getByTestId('cowork-plan-step-mail')).queryByText('Reads outside text')).toBeNull();
        expect(screen.getAllByText('Reads outside text')).toHaveLength(2);
    });

    it('says what the plan may read and change, and that a result goes only to its owner', () => {
        renderCard(planState());
        expect(screen.getByTestId('cowork-plan-may-reads').textContent).toContain('Outlook');
        expect(screen.getByTestId('cowork-plan-may-writes').textContent).toContain('Datatables');
        expect(screen.getByTestId('cowork-plan-may-writes').textContent).toContain('Outlook');
        expect(screen.getByTestId('cowork-plan-may-sends').textContent).toContain('Only to you');
    });

    it('a plan that sends through an app says to whom it can go', () => {
        const draft = supplierRadarDraft();
        draft.permissions = { ...draft.permissions, sends: 'others', grants: [...draft.permissions.grants, { app: 'outlook', effect: 'sends', tools: ['outlook_compose'] }] };
        renderCard(planState({ draft }));
        const sends = screen.getByTestId('cowork-plan-may-sends').textContent;
        expect(sends).toContain('Outlook');
        expect(sends).toContain('To other people');
    });

    it('a plan that was never approved can be approved, with the fingerprint that is on screen', async () => {
        const { onApprove } = renderCard(planState());
        expect(screen.getByTestId('cowork-plan-status').textContent).toContain('Not approved yet');
        await userEvent.setup().click(screen.getByTestId('cowork-plan-approve'));
        expect(onApprove).toHaveBeenCalledExactlyOnceWith('f'.repeat(64));
    });

    it('the approved plan says so with its version, and offers nothing to approve', () => {
        renderCard(approvedState());
        expect(screen.getByTestId('cowork-plan').getAttribute('data-status')).toBe('approved');
        expect(screen.getByTestId('cowork-plan-status').textContent).toContain('Approved, version 2');
        expect(screen.queryByTestId('cowork-plan-approve')).toBeNull();
    });

    it('a changed plan says runs still follow the approved version, and names what is new', () => {
        renderCard(approvedState({ upToDate: false, widens: ['outlook: sends (outlook_compose)', 'It can now send to other people.'] }));
        expect(screen.getByTestId('cowork-plan-status').textContent).toContain('Runs still follow version 2');
        expect(screen.getByText('New compared with what you approved')).toBeTruthy();
        expect(screen.getByText('It can now send to other people.')).toBeTruthy();
        expect(screen.getByTestId('cowork-plan-approve')).toBeTruthy();
    });

    it('a changed plan marks which steps are new or changed, and names the ones taken out', () => {
        renderCard(approvedState({
            upToDate: false,
            approved: { version: 2, fingerprint: 'older', approvedAt: null, permissions: supplierRadarDraft().permissions },
            stepChanges: [
                { id: 'table', title: 'Update the Open orders table', kind: 'fixed', change: 'changed' },
                { id: 'draft', title: 'Save the replies as drafts', kind: 'fixed', change: 'added' },
                { id: 'old', title: 'Ring the bell', kind: 'fixed', change: 'removed' },
            ],
        }));
        expect(within(screen.getByTestId('cowork-plan-step-table')).getByTestId('cowork-plan-step-change')).toHaveTextContent('Changed');
        expect(within(screen.getByTestId('cowork-plan-step-draft')).getByTestId('cowork-plan-step-change')).toHaveTextContent('New');
        expect(within(screen.getByTestId('cowork-plan-step-mail')).queryByTestId('cowork-plan-step-change')).toBeNull();
        expect(screen.getByTestId('cowork-plan-steps-removed')).toHaveTextContent('Taken out since you approved it: Ring the bell');
    });

    it('an approved plan that is up to date marks no step', () => {
        renderCard(approvedState({ stepChanges: [{ id: 'table', title: 'Update the Open orders table', kind: 'fixed', change: 'changed' }] }));
        expect(screen.queryByTestId('cowork-plan-step-change')).toBeNull();
    });

    it('a plan that may not run says why, and cannot be approved', () => {
        const draft = { ...supplierRadarDraft(), findings: [{ code: 'step.not_allowed', stepId: 'c', message: 'A plan cannot run a script yet: scripts arrive with the sandbox that runs outside the server process.' }] };
        renderCard(planState({ draft }));
        expect(screen.getByTestId('cowork-plan').getAttribute('data-status')).toBe('blocked');
        expect(screen.getByText('Why it cannot run')).toBeTruthy();
        expect(screen.getByText(/cannot run a script yet/)).toBeTruthy();
        expect(screen.queryByTestId('cowork-plan-approve')).toBeNull();
    });

    it('an automation that is gone leaves only the way to take the plan off', async () => {
        const { onRemove } = renderCard(planState({ draft: null }));
        expect(screen.getByTestId('cowork-plan-status').textContent).toContain('is gone');
        expect(screen.queryByTestId('cowork-plan-approve')).toBeNull();
        await userEvent.setup().click(screen.getByTestId('cowork-plan-remove'));
        expect(onRemove).toHaveBeenCalledOnce();
    });

    it('shows the try-out it is given between the plan and what its owner can do with it', () => {
        renderCard(planState(), { tryOut: <div data-testid="the-try-out">Try it first</div> });
        const card = screen.getByTestId('cowork-plan');
        const order = [...card.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'));
        expect(order.indexOf('the-try-out')).toBeGreaterThan(order.indexOf('cowork-plan-may-sends'));
        expect(order.indexOf('the-try-out')).toBeLessThan(order.indexOf('cowork-plan-approve'));
    });

    it('a change that cannot be approved says so, keeps saying runs follow the approved version, and offers no approval', () => {
        const draft = supplierRadarDraft();
        renderCard(approvedState({ upToDate: false, approved: { version: 2, fingerprint: 'older', approvedAt: null, permissions: draft.permissions }, draft: { ...draft, findings: [{ code: 'step.not_allowed', stepId: 'c', message: 'A plan cannot run a script yet.' }] } }));
        expect(screen.getByTestId('cowork-plan-status').textContent).toContain('Runs still follow version 2');
        expect(screen.getByText('Why this change cannot be approved')).toBeTruthy();
        expect(screen.queryByTestId('cowork-plan-approve')).toBeNull();
    });

    it('shows what the planner said about the plan it made, as plain text', () => {
        renderCard(planState(), { note: 'Each run reads the supplier mail and tells you. **It could not** reach the ERP: <b>not connected</b>.' });
        const note = screen.getByTestId('cowork-plan-note');
        expect(note.textContent).toBe('Cowork: Each run reads the supplier mail and tells you. **It could not** reach the ERP: <b>not connected</b>.');
        expect(note.querySelector('b')).toBeNull();
    });

    it('has no note for a plan that was not just made', () => {
        renderCard(planState());
        expect(screen.queryByTestId('cowork-plan-note')).toBeNull();
    });

    it('shows the sentence of a refused request, and holds both buttons while a request is on its way', () => {
        renderCard(planState(), { error: 'The plan changed since you looked at it. Look at it again, then approve it.', busy: 'approve' });
        expect(screen.getByRole('alert').textContent).toContain('changed since you looked');
        expect((screen.getByTestId('cowork-plan-approve') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('cowork-plan-remove') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('cowork-plan-approve').textContent).toBe('Approving…');
    });
});

describe('CoworkPlanCard, a plan Cowork made and tried', () => {
    const tried = { status: 'passed' as const, current: true, required: true, blocksApproval: false, rounds: 1, problems: [], summary: { reads: [{ title: 'Get the new supplier mail', items: 4 }], ai: 2, held: 2 } };

    it('arrives with its try-out in plain words, and can be approved', () => {
        renderCard(planState({ tried }));
        expect(screen.getByTestId('cowork-plan-tried')).toHaveTextContent("Tried once: 'Get the new supplier mail' read 4 items, 2 AI steps wrote their answers. Nothing was changed or sent.");
        expect(screen.getByTestId('cowork-plan-approve')).toBeTruthy();
    });

    it('a try-out that still fails says what fails, and there is no Approve', () => {
        renderCard(planState({ tried: { ...tried, status: 'failed', blocksApproval: true, rounds: 3, problems: ["'Save the replies as drafts' failed (tool_error)."] } }));
        expect(screen.getByTestId('cowork-plan-tried')).toHaveTextContent("Tried, and it does not work yet. It cannot be approved until a try-out passes:'Save the replies as drafts' failed (tool_error).");
        expect(screen.queryByTestId('cowork-plan-approve')).toBeNull();
    });
});

describe('CoworkPlanCard, a plan that cannot run because of its wiring', () => {
    const FINDING = "'Notification' reads from 'AI step', but does not wait for it. Let it wait for 'AI step'.";
    const blocked = () => {
        const draft = supplierRadarDraft();
        return planState({ draft: { ...draft, findings: [{ code: 'wiring.ref_not_upstream', stepId: 'digest', message: FINDING }] }, tried: { status: 'untried', current: true, required: true, blocksApproval: true, rounds: 0, problems: [FINDING], summary: null } });
    };

    it('says why once: the try-out line is just "Not tried yet." above the box that says why it cannot run', () => {
        renderCard(blocked());
        expect(screen.getByTestId('cowork-plan-tried').textContent).toBe('Not tried yet.');
        expect(screen.getAllByText(FINDING)).toHaveLength(1);
        expect(screen.getByText('Why it cannot run')).toBeTruthy();
    });

    it('shows Cowork\'s fix of the wiring where it is handed in', () => {
        renderCard(blocked(), { wiringFix: <p data-testid="fix-slot">Fixed.</p> });
        expect(screen.getByTestId('fix-slot')).toBeTruthy();
    });
});

describe('CoworkPlanCard, step titles', () => {
    it('a step titled with its tool name reads as words; a display label stays as it is', () => {
        const draft = supplierRadarDraft();
        const steps = draft.view.steps.map((s) => (s.id === 'mail' ? { ...s, title: 'fireflies_list_transcripts' } : s.id === 'draft' ? { ...s, title: 'Fireflies: get summary' } : s));
        renderCard(planState({ draft: { ...draft, view: { ...draft.view, steps } } }));
        expect(screen.getByTestId('cowork-plan-step-mail')).toHaveTextContent('Fireflies list transcripts');
        expect(screen.getByTestId('cowork-plan-step-mail').textContent).not.toContain('fireflies_list_transcripts');
        expect(screen.getByTestId('cowork-plan-step-draft')).toHaveTextContent('Fireflies: get summary');
    });
});
