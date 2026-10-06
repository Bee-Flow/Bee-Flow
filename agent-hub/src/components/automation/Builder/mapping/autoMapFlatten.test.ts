// @vitest-environment node
/**
 * F45: a "Flatten a list" dropped after Read many maps itself in one go, the
 * route, the column plan and the label, so Simple mode has nothing to fill
 * in. After a step with no list inside a list it takes the next upstream one,
 * or stays blank.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLATTEN_MAIL_STEP, flattenMailRoot } from '@shared/expr/corpus.mjs';
import { applyAutoMapToStep } from './autoMapInputs';
import { autoMapFlatten, flattenLabel, nearestFlattenRoute } from './autoMapFlatten';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { OUTPUT_SCHEMAS } = require_(path.resolve(HERE, '../../../../../../server/automation/outputSchemas.js')) as {
    OUTPUT_SCHEMAS: Record<string, { sample: unknown }>;
};

const TOOLS = ['gmail_read_many', 'gmail_read'];
const CATALOG = {
    apps: [{ id: 'gmail', actions: TOOLS.map(name => ({ name, inputSchema: { properties: {} }, outputSample: OUTPUT_SCHEMAS[name]?.sample })) }],
    triggerOutputs: { __manual: { fields: [], sample: {} } },
};

type Step = Record<string, unknown>;
const gmail = (id: string, tool: string): Step => ({ id, type: 'integration_action', label: id, tool, appId: 'gmail', inputs: {} });
const flatten = (extra: Step = {}): Step => ({ id: 'mf_flatten', type: 'flatten', label: 'Flatten a list', arrayRef: '', keepEmpty: false, ...extra });

function definitionOf(steps: Step[]) {
    const ids = ['trg', ...steps.map(s => s.id as string)];
    return {
        trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
        steps,
        edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })),
    };
}

const flatOf = (def: { steps: Step[] }) => def.steps.find(s => s.type === 'flatten') as Step;

describe('autoMapFlatten (F45)', () => {
    it('J1: after Read many, one call writes the route, the stored plan and the label', () => {
        const def = definitionOf([gmail('g_read_many', 'gmail_read_many'), flatten()]);
        const real = new Map([['g_read_many', flattenMailRoot().steps.g_read_many.output]]);
        const { definition, mappedKeys } = applyAutoMapToStep(def, 'mf_flatten', CATALOG, { realOutputById: real });
        const step = flatOf(definition);
        expect(mappedKeys).toEqual(['arrayRef']);
        expect(step.arrayRef).toBe(FLATTEN_MAIL_STEP.arrayRef);
        expect(step.parents).toEqual(FLATTEN_MAIL_STEP.parents);
        expect(step.label).toBe('One row per attachment');
    });

    it('works from the catalog sample alone, before any run', () => {
        const def = definitionOf([gmail('g_read_many', 'gmail_read_many'), flatten()]);
        const step = flatOf(applyAutoMapToStep(def, 'mf_flatten', CATALOG).definition);
        expect(step.arrayRef).toBe('steps.g_read_many.output.messages[*].attachments');
        const parents = step.parents as Array<{ itemVar: string; auto: boolean; fields: Array<{ to: string }> }>;
        expect(parents[0].itemVar).toBe('message');
        expect(parents[0].auto).toBe(true);
        expect(parents[0].fields.map(f => f.to)).toContain('subject');
    });

    it('after gmail_read (one mail, no list inside a list) takes the next upstream list', () => {
        const def = definitionOf([gmail('g_read_many', 'gmail_read_many'), gmail('g_read', 'gmail_read'), flatten()]);
        const step = flatOf(applyAutoMapToStep(def, 'mf_flatten', CATALOG).definition);
        expect(step.arrayRef).toBe('steps.g_read_many.output.messages[*].attachments');
    });

    it('stays blank when nothing upstream holds a list inside a list', () => {
        const def = definitionOf([gmail('g_read', 'gmail_read'), flatten()]);
        const { definition, mappedKeys } = applyAutoMapToStep(def, 'mf_flatten', CATALOG);
        expect(mappedKeys).toEqual([]);
        expect(flatOf(definition).arrayRef).toBe('');
    });

    it('never touches a step that already has a source, nor a label the author wrote', () => {
        const set = flatten({ arrayRef: 'steps.x.output.orders[*].lines' });
        expect(autoMapFlatten(set, []).step).toBe(set);
        const groups = [{ id: 'g', label: 'Read many', kind: 'action', basePath: 'steps.g_read_many.output', sample: flattenMailRoot().steps.g_read_many.output, fields: [] }];
        const named = autoMapFlatten(flatten({ label: 'Invoice files' }), groups).step;
        expect(named.label).toBe('Invoice files');
        expect(named.arrayRef).toBe(FLATTEN_MAIL_STEP.arrayRef);
    });

    it('skips the current item of a loop and lists of scalars', () => {
        const groups = [
            { id: 'h', label: 'HTTP', kind: 'action', basePath: 'steps.h.output', sample: { body: { tags: [['a'], ['b']] } }, fields: [] },
            { id: 'own', label: 'Current item', kind: 'loop', basePath: 'loop.item', ownItem: true, sample: { lines: [{ id: 1 }] }, fields: [] },
        ];
        expect(nearestFlattenRoute(groups)).toBeNull();
    });

    it('names the label after the inner item, through a translator when given', () => {
        expect(flattenLabel('steps.h.output.body.orders[*].lines')).toBe('One row per line');
        expect(flattenLabel('steps.h.output.body.orders[*].lines', c => `Eén rij per ${c}`)).toBe('Eén rij per line');
    });

    it('J1 step 7: a per-item step after a filter over the flatten loops over `attachment` (F47)', () => {
        const target = { name: 'gmail_read_attachment', inputSchema: { properties: { messageId: { type: 'string' }, attachmentId: { type: 'string' } }, required: ['messageId', 'attachmentId'] } };
        const catalog = { ...CATALOG, apps: [{ ...CATALOG.apps[0], actions: [...CATALOG.apps[0].actions, target] }] };
        const def = definitionOf([
            gmail('g_read_many', 'gmail_read_many'),
            flatten({ arrayRef: FLATTEN_MAIL_STEP.arrayRef, parents: FLATTEN_MAIL_STEP.parents }),
            { id: 'mf_filter', type: 'filter', label: 'PDF only', arrayRef: 'steps.mf_flatten.output.items', expr: 'true' },
            gmail('mf_read_file', 'gmail_read_attachment'),
        ]);
        const real = new Map([['g_read_many', flattenMailRoot().steps.g_read_many.output]]);
        const { definition } = applyAutoMapToStep(def, 'mf_read_file', catalog, { realOutputById: real });
        const step = definition.steps.find((s: Step) => s.id === 'mf_read_file') as Step;
        const forEach = step.forEach as { overRef: string; itemVar: string };
        expect(forEach.overRef).toBe('steps.mf_filter.output.items');
        expect(forEach.itemVar).toBe('attachment');
        expect((step.inputs as Record<string, unknown>).attachmentId).toEqual({ kind: 'ref', path: 'loop.attachment.attachmentId' });
    });
});
