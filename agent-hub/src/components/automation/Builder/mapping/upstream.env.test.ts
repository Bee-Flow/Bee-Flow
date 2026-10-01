// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildToolOutputMap, computeUpstreamGroups, describeNode } from './upstream';
import { ROUTE_STEP_NAME, SET_STEP_NAME } from '../flow/stepDisplayName';

/**
 * What the builder's own hooks (BUILDER_ENV in upstream.ts) change about the
 * core describers. The describers themselves are tested where they live,
 * server/shared/mapping/upstream/*.test.mjs; these cases exist only here
 * because the facts they rest on are agent-hub modules.
 */

type Field = { key: string; path: string | null; sample?: unknown; children?: Field[] };
type Group = { id: string; label: string; sample?: unknown; fields: Field[] } | null | undefined;

const paths = (group: Group): string[] => {
    const out: string[] = [];
    const walk = (fields: Field[]) => {
        for (const f of fields) {
            if (f.path) out.push(f.path);
            if (Array.isArray(f.children)) walk(f.children);
        }
    };
    walk(group?.fields || []);
    return out;
};
const describeOne = (node: Record<string, unknown>) => describeNode(node, {}, buildToolOutputMap(null), {}) as Group;

/**
 * Date & time list mode (flow/datetimeTarget). A step saved with a whole
 * column in "Input date" and no `arrayRef` runs as list mode (BFSF-375), so it
 * emits `{ items, count }`: the picker has to offer that shape, not the
 * single-date `value` the run never produces.
 */
describe('describeDateTime', () => {
    it('offers the list shape for a column saved without list mode', () => {
        const g = describeOne({
            id: 'dt1', type: 'datetime', op: 'extract', part: 'day',
            input: 'steps.s.output.results[*].updated',
        });
        expect(g?.sample).toHaveProperty('items');
        expect(g?.sample).toHaveProperty('count');
        expect(paths(g)).toContain('steps.dt1.output.items[*].day');
    });

    it('keeps the single-date shape for one date', () => {
        const g = describeOne({ id: 'dt1', type: 'datetime', op: 'extract', part: 'day', input: 'trigger.output.when' });
        expect(g?.sample).not.toHaveProperty('items');
        expect(g?.sample).toHaveProperty('value');
    });
});

/** The Set step's column operations (flow/setOperations) fold into its row shape. */
describe('describeSet in list mode', () => {
    const catalog = {
        apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ subject: 'Re: hi', from: 'a@b.c' }] } }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };

    it('reflects the post-operations column set: renamed and removed columns are gone, targets exist', () => {
        const setStep = {
            id: 's1', type: 'set', arrayRef: 'steps.g1.output.results', fields: {},
            operations: [
                { op: 'rowId', target: 'id' },
                { op: 'rename', from: 'subject', to: 'title' },
                { op: 'remove', keys: ['from'] },
            ],
        };
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'g1', type: 'integration_action', tool: 'gmail_search', inputs: {} }, setStep, { id: 'after', type: 'notification', title: 't' }],
            edges: [{ from: 'trg', to: 'g1' }, { from: 'g1', to: 's1' }, { from: 's1', to: 'after' }],
        };
        const g = computeUpstreamGroups(def, 'after', catalog).find(x => x.id === 's1') as Group;
        const childKeys = (g?.fields.find(f => f.key === 'items')?.children || []).map(c => c.key);
        expect(childKeys).toContain('id');
        expect(childKeys).toContain('title');
        expect(childKeys).not.toContain('subject');
        expect(childKeys).not.toContain('from');
    });
});

/** The two renamed steps read their group name from nodeDefs (flow/stepDisplayName). */
describe('group names', () => {
    it('an unlabelled Set and Filter are named as the canvas names them', () => {
        expect(describeOne({ id: 's1', type: 'set', fields: {} })?.label).toBe(SET_STEP_NAME);
        expect(describeOne({ id: 'f1', type: 'filter', arrayRef: 'trigger.output.rows' })?.label).toBe(ROUTE_STEP_NAME);
    });
});
