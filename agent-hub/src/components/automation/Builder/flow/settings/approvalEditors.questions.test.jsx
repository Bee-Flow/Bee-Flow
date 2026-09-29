import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { approvalQuestionName } from './approvalEditors';
import scopedStorage from '../../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

/**
 * "Questions for the approver" — the declared fields an approval collects
 * alongside the yes/no, so a routine can pause and ask a colleague for the
 * missing invoice number and then carry on with what they typed.
 *
 * Everything these tests circle is the BINDING NAME. A question has two names:
 * the label the approver reads, and `name`, which is how a later step reads the
 * answer back (steps.<id>.output.answers.<name>). The label may be reworded
 * whenever; the name may not, because rewording it renames the binding and
 * NOTHING FAILS — the approver is still asked, still answers, and the answer is
 * still recorded against the snapshot the decision was made on; only the step
 * that needed it quietly receives nothing. That is the same invariant the form
 * builder states in its header (FormBuilderFields idea 3) and the same one
 * flow/renameFormField.js exists to protect.
 *
 * The second thing pinned here is that the mint is always a LEGAL identifier.
 * The server's PARAM_NAME_RE wants a letter first, and normalizeFields drops a
 * field whose name it cannot accept — a question the approver is never shown
 * is the worst possible shape for this feature.
 */

vi.mock('../../../../../hooks/useAutomationApi', () => ({
    default: () => ({
        approvalDirectory: async () => ({ members: [{ id: 'u1', name: 'Ada' }], groups: [] }),
    }),
}));

const { default: SettingsForm } = await import('../SettingsForm');

const noIssues = { errors: [], warnings: [] };

function renderForm(approval = {}) {
    const onPatch = vi.fn();
    const step = {
        id: 'appr_1', type: 'approval', prompt: 'Pay this invoice?',
        approval: { expiresInHours: 168, ...approval },
    };
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} catalog={null} groups={[]} />
        </VariablePickerProvider>,
    );
    return { onPatch, ...utils };
}

/** The last patch the form autosaved. */
async function lastPatch(onPatch) {
    await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 3000 });
    return onPatch.mock.calls.at(-1)[0];
}

const question = (over = {}) => ({ name: 'invoice_number', label: 'Invoice number', type: 'text', required: false, ...over });

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    scopedStorage.setCurrentUser('approval-questions-test-user');
    try { localStorage.clear(); } catch { /* jsdom without storage */ }
});

describe('approvalQuestionName — minted once, never re-derived', () => {
    it('mints from the label while the name is still the placeholder', () => {
        expect(approvalQuestionName({ name: 'q1', label: 'Invoice number' }, 0, [])).toBe('invoice_number');
    });

    it('leaves a name that is already in play alone, however the label is reworded', () => {
        // The failure this is here for: a later step binds
        // output.answers.invoice_number, the author tightens the wording, and
        // the binding silently starts resolving to nothing.
        const q = { name: 'invoice_number', label: 'Invoice number (from the PO)' };
        expect(approvalQuestionName(q, 0, [q])).toBe('invoice_number');
    });

    it('always mints a name the server will accept, even from a label that starts with a digit', () => {
        // PARAM_NAME_RE is /^[A-Za-z][A-Za-z0-9_]{0,59}$/ — "2nd_signature"
        // is refused at save, and skipped outright by normalizeFields, so the
        // approver would never be shown the question.
        const minted = approvalQuestionName({ name: 'q1', label: '2nd signature' }, 0, []);
        expect(minted).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,59}$/);
    });

    it('de-duplicates against the other questions instead of minting a clash', () => {
        const list = [{ name: 'amount', label: 'Amount' }, { name: 'q2', label: 'Amount' }];
        expect(approvalQuestionName(list[1], 1, list)).toBe('amount_2');
    });

    it('keeps the placeholder while the question has no label yet', () => {
        expect(approvalQuestionName({ name: 'q2', label: '   ' }, 1, [])).toBe('q2');
    });
});

describe('the approval question list, in the builder', () => {
    it('mints the binding name when the author leaves the label box', async () => {
        const { onPatch } = renderForm();
        fireEvent.click(await screen.findByText('Add a question'));
        const label = await screen.findByPlaceholderText('Question label');
        fireEvent.change(label, { target: { value: 'Invoice number' } });
        fireEvent.blur(label);
        const patch = await lastPatch(onPatch);
        expect(patch.approval.fields).toEqual([
            { name: 'invoice_number', label: 'Invoice number', type: 'text', required: false },
        ]);
    });

    it('rewording the label does NOT rename the binding a later step is using', async () => {
        const { onPatch } = renderForm({ fields: [question()] });
        const label = await screen.findByDisplayValue('Invoice number');
        fireEvent.change(label, { target: { value: 'Invoice number (from the PO)' } });
        fireEvent.blur(label);
        const patch = await lastPatch(onPatch);
        expect(patch.approval.fields[0].label).toBe('Invoice number (from the PO)');
        // The whole point. Before this was fixed the name followed the label
        // to `invoice_number_from_the_po`, and every
        // {{steps.appr_1.output.answers.invoice_number}} downstream went blank
        // without a single error anywhere.
        expect(patch.approval.fields[0].name).toBe('invoice_number');
    });

    it('never stores a name the server would refuse, whatever the label starts with', async () => {
        const { onPatch } = renderForm();
        fireEvent.click(await screen.findByText('Add a question'));
        const label = await screen.findByPlaceholderText('Question label');
        fireEvent.change(label, { target: { value: '2nd signature' } });
        fireEvent.blur(label);
        const patch = await lastPatch(onPatch);
        // Before this was fixed the slug was "2nd_signature": save-time
        // validation refused it (field_name), naming a string the author never
        // typed and had no box to correct.
        expect(patch.approval.fields[0].name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,59}$/);
    });

    it('shows the author what to bind, so the slug is not something to guess at', async () => {
        renderForm({ fields: [question()] });
        expect(await screen.findByText('output.answers.invoice_number')).toBeInTheDocument();
    });

    it('never prints a binding the stored definition does not have', async () => {
        // The name is minted when the label box is LEFT, so between the first
        // keystroke and that blur the stored name is still the placeholder —
        // and the debounce saves in that window. Printing the slug the author
        // is ABOUT to get would tell them to bind output.answers.invoice_number
        // while the definition still says q1, and a routine that closes on
        // Escape never fires the blur that would have made it true. A later
        // step wired from that line receives nothing, with no error anywhere:
        // the same silent drop the mint rules exist to prevent, reached
        // through the hint instead of through a rename.
        const { onPatch } = renderForm({ fields: [{ name: 'q1', label: '', type: 'text', required: false }] });
        const label = await screen.findByPlaceholderText('Question label');
        fireEvent.change(label, { target: { value: 'Invoice number' } });
        const stored = (await lastPatch(onPatch)).approval.fields[0].name;
        expect(await screen.findByText(`output.answers.${stored}`)).toBeInTheDocument();
    });

    it('a yes/no approval still stores no fields at all', async () => {
        // The byte-identical half of the contract: an approval nobody added a
        // question to must keep exactly the shape it has always had.
        const { onPatch } = renderForm();
        fireEvent.change(await screen.findByLabelText('Approval deadline'), { target: { value: '24' } });
        const patch = await lastPatch(onPatch);
        expect(patch.approval).toEqual({ expiresInHours: 24 });
    });
});
