// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { computeUpstreamGroups as computeUpstreamGroupsJs } from './index';
import { eachField, type Field } from './fieldTree';
import * as loops from './loops';
import { buildRealOutputMap, buildSampleRoot } from '../realOutputs';

/**
 * The "current item" a per-item step previews is ONE item, the first, as the
 * run's first iteration binds it: its own values (also an empty one), its
 * own lists (never the rows' lists strung together). Only keys the first
 * item lacks are filled in from the other rows, so a field only a later row
 * has is still offered. The drawer labels this sample "1 of N".
 */
type Group = { id: string; basePath: string; fields: Field[]; sample?: unknown };
const computeUpstreamGroups = computeUpstreamGroupsJs as (...args: unknown[]) => Group[];
const { describeLoop, inferLoopItemSample } = loops as unknown as Record<string, (...a: unknown[]) => unknown>;

const M1 = { id: 'm1', subject: 'First', note: '', attachments: [{ id: 'a1' }, { id: 'a2' }], from: { name: 'Ann' } };
const M2 = { id: 'm2', subject: 'Second', note: 'urgent', attachments: [{ id: 'a3', mime: 'pdf' }], from: { name: 'Bob', address: 'b@x' }, extra: 7 };
const ROWS = [M1, M2];

const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'list', type: 'integration_action', tool: 'list_mail', inputs: {} },
        { id: 'each', type: 'integration_action', tool: 'read_mail', inputs: {}, forEach: { overRef: 'steps.list.output.value', itemVar: 'mail' } },
    ],
    edges: [{ from: 'trg', to: 'list' }, { from: 'list', to: 'each' }],
};

function itemGroup() {
    const real = buildRealOutputMap(DEF, [{ stepId: 'list', output: { value: ROWS } }]);
    const groups = computeUpstreamGroups(DEF, 'each', { apps: [] }, real);
    const g = groups.find(x => x.basePath === 'loop.mail') as Group;
    const byPath = new Map<string, Field>();
    eachField(g.fields, f => byPath.set(f.path, f));
    return { g, byPath, root: buildSampleRoot(groups) };
}

describe("a per-item step's current item", () => {
    it('previews the first item\'s own values, not the first that says something', () => {
        const { g, byPath, root } = itemGroup();
        const sample = g.sample as Record<string, unknown>;
        expect(sample.note).toBe('');
        expect(sample.subject).toBe('First');
        expect(sample.attachments).toEqual(M1.attachments);
        expect(getPath(root, 'loop.mail.note')).toBe('');
        expect(getPath(root, 'loop.mail.attachments')).toEqual(M1.attachments);
        expect(getPath(root, 'loop.mail.from.name')).toBe('Ann');
        expect(byPath.get('loop.mail.note')?.sample).toBe('');
        expect(byPath.get('loop.mail.attachments')?.sample).toEqual(M1.attachments);
    });

    it('still offers what only a later item has', () => {
        const { byPath } = itemGroup();
        expect(byPath.has('loop.mail.from.address')).toBe(true);
        expect(byPath.has('loop.mail.attachments[*].mime')).toBe(true);
        expect(byPath.has('loop.mail.extra')).toBe(true);
    });

    it('is the same item for the shared inference and a Loop seen from downstream', () => {
        const root = { steps: { list: { output: { value: ROWS } } } };
        const item = inferLoopItemSample('steps.list.output.value', DEF, new Map(), root) as Record<string, unknown>;
        expect(item.note).toBe('');
        expect(item.attachments).toEqual(M1.attachments);
        expect(item.from).toEqual({ name: 'Ann', address: 'b@x' });
        const loop = { id: 'lp', type: 'loop', itemVar: 'mail', overRef: 'steps.list.output.value', body: [] };
        const g = describeLoop(loop, new Map(), { steps: [...DEF.steps, loop] }, root) as Group & { sample: { results: Array<{ item: Record<string, unknown> }> } };
        expect(g.sample.results[0].item.note).toBe('');
    });

    it('a first item that is not a record falls back to the union of the rows', () => {
        const root = { steps: { list: { output: { value: [null, { a: 1 }] } } } };
        expect(inferLoopItemSample('steps.list.output.value', DEF, new Map(), root)).toEqual({ a: 1 });
    });
});
