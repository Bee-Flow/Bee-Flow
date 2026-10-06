// @vitest-environment node
/**
 * F46: before any run, the field picker offers one column per row key of a
 * flatten (the child's fields, then the copied parent fields) under
 * `steps.<id>.output.items[*]`, plus its plain counts.
 */
import { describe, expect, it } from 'vitest';
import { FLATTEN_MAIL_STEP, flattenMailRoot } from '@shared/expr/corpus.mjs';
import { describeFlatten } from './flattenStep';
import { describeNode } from './describeNode';

type F = { key: string; path: string; children?: F[] };
const paths = (fields: F[]): string[] => fields.flatMap(f => [f.path, ...paths(f.children || [])]);

describe('describeFlatten (F46)', () => {
    const step = { ...FLATTEN_MAIL_STEP };
    const group = describeFlatten(step, flattenMailRoot());

    it('offers every row key as a column of items, in row order', () => {
        const items = group.fields.find(f => f.key === 'items') as F;
        const cols = (items.children || []).map(c => c.path);
        expect(cols).toEqual([
            'attachmentId', 'filename', 'mimeType', 'size', 'canOCR', 'messageId', 'threadId', 'from', 'to', 'subject', 'date',
        ].map(k => `steps.mf_flatten.output.items[*].${k}`));
    });

    it('offers the counts as plain values and the step label as the group name', () => {
        const all = paths(group.fields as F[]);
        for (const k of ['count', 'inputCount', 'emptyCount']) expect(all).toContain(`steps.mf_flatten.output.${k}`);
        expect(group.label).toBe('One row per attachment');
        expect(group.basePath).toBe('steps.mf_flatten.output');
    });

    it('is the describer describeNode dispatches to', () => {
        const viaNode = describeNode(step, { steps: [step] }, new Map(), {}, flattenMailRoot() as never);
        expect(viaNode).toEqual(group);
    });

    it('without a sample or a route: an empty items list, never a throw', () => {
        expect(describeFlatten({ id: 'f', type: 'flatten', arrayRef: '' }, null).sample.items).toEqual([]);
        expect(describeFlatten({ id: 'f', type: 'flatten', arrayRef: '' }, flattenMailRoot()).label).toBe('Flatten a list');
    });
});
