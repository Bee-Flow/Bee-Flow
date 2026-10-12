/**
 * "Flatten a list" in the phone's bindings: auto-map on insert picks the outer
 * list and the list inside it and stores the shared plan (F45), the field
 * picker after it offers the flattened rows (F46), and a per-item step over
 * its rows is named after the inner list (F47).
 */

import type { FlowDefinition } from '@/features/flow-editor/model';
import { insertStep } from '@/features/flow-editor/model/outline';

import { autoMapInserted } from './autoMapInsert';
import { autoMapStep } from './autoMapStep';
import type { FlowNode } from './types';
import { describeNode } from './upstream/describeNode';
import { suggestItemVar } from './upstream/loops';

interface Corpus {
    FLATTEN_MAIL_STEP: FlowNode;
    flattenMailRoot: () => { steps: Record<string, { output: unknown }> };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const corpus = require('../../../../../agent-hub/src/shared/expr/corpus.mjs') as Corpus;

const catalog = { apps: [] };
const mailOutput = () => corpus.flattenMailRoot().steps.g_read_many?.output;

const readMany = (): FlowDefinition => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 'g_read_many', type: 'http_request', label: 'Read many', url: 'https://mail.example' }],
    edges: [{ from: 'trg', to: 'g_read_many' }],
});
const addFlatten = () => insertStep(readMany(), { kind: 'after', sourceId: 'g_read_many', handle: null }, { kind: 'flatten', label: 'Flatten a list' });
const stepOf = (def: FlowDefinition, id: string | null) => def.steps.find((s) => s.id === id) as FlowNode;

describe('auto-map on insert (F45)', () => {
    it('drops in after Read many already making one row per attachment, with the J1 plan', () => {
        const real = new Map<string, unknown>([['g_read_many', mailOutput()]]);
        const out = autoMapInserted(addFlatten(), { catalog, realOutputById: real });
        const flat = stepOf(out.definition, out.addedId);
        expect(flat).toMatchObject({
            type: 'flatten',
            arrayRef: corpus.FLATTEN_MAIL_STEP.arrayRef,
            parents: corpus.FLATTEN_MAIL_STEP.parents,
            label: 'One row per attachment',
            keepEmpty: false,
        });
    });

    it('stays blank when no upstream list holds a list of records', () => {
        const real = new Map<string, unknown>([['g_read_many', { messages: [{ subject: 'a', labelIds: ['INBOX'] }] }]]);
        const added = addFlatten();
        const out = autoMapStep(stepOf(added.definition, added.addedId), added.definition, catalog, { realOutputById: real });
        expect(out.mappedKeys).toEqual([]);
        expect(out.step.arrayRef).toBe('');
    });

    it('never re-maps a step whose route was picked', () => {
        const added = addFlatten();
        const picked = { ...stepOf(added.definition, added.addedId), arrayRef: 'steps.x.output.a[*].b' };
        const def = { ...added.definition, steps: added.definition.steps.map((s) => (s.id === picked.id ? picked : s)) };
        const real = new Map<string, unknown>([['g_read_many', mailOutput()]]);
        expect(autoMapStep(picked, def, catalog, { realOutputById: real }).mappedKeys).toEqual([]);
    });
});

describe('the field picker after a flatten (F46)', () => {
    it('offers every row key under items, then the counts', () => {
        const node = { ...corpus.FLATTEN_MAIL_STEP } as FlowNode;
        const group = describeNode(node, { sampleRoot: corpus.flattenMailRoot() } as never);
        const paths = (group?.fields ?? []).map((f) => f.path);
        expect(paths).toEqual([
            'steps.mf_flatten.output.items', 'steps.mf_flatten.output.count',
            'steps.mf_flatten.output.inputCount', 'steps.mf_flatten.output.emptyCount',
        ]);
        const items = group?.fields?.[0] as { children?: { key: string }[] } | undefined;
        expect((items?.children ?? []).map((c) => c.key)).toEqual([
            'attachmentId', 'filename', 'mimeType', 'size', 'canOCR', 'messageId', 'threadId', 'from', 'to', 'subject', 'date',
        ]);
    });

    it('offers only the envelope while no list is picked', () => {
        const group = describeNode({ id: 'f1', type: 'flatten', arrayRef: '' } as FlowNode, { sampleRoot: null } as never);
        expect(group?.label).toBe('Flatten a list');
        expect((group?.fields ?? []).map((f) => f.key)).toEqual(['items', 'count', 'inputCount', 'emptyCount']);
    });
});

describe('item variables (F47)', () => {
    it('names the rows of a flatten, and of a filter over one, after the inner list', () => {
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { ...corpus.FLATTEN_MAIL_STEP },
                { id: 'mf_filter', type: 'filter', arrayRef: 'steps.mf_flatten.output.items', expr: 'true' },
            ],
            edges: [],
        } as unknown as FlowDefinition;
        expect(suggestItemVar('items', def, 'steps.mf_flatten.output.items')).toBe('attachment');
        expect(suggestItemVar('items', def, 'steps.mf_filter.output.items')).toBe('attachment');
        expect(suggestItemVar('items')).toBe('item');
        expect(suggestItemVar('categories')).toBe('category');
    });
});
