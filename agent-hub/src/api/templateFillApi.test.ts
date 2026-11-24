import { describe, it, expect } from 'vitest';

import { fillDocumentOf, progressOf } from './templateFillApi';

describe('fillDocumentOf', () => {
    it('reads the fields, the stored values and whether the fill is finished from the document route\'s answer', () => {
        const doc = fillDocumentOf({
            document: {
                name: 'Deck', docType: 'presentation', editable: false,
                settings: { sampleValues: { title: 'Kick-off' }, templateFill: { conversationId: 'c', finishedAt: '2026-11-20T10:00:00Z' } },
                contract: { parameters: [{ key: 'title', type: 'text', label: 'Title', required: true, instructions: 'The deck title', example: 'Q4' }, { nope: 1 }] },
            },
        }, 'd1');
        expect(doc).toEqual({
            id: 'd1', name: 'Deck', url: '/app/studio/documents/d1', format: 'pptx', editable: false, finished: true, canFile: false,
            fields: [{ key: 'title', type: 'text', label: 'Title', required: true, help: 'The deck title', example: 'Q4' }],
            values: { title: 'Kick-off' }, projectId: null, versionId: null,
            team: { requests: [], filledBy: {}, notes: [], review: null },
        });
        expect(fillDocumentOf(null, 'x')).toMatchObject({ fields: [], values: {}, finished: false, format: 'pdf' });
    });

    it('offers "Add to project" only on the person\'s own document that is in no project yet', () => {
        const own = { name: 'Offer', kind: 'document', deletable: true, projectId: null };
        expect(fillDocumentOf({ document: own }, 'd1').canFile).toBe(true);
        expect(fillDocumentOf({ document: { ...own, projectId: 'p1' } }, 'd1').canFile).toBe(false);
        expect(fillDocumentOf({ document: { ...own, deletable: false } }, 'd1').canFile).toBe(false);
    });

    it('reads what is shown next to the values from the document: requests, who filled what, notes, and the check\'s remarks that still apply', () => {
        const doc = fillDocumentOf({ document: {
            name: 'Offer', kind: 'document', projectId: 'p1', versionId: 'v7',
            settings: {
                sampleValues: { scope: 'changed since', price: 5 },
                valueRequests: [{ id: 'r1', fields: ['iban'], assigneeId: 'bob', requestedBy: 'ann', message: '', createdAt: 'x' }, { nope: true }],
                filledBy: { price: { userId: 'ann', at: 'now', via: 'ai' } },
                fieldNotes: [{ id: 'n1', key: 'price', userId: 'ann', text: 'Leave it.', at: 'now' }, 'junk'],
                fillReview: { at: 'then', checked: 2, findings: [
                    { key: 'scope', kind: 'rewrite', suggestion: 'Better', reason: 'Wording.', was: '"as it was"' },
                    { key: 'price', kind: 'doubt', reason: 'Low.', was: '5' },
                ] },
            },
        } }, 'd1');
        expect(doc.url).toBe('/app/projects/p1/documents/d1');
        expect(doc.versionId).toBe('v7');
        expect(doc.team?.requests.map((r) => r.id)).toEqual(['r1']);
        expect(doc.team?.filledBy.price.via).toBe('ai');
        expect(doc.team?.notes.map((n) => n.text)).toEqual(['Leave it.']);
        // The remark on a value that changed since the check is gone; the other one is shown without the bookkeeping.
        expect(doc.team?.review).toEqual({ at: 'then', checked: 2, findings: [{ key: 'price', kind: 'doubt', reason: 'Low.' }] });
    });

    it('a route\'s answer says where the filling stands, and carries the same four next to it', () => {
        const out = progressOf({ values: { a: 1 }, complete: true, filled: 1, total: 2, finished: false, versionId: 'v8', requests: [], notes: [], filledBy: {},
            review: { at: 'now', checked: 1, findings: [{ key: 'a', kind: 'doubt', reason: 'Odd.' }] } });
        expect(out.versionId).toBe('v8');
        expect(out.team?.review?.findings).toEqual([{ key: 'a', kind: 'doubt', reason: 'Odd.' }]);
        expect(progressOf(null)).toMatchObject({ complete: false, filled: 0, team: { review: null } });
    });
});
