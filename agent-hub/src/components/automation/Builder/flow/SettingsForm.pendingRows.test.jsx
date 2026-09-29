import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import { carryPendingRows, buildPatch } from './settings/formState';
import scopedStorage from '../../../../utils/scopedStorage';

/**
 * Pending rows — "I clicked Add a document and it vanished".
 *
 * Clicking Add seeds an EMPTY row (a blank attachment binding, a null
 * approver seat, a seatless stage). buildPatch rightly refuses to persist it,
 * so the row lives only in the form's local draft — and the save round-trip
 * used to erase it: the debounce saved a patch without the row, the save's
 * echo came back as fresh step content over a seemingly edit-free draft, and
 * the content sync adopted it. The input disappeared about a second after
 * the click, exactly as the bug report filmed it.
 *
 * Two guards fix it, and each test here pins one:
 *   1. flushNow refuses to SEND a patch the wire reads as a no-op — adding an
 *      empty row must not trigger a save at all.
 *   2. The content sync carries pending rows across an adopted echo — an echo
 *      from some OTHER edit must not take the row with it.
 */

vi.mock('../../../../hooks/useAutomationApi', () => ({
    default: () => ({
        approvalDirectory: async () => ({
            members: [{ id: 'u1', name: 'Ada' }, { id: 'u2', name: 'Bo' }],
            groups: [{ id: 'g1', name: 'Finance' }],
        }),
    }),
}));

const { default: SettingsForm } = await import('./SettingsForm');

const noIssues = { errors: [], warnings: [] };

function renderForm(step) {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} catalog={null} groups={[]} />
        </VariablePickerProvider>,
    );
    const rerenderForm = (nextStep) => utils.rerender(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm step={nextStep} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} catalog={null} groups={[]} />
        </VariablePickerProvider>,
    );
    return { onPatch, rerenderForm, ...utils };
}

const approvalStep = (approval = {}) => ({
    id: 'appr_1', type: 'approval', prompt: 'Pay this invoice?', approval: { expiresInHours: 168, ...approval },
});

beforeEach(() => {
    cleanup();
    scopedStorage.clear?.();
    try { window.localStorage.clear(); } catch { /* jsdom */ }
});

describe('an empty row does not trigger a save', () => {
    it('Add a document appends a row and the autosave stays silent', async () => {
        const { onPatch } = renderForm(approvalStep());
        fireEvent.click(screen.getByRole('button', { name: /add a document/i }));
        // The row is there…
        expect(screen.getByPlaceholderText('Shown name (optional)')).toBeTruthy();
        // …and stays there past the 600ms debounce, with NOTHING sent: the
        // patch for a blank row is byte-identical to the baseline's, so
        // there is no save, hence no echo to wipe the row with.
        await new Promise(r => setTimeout(r, 900));
        expect(onPatch).not.toHaveBeenCalled();
        expect(screen.getByPlaceholderText('Shown name (optional)')).toBeTruthy();
    });
});

describe('a save echo does not take the pending row with it', () => {
    it('the exact bug: add a document, echo arrives, the input survives', async () => {
        const step = approvalStep({ details: 'Old details' });
        const { onPatch, rerenderForm } = renderForm(step);

        fireEvent.click(screen.getByRole('button', { name: /add a document/i }));
        await new Promise(r => setTimeout(r, 900));   // debounce window passes, no save

        // The parent re-renders with new step CONTENT — the shape of a save
        // echo, or of the chat editing the step. The pending row is not in
        // it (it was never saved), and it must not vanish because of that.
        rerenderForm(approvalStep({ details: 'New details from the echo' }));

        expect(screen.getByPlaceholderText('Shown name (optional)')).toBeTruthy();
        // The incoming content was still adopted — carry, not ignore.
        expect(screen.getByText(/New details from the echo/).textContent || document.body.textContent)
            .toContain('New details');
        expect(onPatch).not.toHaveBeenCalled();
    });
});

describe('carryPendingRows', () => {
    const incoming = { attachments: [], approvalFields: [], approvers: [], stages: [] };

    it('carries the empty rows of every Add button, and nothing else', () => {
        const prev = {
            attachments: [{ binding: '{{steps.doc.output.fileId}}' }, { binding: '', label: '' }],
            approvalFields: [{ name: 'q1', label: 'Why?' }],
            approvers: [{ userId: 'u1' }, null],
            stages: [],
        };
        const out = carryPendingRows({ ...incoming, attachments: [{ binding: '{{steps.doc.output.fileId}}' }] }, prev);
        // The persisted attachment comes from INCOMING; only the blank row is carried.
        expect(out.attachments).toEqual([{ binding: '{{steps.doc.output.fileId}}' }, { binding: '', label: '' }]);
        // A named question is persistable — the wire carries it, not us.
        expect(out.approvalFields).toEqual([]);
        // The null seat (a freshly clicked "+ Add approver") is carried.
        expect(out.approvers).toEqual([null]);
    });

    it('carries a seatless stage WHOLE — its typed name must not be lost', () => {
        const prev = { stages: [{ key: 's9', name: 'Directie', description: 'Boven budget', approvers: [null], rule: 'all' }] };
        const out = carryPendingRows({ ...incoming, stages: [] }, prev);
        expect(out.stages).toEqual(prev.stages);
    });

    it('re-applies a pending seat to its stage in the incoming chain, matched by key', () => {
        const prevStage = { key: 's1', name: 'Finance', approvers: [{ userId: 'u1' }, null], rule: 'all' };
        const echoStage = { key: 's1', name: 'Finance', approvers: [{ userId: 'u1' }], rule: 'all' };
        const out = carryPendingRows({ ...incoming, stages: [echoStage] }, { stages: [prevStage] });
        expect(out.stages).toEqual([{ ...echoStage, approvers: [{ userId: 'u1' }, null] }]);
    });

    it('returns incoming untouched when nothing is pending', () => {
        const prev = { attachments: [{ binding: '{{x}}' }], approvers: [{ userId: 'u1' }], stages: [], approvalFields: [] };
        expect(carryPendingRows(incoming, prev)).toBe(incoming);
    });
});

describe('the premise fix 1 rests on', () => {
    it('a blank attachment row does not change the patch buildPatch builds', () => {
        const step = approvalStep();
        const base = { prompt: 'Pay this invoice?', expiresInHours: 168, assignee: null, details: '', attachments: [], approvalFields: [], remindAfterHours: '', escalateTo: null, escalateAfterHours: '', approvers: [], rule: 'all', quorum: 2, finalApprover: null, stages: [] };
        const withRow = { ...base, attachments: [{ binding: '', label: '' }] };
        expect(buildPatch(step, withRow)).toEqual(buildPatch(step, base));
    });
});
