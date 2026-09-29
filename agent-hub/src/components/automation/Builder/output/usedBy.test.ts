import { describe, it, expect } from 'vitest';
import { looksLikeFileRows, usedByDownstream } from './usedBy';

const definition = {
    trigger: { id: 't1', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'read', type: 'action', label: 'Read the file' },
        { id: 'extract', type: 'ai_step', label: 'Read the invoice details', prompt: 'Use {{steps.read.output.text}} and {{steps.read.output.pageCount}}' },
        { id: 'log', type: 'datatable', label: 'Log it', inputs: { row: 'steps.read.output' } },
        { id: 'other', type: 'action', label: 'Unrelated', inputs: { x: 'steps.extract.output.total' } },
    ],
    edges: [
        { from: 't1', to: 'read' }, { from: 'read', to: 'extract' }, { from: 'extract', to: 'log' }, { from: 'log', to: 'other' },
    ],
};

describe('who really uses a step\'s output', () => {
    it('lists the steps that reference it, with the fields they read', () => {
        const used = usedByDownstream(definition, 'read');
        expect(used.map(u => u.stepId)).toEqual(['extract', 'log']);
        expect(used[0]).toMatchObject({ label: 'Read the invoice details', fields: ['Text', 'Page count'], leaves: ['text', 'pageCount'], family: 'ai' });
        // The whole output, no field in particular.
        expect(used[1].fields).toEqual([]);
        expect(typeof used[0].number).toBe('number');
    });

    it('does not count a connection line as use', () => {
        expect(usedByDownstream(definition, 'other')).toEqual([]);
        expect(usedByDownstream(null, 'read')).toEqual([]);
    });

    it('tells a list of files from a list of records', () => {
        expect(looksLikeFileRows([{ name: 'a.pdf', path: '/a.pdf', size: 1 }])).toBe(true);
        expect(looksLikeFileRows([{ name: 'Acme', total: 3 }])).toBe(false);
    });
});
