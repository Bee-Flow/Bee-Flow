import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import { extractFormState, buildPatch, sanitizeApprovalStages, newStageKey } from './settings/formState';
import scopedStorage from '../../../../utils/scopedStorage';

/**
 * Sequential approval stages, in the builder.
 *
 * The invariant every test here circles is the stage KEY: already-cast votes
 * are filed under it, so a stage that has run must keep the key it ran with
 * through a rename, through a reorder, and through a new stage being inserted
 * above it. Positional keys would break all three — silently, months later,
 * in the audit trail of an approval nobody is looking at any more.
 *
 * The second invariant is the MODE: stages supersede the assignee, the panel,
 * the final sign-off and the escalation. validate.js refuses the combination
 * outright (approval.stages_conflict) rather than let someone believe they
 * are in the chain and never be asked, so the editor must never emit both.
 */

vi.mock('../../../../hooks/useAutomationApi', () => ({
    default: () => ({
        approvalDirectory: async () => ({
            members: [{ id: 'u1', name: 'Ada' }, { id: 'u2', name: 'Bo' }, { id: 'u3', name: 'Cy' }],
            groups: [{ id: 'g1', name: 'Finance' }],
        }),
    }),
}));

const { default: SettingsForm } = await import('./SettingsForm');

const noIssues = { errors: [], warnings: [] };

function renderForm(step) {
    const onPatch = vi.fn();
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} catalog={null} groups={[]} />
        </VariablePickerProvider>,
    );
    return { onPatch, ...utils };
}

const approvalStep = (approval = {}) => ({
    id: 'appr_1', type: 'approval', prompt: 'Sign the contract?', approval: { expiresInHours: 168, ...approval },
});

const CHAIN = [
    { key: 's1', name: 'Team lead', approvers: [{ userId: 'u1' }], rule: 'all' },
    { key: 's2', name: 'Finance', approvers: [{ groupId: 'g1' }], rule: 'all' },
];

/** The last patch the form autosaved. */
async function lastPatch(onPatch) {
    await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 3000 });
    return onPatch.mock.calls.at(-1)[0];
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    scopedStorage.setCurrentUser('approval-stages-test-user');
    try { localStorage.clear(); } catch { /* jsdom without storage */ }
});

describe('approval stages — the chain editor', () => {
    it('opens a staged step on its chain, numbered', async () => {
        renderForm(approvalStep({ stages: CHAIN }));
        expect(await screen.findByLabelText('Name of stage 1')).toHaveValue('Team lead');
        expect(screen.getByLabelText('Name of stage 2')).toHaveValue('Finance');
        expect(screen.getByText('Stage 1 of 2')).toBeInTheDocument();
        expect(screen.getByText('Stage 2 of 2')).toBeInTheDocument();
    });

    it('hides the single-approver, panel and final sign-off controls while stages are on', async () => {
        renderForm(approvalStep({ stages: CHAIN }));
        await screen.findByDisplayValue('Team lead');
        // Not merely disabled — absent. They are a different mode, and the
        // server errors on the combination.
        expect(screen.queryByLabelText('Who decides')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Final sign-off')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Escalate to')).not.toBeInTheDocument();
    });

    it('shows the whole-chain seat budget rather than letting the author hit a server error', async () => {
        renderForm(approvalStep({ stages: CHAIN }));
        expect(await screen.findByText('2 of 30 approvers used across the chain')).toBeInTheDocument();
    });

    it('renaming a stage keeps its key — the votes already cast stay attached', async () => {
        const { onPatch } = renderForm(approvalStep({ stages: CHAIN }));
        const nameBox = await screen.findByDisplayValue('Team lead');
        fireEvent.change(nameBox, { target: { value: 'Squad lead' } });
        const patch = await lastPatch(onPatch);
        expect(patch.approval.stages.map(s => s.key)).toEqual(['s1', 's2']);
        expect(patch.approval.stages[0].name).toBe('Squad lead');
    });

    it('reordering moves the stage, not the key', async () => {
        const { onPatch } = renderForm(approvalStep({ stages: CHAIN }));
        await screen.findByDisplayValue('Team lead');
        fireEvent.click(screen.getByLabelText('Move stage 2 earlier'));
        const patch = await lastPatch(onPatch);
        // Finance is first now, and it is STILL s2. A positional key would
        // have renamed it to s1 and orphaned every vote filed under s2.
        expect(patch.approval.stages.map(s => s.key)).toEqual(['s2', 's1']);
        expect(patch.approval.stages.map(s => s.name)).toEqual(['Finance', 'Team lead']);
    });

    it('a new stage takes a key nobody in the chain is using', async () => {
        const { onPatch } = renderForm(approvalStep({ stages: CHAIN }));
        await screen.findByDisplayValue('Team lead');
        fireEvent.click(screen.getByRole('button', { name: /Add stage/ }));
        // The new row has no approver yet, so nothing is persisted until one
        // is picked — pick one, then read the chain back.
        fireEvent.change(await screen.findByLabelText('Stage 3, approver 1'), { target: { value: 'u:u2' } });
        const patch = await lastPatch(onPatch);
        const keys = patch.approval.stages.map(s => s.key);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size).toBe(3);
        expect(keys.slice(0, 2)).toEqual(['s1', 's2']);
    });

    it('caps the chain at five stages', async () => {
        renderForm(approvalStep({
            stages: [1, 2, 3, 4, 5].map(n => ({
                key: `s${n}`, name: `Stage ${n}`, approvers: [{ userId: 'u1' }], rule: 'all',
            })),
        }));
        await screen.findByDisplayValue('Stage 1');
        expect(screen.queryByRole('button', { name: /Add stage/ })).not.toBeInTheDocument();
    });

    it('says out loud that a stage with nobody in it is not saved', async () => {
        renderForm(approvalStep({ stages: CHAIN }));
        await screen.findByDisplayValue('Team lead');
        fireEvent.click(screen.getByRole('button', { name: /Add stage/ }));
        expect(await screen.findByText(/Pick at least one approver/)).toBeInTheDocument();
    });

    it('switching to stages carries the panel over and clears every legacy field', async () => {
        const { onPatch } = renderForm(approvalStep({
            approvers: [{ userId: 'u1' }, { userId: 'u2' }], rule: 'quorum', quorum: 2,
            finalApprover: { groupId: 'g1' },
        }));
        fireEvent.click(await screen.findByRole('button', { name: /Use approval stages/ }));
        const patch = await lastPatch(onPatch);
        expect(patch.approval.stages).toHaveLength(2);
        expect(patch.approval.stages[0].approvers).toEqual([{ userId: 'u1' }, { userId: 'u2' }]);
        expect(patch.approval.stages[0].rule).toBe('quorum');
        expect(patch.approval.stages[1].approvers).toEqual([{ groupId: 'g1' }]);
        // The conflict the server refuses.
        expect(patch.approval.approvers).toBeUndefined();
        expect(patch.approval.assignee).toBeUndefined();
        expect(patch.approval.finalApprover).toBeUndefined();
        expect(patch.approval.escalateTo).toBeUndefined();
    });

    it('switching back keeps what the simple shape can still express', async () => {
        const { onPatch } = renderForm(approvalStep({ stages: CHAIN }));
        await screen.findByDisplayValue('Team lead');
        fireEvent.click(screen.getByRole('button', { name: /Back to one round of approval/ }));
        const patch = await lastPatch(onPatch);
        expect(patch.approval.stages).toBeUndefined();
        expect(patch.approval.assignee).toEqual({ userId: 'u1' });
        expect(patch.approval.finalApprover).toEqual({ groupId: 'g1' });
    });

    it('an optional condition is opt-in, and reads as a skip when it is not met', async () => {
        renderForm(approvalStep({ stages: CHAIN }));
        await screen.findByDisplayValue('Team lead');
        const openers = screen.getAllByRole('button', { name: /Only ask this stage when/ });
        expect(openers).toHaveLength(2);
        fireEvent.click(openers[0]);
        expect(await screen.findByText(/A stage whose condition is not met is skipped/)).toBeInTheDocument();
    });

    it('a stage with two or more approvers gets its own decision rule', async () => {
        renderForm(approvalStep({
            stages: [{ key: 's1', name: 'Panel', approvers: [{ userId: 'u1' }, { userId: 'u2' }], rule: 'quorum', quorum: 2 }],
        }));
        const rule = await screen.findByLabelText('Decision rule for stage 1');
        expect(rule).toHaveValue('quorum');
        expect(within(screen.getByLabelText('Approvals needed in stage 1')).getByText('2 of 2')).toBeInTheDocument();
    });
});

describe('approval stages — the persisted shape', () => {
    it('round-trips a stored chain without touching it', () => {
        const step = approvalStep({ stages: CHAIN });
        const draft = extractFormState(step);
        expect(draft.stages).toEqual(CHAIN);
        expect(buildPatch(step, draft).approval).toBeUndefined();   // nothing changed
    });

    it('drops a stage nobody sits in rather than 400 the whole routine', () => {
        expect(sanitizeApprovalStages([
            { key: 's1', name: 'Team lead', approvers: [{ userId: 'u1' }], rule: 'all' },
            { key: 's2', name: 'Nobody', approvers: [null, {}], rule: 'all' },
        ]).map(s => s.key)).toEqual(['s1']);
    });

    it('honours an author key verbatim, and only replaces a collision', () => {
        const out = sanitizeApprovalStages([
            { key: 'panel', approvers: [{ userId: 'u1' }] },
            { key: 'panel', approvers: [{ userId: 'u2' }] },
        ]);
        expect(out[0].key).toBe('panel');
        expect(out[1].key).not.toBe('panel');
    });

    it('caps a stage at 10 seats and the chain at 30', () => {
        const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ userId: `${prefix}${i}` }));
        expect(sanitizeApprovalStages([{ approvers: many(14, 'a') }])[0].approvers).toHaveLength(10);
        const full = sanitizeApprovalStages([
            { approvers: many(10, 'a') }, { approvers: many(10, 'b') },
            { approvers: many(10, 'c') }, { approvers: many(10, 'd') },
        ]);
        expect(full).toHaveLength(3);
        expect(full.reduce((n, s) => n + s.approvers.length, 0)).toBe(30);
    });

    it('trims the name and description to the lengths the server stores', () => {
        const [stage] = sanitizeApprovalStages([{
            approvers: [{ userId: 'u1' }], name: 'x'.repeat(90), description: 'y'.repeat(300),
        }]);
        expect(stage.name).toHaveLength(60);
        expect(stage.description).toHaveLength(200);
    });

    it('keeps a quorum inside its own stage, never the chain', () => {
        const [stage] = sanitizeApprovalStages([{
            approvers: [{ userId: 'u1' }, { userId: 'u2' }], rule: 'quorum', quorum: 9,
        }]);
        expect(stage.quorum).toBe(2);
    });

    it('mints the lowest unused key so an insert never steals a running stage\'s', () => {
        expect(newStageKey([])).toBe('s1');
        expect(newStageKey([{ key: 's1' }, { key: 's3' }])).toBe('s2');
        expect(newStageKey([{ key: 'panel' }, { key: 'final' }])).toBe('s1');
    });
});
