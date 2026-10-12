/**
 * The phone's field discovery over the web's awkward real payload
 * (agent-hub `mapping/upstream/fixtures/discovery.ts`): every path offered
 * resolves with the RUNTIME's resolver to the value it previews, no leaf
 * within the depth cap is missing, and the groups are exactly the web's.
 */

import { appendKey, appendWildcard, canonicalPath, getPath, parsePath } from '@/shared/expr';

import { buildRealOutputMap } from '../realOutputs';
import { BUILDER, requireWeb, webValue } from '../testing/web';
import type { FlowDefinition, VariableField, VariableGroup } from '../types';
import { eachField, FIELD_LIMITS, jsonTextValue } from './fieldTree';
import * as up from './index';

const fixtures = requireWeb(`${BUILDER}/mapping/upstream/fixtures/discovery.ts`);
const web = requireWeb(`${BUILDER}/mapping/upstream/index.js`);
const webOutputs = requireWeb(`${BUILDER}/mapping/realOutputs.js`);
const FX = webValue<Record<string, unknown>>(fixtures, 'DISCOVERY_FIXTURE');
const NESTED = webValue<Record<string, unknown>>(fixtures, 'NESTED_TEXT_OUTPUT');

const ENVELOPE = {
    iterations: 2, succeeded: 2, failed: 0,
    results: [
        { index: 0, item: { n: 1 }, output: FX, status: 'success' },
        { index: 1, item: { n: 2 }, output: { gmail: { id: 'second' }, extraOnly: { 'only-here': 1 } }, status: 'success' },
    ],
};
const CODE_OUT = { result: FX, logs: ['ran'], httpCalls: 0 };
const HTTP_OUT = { status: 200, ok: true, headers: { 'content-type': 'text/plain' }, truncated: false, ...NESTED };

const DEF: FlowDefinition = {
    trigger: { id: 'trg', kind: 'webhook' },
    steps: [
        { id: 'src', type: 'integration_action', tool: 'no_catalog_entry' },
        { id: 'cat', type: 'integration_action', tool: 'fixture_tool' },
        { id: 'code', type: 'code' },
        { id: 'fe', type: 'integration_action', tool: 'no_catalog_entry', forEach: { overRef: 'steps.src.output.value', itemVar: 'msg' } },
        { id: 'http', type: 'http_request', parseResponse: 'never' },
        { id: 'dst', type: 'notification', title: 'x' },
    ],
    edges: [
        { from: 'trg', to: 'src' }, { from: 'src', to: 'cat' }, { from: 'cat', to: 'code' },
        { from: 'code', to: 'fe' }, { from: 'fe', to: 'http' }, { from: 'http', to: 'dst' },
    ],
};
const CATALOG = { apps: [{ actions: [{ name: 'fixture_tool', outputSample: FX }] }], triggerOutputs: {} };
const RUN = [
    { stepId: 'trg', output: FX },
    { stepId: 'src', output: FX },
    { stepId: 'code', output: CODE_OUT },
    { stepId: 'fe', output: ENVELOPE },
    { stepId: 'http', output: HTTP_OUT },
];
const RUNTIME = {
    trigger: { output: FX },
    steps: { src: { output: FX }, cat: { output: FX }, code: { output: CODE_OUT }, fe: { output: ENVELOPE }, http: { output: HTTP_OUT } },
};

const real = buildRealOutputMap(DEF, RUN);
const groups = up.computeUpstreamGroups(DEF, 'dst', CATALOG, real);
const byId = (id: string) => groups.find((g) => g.id === id) as VariableGroup;

function allFields(gs: VariableGroup[]): VariableField[] {
    const out: VariableField[] = [];
    for (const g of gs) eachField(g.fields, (f) => out.push(f));
    return out;
}

const hasWildcard = (path: string) => (parsePath(path) || []).some((t) => t.type === 'wild');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function inColumn(column: unknown[], sample: unknown): boolean {
    const has = (x: unknown) => column.some((c) => same(c, x));
    if (Array.isArray(sample)) return same(sample, column) || sample.every(has);
    return has(sample);
}

const strip = (p: string) => p.replace(/(\[\*\])+$/, '');

/** Every leaf within the depth cap, as the path the builder should offer for it. */
function leafPaths(value: unknown, path: string, level: number, out: Set<string>): void {
    const parsed = jsonTextValue(value);
    if (parsed !== undefined) {
        out.add(strip(path));
        leafPaths(parsed, path, level, out);
        return;
    }
    if (Array.isArray(value)) {
        const els = value.filter((v) => v !== undefined);
        if (!els.length) out.add(strip(path));
        for (const el of els) leafPaths(el, appendWildcard(path), level, out);
        return;
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value);
        if (!keys.length) out.add(strip(path));
        if (level >= FIELD_LIMITS.depth) return;
        for (const k of keys) leafPaths((value as Record<string, unknown>)[k], appendKey(path, k), level + 1, out);
        return;
    }
    out.add(strip(path));
}

describe('discovery on the phone, over an awkward real payload', () => {
    const fields = allFields(groups);

    it('is the web discovery, field for field', () => {
        const webReal = webOutputs.buildRealOutputMap?.(DEF, RUN);
        expect(groups).toStrictEqual(web.computeUpstreamGroups?.(DEF, 'dst', CATALOG, webReal));
        expect(up.collectArrayPaths(groups, RUNTIME)).toStrictEqual(web.collectArrayPaths?.(groups, RUNTIME));
    });

    it('offers only canonical paths that resolve at run time to what they preview', () => {
        expect(fields.length).toBeGreaterThan(300);
        const failures: string[] = [];
        for (const f of fields) {
            if (canonicalPath(f.path) !== f.path) { failures.push(`not canonical: ${f.path}`); continue; }
            const live = getPath(RUNTIME, f.path);
            if (live === undefined) failures.push(`undefined at run time: ${f.path}`);
            else if (!hasWildcard(f.path) ? !same(live, f.sample) : !(Array.isArray(live) && inColumn(live, f.sample))) failures.push(`sample: ${f.path}`);
        }
        expect(failures).toEqual([]);
    });

    it('misses no leaf within the depth cap', () => {
        for (const [id, value] of [['src', FX], ['cat', FX], ['trg', FX], ['http', HTTP_OUT]] as const) {
            const g = byId(id);
            const offered = new Set<string>();
            eachField(g.fields, (f) => offered.add(f.path));
            const expected = new Set<string>();
            leafPaths(value, g.basePath, 0, expected);
            expect([...expected].filter((p) => !offered.has(p))).toEqual([]);
        }
    });

    it('reads JSON text inside JSON text and names name/value entries', () => {
        const paths = new Map(fields.map((f) => [f.path, f]));
        expect(paths.get('steps.http.output.body.data.payload.items[*].meta.ai.verdict["reason code"]')?.sample).toBe('R-7');
        expect(paths.get('steps.src.output.gmail.payload.headers[name="Subject"].value')?.sample).toBe('Report');
        expect(paths.get('steps.src.output.Tags[Key="Owner"].Value')?.sample).toBe('ops');
    });
});

describe('the outer item of a per-inner-item step', () => {
    it('is offered just before the current item, as on the web', () => {
        const catalog = {
            apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ id: 'm1', subject: 'Invoice', attachments: [{ attachmentId: 'a1' }] }] } }] }],
            triggerOutputs: {},
        };
        const def: FlowDefinition = {
            trigger: { id: 'trg', kind: 'manual' },
            steps: [
                { id: 'search', type: 'integration_action', tool: 'gmail_search' },
                {
                    id: 'save', type: 'integration_action', tool: 'x',
                    forEach: { overRef: 'steps.search.output.results[*].attachments', itemVar: 'attachment', parents: [{ itemVar: 'result', overRef: 'steps.search.output.results' }] },
                },
            ],
            edges: [{ from: 'trg', to: 'search' }, { from: 'search', to: 'save' }],
        };
        const mine = up.computeUpstreamGroups(def, 'save', catalog);
        expect(mine).toStrictEqual(web.computeUpstreamGroups?.(def, 'save', catalog));
        const bases = mine.map((g) => g.basePath);
        expect(bases[bases.indexOf('loop.result') + 1]).toBe('loop.attachment');
    });
});
