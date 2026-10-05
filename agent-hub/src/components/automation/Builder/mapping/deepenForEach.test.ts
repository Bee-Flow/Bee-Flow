import { describe, expect, it } from 'vitest';
import { deepenedForEach, nestedListPick, rebindToNewItem } from './deepenForEach';
// The runtime's own walker: the deepened overRef must give ONE flat list.
const { walkPath } = require('../../../../../../server/automation/bind');

// Gmail read, run per search result: each result's output holds its attachments.
const RUN = {
    steps: {
        s3: {
            output: {
                results: [
                    { index: 0, output: { id: 'm1', subject: 'Factuur', attachments: [
                        { filename: 'a.pdf', mimeType: 'application/pdf', attachmentId: 'a1', messageId: 'm1' },
                        { filename: 'logo.png', mimeType: 'image/png', attachmentId: 'a2', messageId: 'm1' },
                    ] } },
                    { index: 1, output: { id: 'm2', subject: 'Bon', attachments: [
                        { filename: 'b.pdf', mimeType: 'application/pdf', attachmentId: 'a3', messageId: 'm2' },
                    ] } },
                ],
            },
        },
    },
};
const FE = { overRef: 'steps.s3.output.results[*].output', itemVar: 'result', maxIterations: 100 };

describe('nestedListPick', () => {
    it('recognises a value from a list inside the step\'s own item', () => {
        expect(nestedListPick('loop.result.attachments[*].attachmentId', 'result')).toEqual({
            fromVar: 'result', listTail: 'attachments', fieldTail: '.attachmentId', itemVar: 'attachment',
        });
    });

    it('leaves alone a plain field, another loop\'s item, and a list two levels down', () => {
        expect(nestedListPick('loop.result.subject', 'result')).toBeNull();
        expect(nestedListPick('loop.row.attachments[*].attachmentId', 'result')).toBeNull();
        expect(nestedListPick('loop.result.a[*].b[*].c', 'result')).toBeNull();
        expect(nestedListPick('loop.result.attachments[*].id', null)).toBeNull();
    });
});

describe('deepenedForEach', () => {
    it('runs over every attachment of every email, as one flat list the runtime resolves', () => {
        const plan = nestedListPick('loop.result.attachments[*].attachmentId', 'result')!;
        const fe = deepenedForEach(FE, plan);
        expect(fe).toMatchObject({ overRef: 'steps.s3.output.results[*].output.attachments', itemVar: 'attachment', maxIterations: 100 });
        expect(walkPath(fe.overRef, RUN).map((a: { attachmentId: string }) => a.attachmentId)).toEqual(['a1', 'a2', 'a3']);
    });

    it('flattens a plain list first', () => {
        const plan = nestedListPick('loop.mail.attachments[*].attachmentId', 'mail')!;
        expect(deepenedForEach({ overRef: 'steps.s1.output.messages', itemVar: 'mail' }, plan).overRef)
            .toBe('steps.s1.output.messages[*].attachments');
    });
});

describe('rebindToNewItem', () => {
    const plan = nestedListPick('loop.result.attachments[*].attachmentId', 'result')!;
    const ATTACHMENT = RUN.steps.s3.output.results[0].output.attachments[0];

    it('moves a field to the new item\'s field of the same name: messageId reads the attachment\'s messageId', () => {
        const { inputs, orphans } = rebindToNewItem({
            messageId: { kind: 'ref', path: 'loop.result.id' },
            attachmentId: { kind: 'ref', path: 'loop.attachment.attachmentId' },
            note: { kind: 'literal', value: 'x' },
        }, plan, ATTACHMENT);
        expect(inputs.messageId).toEqual({ kind: 'ref', path: 'loop.attachment.messageId' });
        expect(inputs.attachmentId).toEqual({ kind: 'ref', path: 'loop.attachment.attachmentId' });
        expect(inputs.note).toEqual({ kind: 'literal', value: 'x' });
        expect(orphans).toEqual([]);
    });

    it('reports what has no counterpart instead of pointing it at nothing', () => {
        const { inputs, orphans } = rebindToNewItem({
            title: { kind: 'template', value: 'Re: {{loop.result.subject}} ({{loop.result.mimeType}})' },
        }, plan, ATTACHMENT);
        expect(orphans).toEqual(['title']);
        expect((inputs.title as { value: string }).value).toBe('Re: {{loop.result.subject}} ({{loop.attachment.mimeType}})');
    });
});

describe('the drag path: what "Comes in" offers and where a table drop lands', () => {
    it('the current item offers the columns of a list inside it', async () => {
        // JS modules: their JSDoc types are looser than what they take.
        const describeForEachItem = (await import('./upstream/loops')).describeForEachItem as unknown as (...a: unknown[]) => { fields: Array<{ key: string; children?: Array<{ path: string }> }> };
        const g = describeForEachItem(
            { id: 'att', forEach: { overRef: 'steps.s3.output.results[*].output', itemVar: 'result' } },
            { steps: [] }, new Map(), RUN,
        );
        const att = g.fields.find(f => f.key === 'attachments');
        expect((att?.children || []).map(c => c.path)).toContain('loop.result.attachments[*].attachmentId');
    });

    it('a whole table on a text slot named after a column takes that column', async () => {
        const columnForSlot = (await import('./mismatch')).columnForSlot as unknown as (p: string, r: unknown, o: { slot: string; expectedKind: string }) => string | null;
        const root = { loop: { result: RUN.steps.s3.output.results[0].output } };
        expect(columnForSlot('loop.result.attachments', root, { slot: 'attachmentId', expectedKind: 'text' }))
            .toBe('loop.result.attachments[*].attachmentId');
        expect(columnForSlot('loop.result.attachments', root, { slot: 'body', expectedKind: 'text' })).toBeNull();
    });
});
