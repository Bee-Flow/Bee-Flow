import { describe, expect, it } from 'vitest';
import { carryPendingRows } from './pendingRows';

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
