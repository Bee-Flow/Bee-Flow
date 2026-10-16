import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalFields } from './approvalEditors';
import scopedStorage from '../../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

/**
 * ApprovalFields, section by section, pinned before it is split: what each
 * control writes through `set(key, value)`, which controls exist in which mode
 * (single approver, approver panel, stages), and what the directory feeds.
 * approvalEditors.questions.test.jsx owns the binding-name rules of the
 * question list; this file leaves those alone.
 *
 * `set` is recorded AND applied to a live draft, so a flow (Use approval
 * stages, then Back to one round) can be followed through the real re-render.
 * Network: `authFetch` answering GET /api/automation/approvals/directory.
 */

type Draft = Record<string, unknown>;
interface FakeResponse { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<(url: string, init?: RequestInit) => Promise<FakeResponse>>() }));
vi.mock('../../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../../utils/helpers')>()), API_BASE: '', authFetch,
}));

const DIRECTORY = { members: [{ id: 'u1', name: 'Ada' }, { id: 'u2', name: 'Grace' }], groups: [{ id: 'g1', name: 'Finance' }] };
const ok = (body: unknown): FakeResponse => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

let calls: Array<[string, unknown]>;
const lastSet = (key: string) => calls.filter(([k]) => k === key).at(-1)?.[1];

function Harness({ initial, errorSections }: { initial: Draft; errorSections?: Set<string> }) {
    const [draft, setDraft] = useState<Draft>({ expiresInHours: 168, ...initial });
    const set = (key: string, value: unknown) => { calls.push([key, value]); setDraft((d) => ({ ...d, [key]: value })); };
    return (
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <ApprovalFields draft={draft} set={set} onFocusField={vi.fn()} previewSample={null} errorSections={errorSections} />
        </VariablePickerProvider>
    );
}
async function mount(initial: Draft = {}, errorSections?: Set<string>) {
    render(<Harness initial={initial} errorSections={errorSections} />);
    // The directory feeds every person/group select: wait for it before acting.
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Ada' }).length).toBeGreaterThan(0));
    return userEvent.setup();
}
const select = (name: string) => screen.getByRole('combobox', { name });

beforeEach(() => {
    calls = [];
    authFetch.mockReset();
    authFetch.mockImplementation(async () => ok(DIRECTORY));
    scopedStorage.setCurrentUser('approval-characterisation-user');
    try { localStorage.clear(); } catch { /* jsdom without storage */ }
});

describe('ApprovalFields — the default (single approver) shape', () => {
    it('shows both sections with their defaults and reads the directory once', async () => {
        await mount();
        expect(screen.getByText('What to approve')).toBeInTheDocument();
        expect(screen.getByText('Deadline')).toBeInTheDocument();
        expect(screen.getByLabelText('Approval deadline')).toHaveValue('168');
        expect(select('Who decides')).toHaveValue('');
        expect(select('Reminder delay')).toHaveValue('');
        expect(select('Final sign-off')).toHaveValue('');
        expect(select('Escalate to')).toHaveValue('');
        expect(screen.queryByRole('combobox', { name: 'Escalation delay' })).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Decision rule' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Use approval stages' })).toBeInTheDocument();
        expect(authFetch.mock.calls.filter(([u]) => u === '/api/automation/approvals/directory')).toHaveLength(1);
        expect(within(select('Who decides')).getByRole('option', { name: 'Finance' })).toBeInTheDocument();
        expect(within(select('Who decides')).getByRole('option', { name: 'Me (the owner)' })).toBeInTheDocument();
    });

    it('a directory that cannot be read leaves the owner-only picker, not a broken section', async () => {
        authFetch.mockImplementation(async () => { throw new Error('offline'); });
        render(<Harness initial={{}} />);
        expect(await screen.findByRole('combobox', { name: 'Who decides' })).toBeInTheDocument();
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(within(select('Who decides')).getAllByRole('option')).toHaveLength(1);
    });

    it('writes the prompt and the details through set', async () => {
        const user = await mount();
        await user.type(screen.getByPlaceholderText(/^Send the/), 'Pay?');
        expect(lastSet('prompt')).toBe('Pay?');
        const details = screen.getAllByRole('textbox').find((el) => el.getAttribute('placeholder')?.startsWith('**Client:**'));
        if (!details) throw new Error('details field missing');
        await user.type(details, 'Net 30');
        expect(String(lastSet('details'))).toContain('Net 30');
    });
});

describe('ApprovalFields — deadline, reminder and who decides', () => {
    it('the deadline writes a number; an unlisted stored value is offered as "<n> hours"; non-numbers fall back to 7 days', async () => {
        const user = await mount();
        await user.selectOptions(screen.getByLabelText('Approval deadline'), '0');
        expect(lastSet('expiresInHours')).toBe(0);
        expect(within(screen.getByLabelText('Approval deadline')).getByRole('option', { name: 'No deadline' })).toBeInTheDocument();
    });

    it('offers a stored deadline that is not one of the choices', async () => {
        await mount({ expiresInHours: 100 });
        expect(screen.getByLabelText('Approval deadline')).toHaveValue('100');
        expect(within(screen.getByLabelText('Approval deadline')).getByRole('option', { name: '100 hours' })).toBeInTheDocument();
    });

    it('treats a missing deadline as 7 days', async () => {
        await mount({ expiresInHours: 'soon' });
        expect(screen.getByLabelText('Approval deadline')).toHaveValue('168');
    });

    it('the reminder writes a number, and "No reminder" writes an empty string', async () => {
        const user = await mount();
        await user.selectOptions(select('Reminder delay'), '4');
        expect(lastSet('remindAfterHours')).toBe(4);
        await user.selectOptions(select('Reminder delay'), '');
        expect(lastSet('remindAfterHours')).toBe('');
    });

    it('Who decides encodes a person as { userId } and a group as { groupId }; the owner clears it', async () => {
        const user = await mount();
        await user.selectOptions(select('Who decides'), 'Ada');
        expect(lastSet('assignee')).toEqual({ userId: 'u1' });
        await user.selectOptions(select('Who decides'), 'Finance');
        expect(lastSet('assignee')).toEqual({ groupId: 'g1' });
        await user.selectOptions(select('Who decides'), 'Me (the owner)');
        expect(lastSet('assignee')).toBeNull();
    });

    it('Final sign-off and Escalate to follow the same encoding; escalating defaults the delay to a day and clearing resets both', async () => {
        const user = await mount();
        await user.selectOptions(select('Final sign-off'), 'Grace');
        expect(lastSet('finalApprover')).toEqual({ userId: 'u2' });
        await user.selectOptions(select('Final sign-off'), 'No final sign-off');
        expect(lastSet('finalApprover')).toBeNull();

        await user.selectOptions(select('Escalate to'), 'Finance');
        expect(lastSet('escalateTo')).toEqual({ groupId: 'g1' });
        expect(lastSet('escalateAfterHours')).toBe(24);
        expect(select('Escalation delay')).toHaveValue('24');
        await user.selectOptions(select('Escalation delay'), '72');
        expect(lastSet('escalateAfterHours')).toBe(72);
        await user.selectOptions(select('Escalate to'), 'No escalation');
        expect(lastSet('escalateTo')).toBeNull();
        expect(lastSet('escalateAfterHours')).toBe('');
        expect(screen.queryByRole('combobox', { name: 'Escalation delay' })).toBeNull();
    });
});

describe('ApprovalFields — documents and questions', () => {
    it('documents: add, name, remove; the add button goes away at five', async () => {
        const user = await mount();
        await user.click(screen.getByRole('button', { name: 'Add a document' }));
        expect(lastSet('attachments')).toEqual([{ binding: '', label: '' }]);
        await user.type(screen.getByPlaceholderText('Shown name (optional)'), 'Offer');
        expect(lastSet('attachments')).toEqual([{ binding: '', label: 'Offer' }]);
        await user.click(screen.getByRole('button', { name: 'Remove document' }));
        expect(lastSet('attachments')).toEqual([]);
    });

    it('five documents hide Add a document', async () => {
        await mount({ attachments: Array.from({ length: 5 }, (_, i) => ({ binding: `{{steps.d${i}.output.fileId}}`, label: '' })) });
        expect(screen.queryByRole('button', { name: 'Add a document' })).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Remove document' })).toHaveLength(5);
    });

    it('questions: type, required and remove; a Choice question grows a comma-separated choices box', async () => {
        const user = await mount({ approvalFields: [{ name: 'size', label: 'Size', type: 'text', required: false }] });
        expect(screen.queryByPlaceholderText('Choices, comma-separated')).toBeNull();
        await user.selectOptions(select('Answer type'), 'Choice');
        expect(lastSet('approvalFields')).toEqual([{ name: 'size', label: 'Size', type: 'select', required: false }]);
        await user.type(await screen.findByPlaceholderText('Choices, comma-separated'), 'S, M');
        expect(lastSet('approvalFields')).toEqual([
            { name: 'size', label: 'Size', type: 'select', required: false, options: [{ value: 'S', label: 'S' }, { value: 'M', label: 'M' }] },
        ]);
        await user.click(screen.getByRole('checkbox', { name: 'required' }));
        expect((lastSet('approvalFields') as Array<{ required: boolean }>)[0].required).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Remove question' }));
        expect(lastSet('approvalFields')).toEqual([]);
    });

    it('Add a question mints the first free q<n> and stops offering itself at twenty', async () => {
        const user = await mount({ approvalFields: [{ name: 'q2', label: 'Two', type: 'text', required: false }] });
        await user.click(screen.getByRole('button', { name: 'Add a question' }));
        expect((lastSet('approvalFields') as Array<{ name: string }>).map((q) => q.name)).toEqual(['q2', 'q3']);
    });

    it('twenty questions hide Add a question', async () => {
        await mount({ approvalFields: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, label: `Field ${i}`, type: 'text', required: false })) });
        expect(screen.queryByRole('button', { name: 'Add a question' })).toBeNull();
    });
});

describe('ApprovalFields — approver panel', () => {
    it('+ More approvers turns the single approver into the first seat, plus an empty one', async () => {
        const user = await mount({ assignee: { userId: 'u1' } });
        await user.click(screen.getByRole('button', { name: '+ More approvers' }));
        expect(lastSet('approvers')).toEqual([{ userId: 'u1' }, null]);
        expect(lastSet('assignee')).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Who decides' })).toBeNull();
        expect(select('Approver seat 1')).toHaveValue('u:u1');
        expect(select('Approver seat 2')).toHaveValue('');
        expect(screen.queryByRole('combobox', { name: 'Escalate to' })).toBeNull();
    });

    it('the decision rule needs two real seats; quorum then offers "n of m"', async () => {
        const user = await mount({ approvers: [{ userId: 'u1' }, null] });
        expect(screen.queryByRole('combobox', { name: 'Decision rule' })).toBeNull();
        await user.selectOptions(select('Approver seat 2'), 'Grace');
        expect(lastSet('approvers')).toEqual([{ userId: 'u1' }, { userId: 'u2' }]);
        await user.selectOptions(select('Decision rule'), 'At least N approvals');
        expect(lastSet('rule')).toBe('quorum');
        expect(select('Approvals needed')).toHaveValue('2');
        await user.selectOptions(select('Approvals needed'), '1 of 2');
        expect(lastSet('quorum')).toBe(1);
    });

    it('seats can be removed and added; the last removal leaves an empty panel', async () => {
        const user = await mount({ approvers: [{ userId: 'u1' }] });
        await user.click(screen.getByRole('button', { name: '+ Add approver' }));
        expect(lastSet('approvers')).toEqual([{ userId: 'u1' }, null]);
        await user.click(screen.getByRole('button', { name: 'Remove approver seat 2' }));
        expect(lastSet('approvers')).toEqual([{ userId: 'u1' }]);
    });
});

describe('ApprovalFields — approval stages', () => {
    it('Use approval stages folds the single approver and the final sign-off into a two-stage chain', async () => {
        const user = await mount({ assignee: { userId: 'u1' }, finalApprover: { groupId: 'g1' }, escalateTo: { userId: 'u2' }, escalateAfterHours: 24 });
        await user.click(screen.getByRole('button', { name: 'Use approval stages' }));
        const chain = lastSet('stages') as Array<Record<string, unknown>>;
        expect(chain).toHaveLength(2);
        expect(chain[0]).toMatchObject({ name: '', approvers: [{ userId: 'u1' }], rule: 'all' });
        expect(chain[1]).toMatchObject({ name: 'Final sign-off', approvers: [{ groupId: 'g1' }], rule: 'first' });
        expect(chain[0].key).not.toBe(chain[1].key);
        expect(lastSet('assignee')).toBeNull();
        expect(lastSet('approvers')).toEqual([]);
        expect(lastSet('finalApprover')).toBeNull();
        expect(lastSet('escalateTo')).toBeNull();
        expect(lastSet('escalateAfterHours')).toBe('');
        expect(await screen.findByText('Stage 1 of 2')).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: 'Who decides' })).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Final sign-off' })).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Escalate to' })).toBeNull();
        // The deadline and the reminder still apply to the whole chain.
        expect(screen.getByLabelText('Approval deadline')).toBeInTheDocument();
    });

    it('the chain editor adds, reorders and removes stages, and keeps each stage\'s key', async () => {
        const user = await mount({ stages: [
            { key: 's1', name: 'Lead', description: '', approvers: [{ userId: 'u1' }], rule: 'all' },
            { key: 's2', name: 'Finance', description: '', approvers: [{ groupId: 'g1' }], rule: 'all' },
        ] });
        expect(screen.getByLabelText('Name of stage 1')).toHaveValue('Lead');
        await user.click(screen.getByRole('button', { name: 'Move stage 1 later' }));
        expect((lastSet('stages') as Array<{ key: string }>).map((s) => s.key)).toEqual(['s2', 's1']);
        await user.click(screen.getByRole('button', { name: 'Add stage' }));
        expect((lastSet('stages') as Array<{ key: string }>).map((s) => s.key)).toEqual(['s2', 's1', 's3']);
        await user.click(screen.getByRole('button', { name: 'Remove stage 3' }));
        expect((lastSet('stages') as Array<{ key: string }>).map((s) => s.key)).toEqual(['s2', 's1']);
        expect(screen.getByText(/approvers used across the chain/)).toBeInTheDocument();
        expect(screen.getAllByText('Only ask this stage when…', { exact: false })).toHaveLength(2);
    });

    it('Back to one round of approval hands the first stage back to the single-approver controls', async () => {
        const user = await mount({ stages: [
            { key: 's1', name: 'Lead', description: '', approvers: [{ userId: 'u1' }], rule: 'all' },
            { key: 's2', name: 'Final sign-off', description: '', approvers: [{ groupId: 'g1' }], rule: 'first' },
        ] });
        await user.click(screen.getByRole('button', { name: 'Back to one round of approval' }));
        expect(lastSet('stages')).toEqual([]);
        expect(lastSet('assignee')).toEqual({ userId: 'u1' });
        expect(lastSet('finalApprover')).toEqual({ groupId: 'g1' });
        expect(await screen.findByRole('combobox', { name: 'Who decides' })).toHaveValue('u:u1');
        expect(select('Final sign-off')).toHaveValue('g:g1');
    });

    it('removing the only stage is the same as going back', async () => {
        const user = await mount({ stages: [{ key: 's1', name: '', description: '', approvers: [{ userId: 'u1' }], rule: 'all' }] });
        await user.click(screen.getByRole('button', { name: 'Remove stage 1' }));
        expect(lastSet('stages')).toEqual([]);
        expect(lastSet('assignee')).toEqual({ userId: 'u1' });
    });
});

describe('ApprovalFields — sections', () => {
    it('a section a validation error points at opens even when the user collapsed it', async () => {
        scopedStorage.setItem('collapse.inspector.approval.waiting', '0');
        await mount({}, new Set(['waiting']));
        expect(screen.getByLabelText('Approval deadline')).toBeInTheDocument();
    });
});
