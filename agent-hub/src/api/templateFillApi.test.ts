import { describe, it, expect } from 'vitest';

import { fillDocumentOf } from './templateFillApi';

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
            id: 'd1', name: 'Deck', url: '/app/studio/documents/d1', format: 'pptx', editable: false, finished: true,
            fields: [{ key: 'title', type: 'text', label: 'Title', required: true, help: 'The deck title', example: 'Q4' }],
            values: { title: 'Kick-off' },
        });
        expect(fillDocumentOf(null, 'x')).toMatchObject({ fields: [], values: {}, finished: false, format: 'pdf' });
    });
});
