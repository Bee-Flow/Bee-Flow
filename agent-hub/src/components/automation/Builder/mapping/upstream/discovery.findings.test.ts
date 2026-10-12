// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { computeUpstreamGroups as computeUpstreamGroupsJs, collectArrayPaths as collectArrayPathsJs, resolveElementSample, overlayGroupWithReal } from './index';
import { eachField, mergeElements, type Field } from './fieldTree';
import { buildRealOutputMap, buildSampleRoot } from '../realOutputs';
import { joinKeyPath, keyPickable } from '../keyPath';

/**
 * Regressions for the field-discovery audit: each case is a way the builder
 * used to offer a path the run could not resolve, or not offer a field the
 * data had. Every path is checked with the RUNTIME resolver (getPath).
 */

type Group = { id: string; kind?: string; basePath: string; fields: Field[]; sample?: unknown; hasRealData?: boolean };

// The JS modules' `= null` defaults read as the parameters' whole type in TS.
const computeUpstreamGroups = computeUpstreamGroupsJs as (...args: unknown[]) => Group[];
const collectArrayPaths = collectArrayPathsJs as (...args: unknown[]) => Field[];

const flat = (g: Group | undefined) => {
    const out: Field[] = [];
    eachField(g?.fields, f => out.push(f));
    return out;
};
const paths = (g: Group | undefined) => flat(g).map(f => f.path);
const field = (g: Group | undefined, path: string) => flat(g).find(f => f.path === path);

function chain(steps: object[], trigger: object = { id: 'trg', kind: 'manual' }) {
    const all = [...steps, { id: 'dst', type: 'notification', title: 'x' }] as Array<{ id: string }>;
    const edges = [{ from: (trigger as { id: string }).id, to: all[0].id }];
    for (let i = 1; i < all.length; i++) edges.push({ from: all[i - 1].id, to: all[i].id });
    return { trigger, steps: all, edges };
}
const HOSTILE = { '@odata.etag': 'W/"1"', 'Story Points': 3, 'line-items': [{ 'unit-price': 9.5, sku: 'A' }], ok: true };
const CATALOG = {
    apps: [{
        actions: [
            { name: 'hostile', outputSample: HOSTILE },
            { name: 'gmail_search', outputSample: { query: 'q', total: 1, results: [{ id: 'm1', subject: 'Hi', from: 'a@b.c' }] } },
            { name: 'list_tool', outputSample: [{ id: 1, name: 'A' }] },
        ],
    }],
    triggerOutputs: {
        'google-calendar.event.changed': {
            fields: [{ key: 'organizer', sample: { email: 'o@x.nl', displayName: 'O' } }, { key: 'attendees', sample: [{ email: 'a@x.nl', responseStatus: 'accepted' }] }],
            sample: { organizer: { email: 'o@x.nl', displayName: 'O' }, attendees: [{ email: 'a@x.nl', responseStatus: 'accepted' }] },
        },
    },
};

describe('describers build every path through the runtime grammar', () => {
    it('a step that runs once per item quotes its keys, and keeps their children', () => {
        const def = chain([
            { id: 'src', type: 'integration_action', tool: 'gmail_search' },
            { id: 'fe', type: 'integration_action', tool: 'hostile', forEach: { overRef: 'steps.src.output.results' } },
        ]);
        const g = computeUpstreamGroups(def, 'dst', CATALOG).find((x: Group) => x.id === 'fe') as Group;
        const run = { steps: { fe: { output: { results: [{ output: HOSTILE }, { output: { ...HOSTILE, 'Story Points': 5 } }] } } } };
        expect(paths(g)).toContain('steps.fe.output.results[*].output["@odata.etag"]');
        expect(paths(g)).toContain('steps.fe.output.results[*].output["line-items"][*]["unit-price"]');
        expect(getPath(run, 'steps.fe.output.results[*].output["Story Points"]')).toEqual([3, 5]);
        for (const f of flat(g)) {
            if (f.path.includes('results[*]')) expect(getPath(run, f.path), f.path).not.toBeUndefined();
        }
    });

    it('after a run, a per-item step still lists its fields once, flat, with real values', () => {
        const def = chain([
            { id: 'src', type: 'integration_action', tool: 'gmail_search' },
            { id: 'fe', type: 'integration_action', tool: 'hostile', forEach: { overRef: 'steps.src.output.results' } },
        ]);
        const envelope = { iterations: 2, succeeded: 2, failed: 0, results: [{ index: 0, item: {}, output: HOSTILE, status: 'success' }, { index: 1, item: {}, output: { ...HOSTILE, extra: 'x' }, status: 'success' }] };
        const real = buildRealOutputMap(def, [{ stepId: 'fe', output: envelope }]);
        const g = computeUpstreamGroups(def, 'dst', CATALOG, real).find((x: Group) => x.id === 'fe') as Group;
        const all = paths(g);
        expect(new Set(all).size).toBe(all.length);
        expect(g.fields.map(f => f.path)).toContain('steps.fe.output.results[*].output.extra');
        expect(field(g, 'steps.fe.output.iterations')?.sample).toBe(2);
        expect(field(g, 'steps.fe.output.results[*].output["Story Points"]')?.perIteration).toBe(true);
        for (const p of all) expect(getPath({ steps: { fe: { output: envelope } } }, p), p).not.toBeUndefined();
    });

    it('a Filter over rows with hostile keys offers quoted columns, from the union of the rows', () => {
        const rows = [null, { 'first-name': 'Ada' }, { 'first-name': 'Bob', 'Order ID': 7 }];
        const def = chain([
            { id: 'src', type: 'integration_action', tool: 'unknown' },
            { id: 'flt', type: 'filter', arrayRef: 'steps.src.output["line-items"]' },
        ]);
        const real = buildRealOutputMap(def, [{ stepId: 'src', output: { 'line-items': rows } }]);
        const g = computeUpstreamGroups(def, 'dst', CATALOG, real).find((x: Group) => x.id === 'flt') as Group;
        expect(paths(g)).toContain('steps.flt.output.items[*]["first-name"]');
        expect(paths(g)).toContain('steps.flt.output.items[*]["Order ID"]');
        const run = { steps: { flt: { output: { items: rows.slice(1), count: 2 } } } };
        expect(getPath(run, 'steps.flt.output.items[*]["Order ID"]')).toEqual([7]);
    });

    it('a Switch case named in plain words gets a quoted path, once, also after a run', () => {
        const def = chain([{ id: 'sw', type: 'switch', cases: [{ name: 'High priority' }, { name: 'low' }] }]);
        const g = computeUpstreamGroups(def, 'dst', CATALOG).find((x: Group) => x.id === 'sw') as Group;
        expect(paths(g)).toContain('steps.sw.output.matchesByCase["High priority"]');
        const real = { matched: 'low', value: 1, branch: 'case:low', matchesByCase: { 'High priority': [{ a: 1 }], low: [], default: [] } };
        const after = overlayGroupWithReal(g, real) as Group;
        const all = paths(after);
        expect(new Set(all).size).toBe(all.length);
        expect(all).toContain('steps.sw.output.matchesByCase["High priority"][*].a');
        expect(getPath({ steps: { sw: { output: real } } }, 'steps.sw.output.matchesByCase["High priority"]')).toEqual([{ a: 1 }]);
    });

    it('declared trigger inputs and form answers with spaces in their names are quoted; a file input opens', () => {
        const app = { id: 'trg', kind: 'app_trigger', params: [{ name: 'Order date', type: 'string' }, { name: 'doc', type: 'file' }] };
        const g = computeUpstreamGroups(chain([{ id: 'a', type: 'code' }], app), 'dst', CATALOG).find((x: Group) => x.id === 'trg') as Group;
        expect(paths(g)).toContain('trigger.output["Order date"]');
        expect(paths(g)).toContain('trigger.output.doc.url');
        const form = { id: 'trg', kind: 'form', form: { fields: [{ name: 'Your e-mail', type: 'email' }] } };
        const fg = computeUpstreamGroups(chain([{ id: 'a', type: 'code' }], form), 'dst', CATALOG).find((x: Group) => x.id === 'trg') as Group;
        expect(paths(fg)).toEqual(['trigger.output["Your e-mail"]']);
    });
});

describe('element fields are offered before any run', () => {
    it('a catalog list sample offers its columns', () => {
        const g = computeUpstreamGroups(chain([{ id: 'gs', type: 'integration_action', tool: 'gmail_search' }]), 'dst', CATALOG).find((x: Group) => x.id === 'gs') as Group;
        expect(paths(g)).toContain('steps.gs.output.results[*].subject');
    });

    it('a catalog trigger sample offers nested fields and list columns', () => {
        const trg = { id: 'trg', kind: 'app_event', appEvent: { provider: 'google-calendar', event: 'event.changed' } };
        const g = computeUpstreamGroups(chain([{ id: 'a', type: 'code' }], trg), 'dst', CATALOG).find((x: Group) => x.id === 'trg') as Group;
        expect(paths(g)).toContain('trigger.output.organizer.email');
        expect(paths(g)).toContain('trigger.output.attendees[*].email');
    });

    it('an AI step with a nested output schema offers its nested fields', () => {
        const outputSchema = {
            type: 'object',
            properties: {
                customer: { type: 'object', properties: { name: { type: 'string' }, address: { type: 'object', properties: { city: { type: 'string' } } } } },
                items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'number' } } } },
                'invoice-number': { type: 'string' },
                tags: { type: ['array', 'null'], items: { type: 'string' } },
            },
        };
        const g = computeUpstreamGroups(chain([{ id: 'ai', type: 'ai_step', outputSchema }]), 'dst', CATALOG).find((x: Group) => x.id === 'ai') as Group;
        expect(paths(g)).toEqual(expect.arrayContaining([
            'steps.ai.output.customer.name',
            'steps.ai.output.customer.address.city',
            'steps.ai.output.items[*].sku',
            'steps.ai.output.items[*].qty',
            'steps.ai.output["invoice-number"]',
        ]));
        expect(field(g, 'steps.ai.output.items[*].qty')?.sample).toBe(0);
        expect(Array.isArray(field(g, 'steps.ai.output.tags')?.sample)).toBe(true);
    });
});

describe('outputs that ARE a list', () => {
    it('a root list offers its base path with columns, and is a list to repeat over', () => {
        const def = chain([{ id: 'rl', type: 'integration_action', tool: 'unknown' }]);
        const real = buildRealOutputMap(def, [{ stepId: 'rl', output: [{ id: 1, name: 'A' }, { id: 2, name: 'B', extra: true }] }]);
        const groups = computeUpstreamGroups(def, 'dst', CATALOG, real) as Group[];
        const g = groups.find(x => x.id === 'rl');
        expect(paths(g)).toEqual(['steps.rl.output', 'steps.rl.output[*].id', 'steps.rl.output[*].name', 'steps.rl.output[*].extra']);
        expect(collectArrayPaths(groups, buildSampleRoot(groups)).map((a: Field) => a.path)).toContain('steps.rl.output');
    });

    it('a catalog sample that is a list does too, before a run', () => {
        const g = computeUpstreamGroups(chain([{ id: 'lt', type: 'integration_action', tool: 'list_tool' }]), 'dst', CATALOG).find((x: Group) => x.id === 'lt');
        expect(paths(g)).toEqual(['steps.lt.output', 'steps.lt.output[*].id', 'steps.lt.output[*].name']);
    });

    it('a Code step that returned a list offers its columns, and never its logs as a list', () => {
        const def = chain([{ id: 'code', type: 'code' }]);
        const out = { result: [{ name: 'Ada', address: { city: 'Delft' } }], logs: ['x', 'y'], httpCalls: 0 };
        const groups = computeUpstreamGroups(def, 'dst', CATALOG, buildRealOutputMap(def, [{ stepId: 'code', output: out }])) as Group[];
        expect(paths(groups.find(x => x.id === 'code'))).toEqual([
            'steps.code.output.result', 'steps.code.output.result[*].name', 'steps.code.output.result[*].address', 'steps.code.output.result[*].address.city',
        ]);
        const lists = collectArrayPaths(groups, buildSampleRoot(groups)).map((a: Field) => a.path);
        expect(lists).toContain('steps.code.output.result');
        expect(lists).not.toContain('steps.code.output.logs');
    });
});

describe('a list element is the union of its elements', () => {
    it('resolveElementSample skips nulls and scalars and merges keys', () => {
        const root = { steps: { s: { output: { rows: [null, 'x', { a: 1 }, { b: 2, a: null }] } } } };
        expect(resolveElementSample('steps.s.output.rows', root)).toEqual({ a: 1, b: 2 });
    });

    it('mergeElements keeps the first real value and opens nested records of every row', () => {
        expect(mergeElements([{ from: { name: 'A' } }, { from: { address: 'b@c.d' }, flag: 1 }])).toEqual({ from: { name: 'A', address: 'b@c.d' }, flag: 1 });
        expect(mergeElements([])).toBeNull();
        expect(mergeElements([null])).toBeNull();
    });
});

describe('keys: one quoting rule, and every key is pickable', () => {
    const KEYS = ['plain', 'content-type', 'a"b', "it's", 'both "q" and \'q\'', 'x]y', 'a}}b', 'back\\slash', 'new\nline', '', '0', '12', 'null', 'true', 'constructor', 'length', '日本語', '@odata.etag'];

    it('joinKeyPath writes what getPath reads back, for every key', () => {
        for (const k of KEYS) {
            expect(keyPickable(k), JSON.stringify(k)).toBe(true);
            expect(getPath({ root: { [k]: 'hit' } }, joinKeyPath('root', k)), JSON.stringify(k)).toBe('hit');
        }
    });
});
