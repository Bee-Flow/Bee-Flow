// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { appendKey, appendWildcard, canonicalPath, getPath, parsePath } from '@shared/expr/path.mjs';
import { computeUpstreamGroups as computeUpstreamGroupsJs, collectArrayPaths as collectArrayPathsJs } from './index';
import { FIELD_LIMITS, eachField, jsonTextValue, type Field } from './fieldTree';
import { DISCOVERY_FIXTURE, NESTED_TEXT_OUTPUT } from './fixtures/discovery';
import { buildRealOutputMap, buildSampleRoot } from '../realOutputs';
import { filterGroups } from '../filterFields';
import { describeField as describeFieldJs } from '../fieldKinds';

/**
 * The contract of field discovery, end to end: every path the builder offers
 * resolves with the RUNTIME's resolver (shared/expr/path.mjs getPath, which
 * server/automation/bind.js runs) to the value the builder previews, and no
 * leaf of the payload within the depth cap is left out.
 *
 * The payload is one awkward real-world output (fixtures/discovery.ts), seen
 * through every entry point that offers fields: a step that ran, the same data
 * as a catalog sample before any run, a Code step's result, a step that runs
 * once per item, and a trigger that fired.
 */

type Group = { id: string; kind?: string; basePath: string; fields: Field[]; sample?: unknown };

// The JS modules' `= null` defaults read as the parameters' whole type in TS.
const computeUpstreamGroups = computeUpstreamGroupsJs as (...args: unknown[]) => Group[];
const collectArrayPaths = collectArrayPathsJs as (...args: unknown[]) => Field[];
const describeField = describeFieldJs as (field: Field, root: unknown) => { value: unknown };

const FX = DISCOVERY_FIXTURE;
const ENVELOPE = {
    iterations: 2, succeeded: 2, failed: 0,
    results: [
        { index: 0, item: { n: 1 }, output: FX, status: 'success' },
        { index: 1, item: { n: 2 }, output: { gmail: { id: 'second' }, extraOnly: { 'only-here': 1 } }, status: 'success' },
    ],
};
const CODE_OUT = { result: FX, logs: ['ran'], httpCalls: 0 };
// A web call that answered text: the body is JSON text holding JSON text.
const HTTP_OUT = { status: 200, ok: true, headers: { 'content-type': 'text/plain' }, truncated: false, ...NESTED_TEXT_OUTPUT };

const DEF = {
    trigger: { id: 'trg', kind: 'webhook' },
    steps: [
        { id: 'src', type: 'integration_action', tool: 'no_catalog_entry', inputs: {} },
        { id: 'cat', type: 'integration_action', tool: 'fixture_tool', inputs: {} },
        { id: 'code', type: 'code', code: 'return x' },
        { id: 'fe', type: 'integration_action', tool: 'no_catalog_entry', inputs: {}, forEach: { overRef: 'steps.src.output.value', itemVar: 'msg' } },
        { id: 'http', type: 'http_request', url: 'https://x', method: 'GET', parseResponse: 'never' },
        { id: 'dst', type: 'notification', title: 'x' },
    ],
    edges: [
        { from: 'trg', to: 'src' }, { from: 'src', to: 'cat' }, { from: 'cat', to: 'code' },
        { from: 'code', to: 'fe' }, { from: 'fe', to: 'http' }, { from: 'http', to: 'dst' },
    ],
};
const CATALOG = {
    apps: [{ actions: [{ name: 'fixture_tool', outputSample: FX }] }],
    triggerOutputs: {},
};
const RUN = [
    { stepId: 'trg', output: FX },
    { stepId: 'src', output: FX },
    { stepId: 'code', output: CODE_OUT },
    { stepId: 'fe', output: ENVELOPE },
    { stepId: 'http', output: HTTP_OUT },
];
// What the run itself resolves against (runState): `cat` never ran, so its
// catalog sample is what a binding to it previews.
const RUNTIME = {
    trigger: { output: FX },
    steps: { src: { output: FX }, cat: { output: FX }, code: { output: CODE_OUT }, fe: { output: ENVELOPE }, http: { output: HTTP_OUT } },
};

const groups = computeUpstreamGroups(DEF, 'dst', CATALOG, buildRealOutputMap(DEF, RUN)) as Group[];
const byId = (id: string) => groups.find(g => g.id === id) as Group;

function allFields(gs: Group[]): Field[] {
    const out: Field[] = [];
    for (const g of gs) eachField(g.fields, f => out.push(f));
    return out;
}

const hasWildcard = (path: string) => (parsePath(path) || []).some((t: { type: string }) => t.type === 'wild');

/** Is `sample` (or every item of it, when it is a list) among what the column yields? */
function inColumn(column: unknown[], sample: unknown): boolean {
    const has = (x: unknown) => column.some(c => JSON.stringify(c) === JSON.stringify(x));
    if (Array.isArray(sample)) return JSON.stringify(sample) === JSON.stringify(column) || sample.every(has);
    return has(sample);
}

/**
 * Every leaf of a value within the depth cap, as the path the builder should
 * offer for it: lists contribute `[*]`, a list of plain values is offered as
 * the list itself, JSON text is read as what it encodes.
 */
function leafPaths(value: unknown, path: string, level: number, out: Set<string>): void {
    const parsed = jsonTextValue(value);
    if (parsed !== undefined) {
        out.add(path.replace(/(\[\*\])+$/, ''));
        leafPaths(parsed, path, level, out);
        return;
    }
    if (Array.isArray(value)) {
        const els = value.filter(v => v !== undefined);
        if (!els.length) out.add(path.replace(/(\[\*\])+$/, ''));
        for (const el of els) leafPaths(el, appendWildcard(path), level, out);
        return;
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value);
        if (!keys.length) out.add(path.replace(/(\[\*\])+$/, ''));
        if (level >= FIELD_LIMITS.depth) return;
        for (const k of keys) leafPaths((value as Record<string, unknown>)[k], appendKey(path, k), level + 1, out);
        return;
    }
    out.add(path.replace(/(\[\*\])+$/, ''));
}

describe('discovery round trip over an awkward real payload', () => {
    const fields = allFields(groups);

    it('offers fields through every entry point', () => {
        for (const id of ['trg', 'src', 'cat', 'code', 'fe', 'http']) expect(byId(id)?.fields.length, id).toBeGreaterThan(0);
        expect(fields.length).toBeGreaterThan(300);
    });

    it('every offered path is canonical and resolves at run time to what the field previews', () => {
        const failures: string[] = [];
        for (const f of fields) {
            if (canonicalPath(f.path) !== f.path) { failures.push(`not canonical: ${f.path}`); continue; }
            const live = getPath(RUNTIME, f.path);
            if (live === undefined) { failures.push(`undefined at run time: ${f.path}`); continue; }
            if (!hasWildcard(f.path)) {
                if (JSON.stringify(live) !== JSON.stringify(f.sample)) failures.push(`sample differs: ${f.path}`);
            } else if (!Array.isArray(live) || !inColumn(live, f.sample)) {
                failures.push(`sample not in column: ${f.path}`);
            }
        }
        expect(failures).toEqual([]);
    });

    it('the builder preview of every row is the run-time value', () => {
        const root = buildSampleRoot(groups);
        const failures: string[] = [];
        for (const f of fields) {
            const shown = describeField(f, root).value;
            const live = getPath(RUNTIME, f.path);
            if (JSON.stringify(shown) !== JSON.stringify(live)) failures.push(f.path);
        }
        expect(failures).toEqual([]);
    });

    it('no leaf of the payload within the depth cap is missing, for a run or a catalog sample', () => {
        for (const id of ['src', 'cat', 'trg']) {
            const g = byId(id);
            const offered = new Set<string>();
            eachField(g.fields, f => offered.add(f.path));
            const expected = new Set<string>();
            leafPaths(FX, g.basePath, 0, expected);
            const missing = [...expected].filter(p => !offered.has(p));
            expect(missing, id).toEqual([]);
        }
    });

});

describe('discovery reaches what real payloads hide', () => {
    const fields = allFields(groups);

    it('reaches the deep fields real APIs nest', () => {
        const paths = new Set(fields.map(f => f.path));
        for (const p of [
            'steps.src.output.value[*].from.emailAddress.address',
            'steps.src.output.gmail.payload.parts[*].parts[*].parts[*].body.attachmentId',
            'steps.src.output.jira.fields.issuelinks[*].outwardIssue.fields.status.name',
            'steps.src.output.jira.fields["Story Points"]',
            'steps.src.output.listOfLists[*].rows[*].cells[*].v',
            'steps.src.output.stripe.data.object.lines.data[*].price.recurring.interval',
            'steps.src.output.hubspot.results[*].associations.contacts.results[*].id',
            'steps.src.output.deep.l1.l2.l3.l4.l5.l6.l7',
            'steps.src.output["@odata.nextLink"]',
            'steps.src.output.keys["x]y"]',
            'steps.src.output.keys["a}b"]',
            'steps.src.output.keys["say \\"hi\\""]',
            'steps.src.output.keys["back\\\\slash"]',
            'steps.src.output.keys[""]',
            'steps.src.output.keys[0]',
            'steps.src.output.keys.constructor',
            'steps.src.output.hetero[*].b',
            'steps.src.output.hetero[*].c.d',
            'steps.src.output.nullFirst[*].extra.deeper',
            'steps.src.output.primFirst[*].k',
            'steps.code.output.result.value[*].from.emailAddress.address',
            'steps.fe.output.results[*].output.gmail.payload.headers',
            'steps.fe.output.results[*].output.extraOnly["only-here"]',
            'trigger.output.order.line_items[*].tax_lines[*].rate',
        ]) expect(paths.has(p), p).toBe(true);
    });

    it('opens JSON text as what it encodes, with plain paths', () => {
        const paths = new Map(fields.map(f => [f.path, f]));
        expect(paths.get('steps.src.output.http.body.data.items[*].name')?.sample).toBe('A');
        expect(paths.get('steps.src.output.ai.text.topics')?.sample).toEqual(['billing', 'refund']);
        expect(paths.get('steps.src.output.ai.raw.answer')?.sample).toBe(42);
        expect(paths.get('steps.src.output.listText[*].note')?.sample).toBe('gift');
        expect(paths.get('steps.src.output.twiceEncoded.inner.ok')?.sample).toBe(true);
    });

    it('reads JSON text inside JSON text, through lists, down to a fenced answer', () => {
        const paths = new Map(fields.map(f => [f.path, f]));
        const base = 'steps.http.output.body.data.payload';
        expect(paths.get(`${base}.items[*].sku`)?.sample).toBe('A1');
        expect(paths.get(`${base}.items[*].meta.tags`)?.sample).toEqual(['x', 'y']);
        expect(paths.get(`${base}.items[*].meta.ai.verdict.score`)?.sample).toBe(0.93);
        expect(paths.get(`${base}.items[*].meta.ai.verdict["reason code"]`)?.sample).toBe('R-7');
        expect(getPath(RUNTIME, `${base}.items[*].meta.ai.verdict["reason code"]`)).toEqual(['R-7']);
        expect(getPath(RUNTIME, `${base}.items[*].meta.tags`)).toEqual(['x', 'y', 'z']);
        const offered = new Set<string>();
        eachField(byId('http').fields, f => offered.add(f.path));
        const expected = new Set<string>();
        leafPaths(NESTED_TEXT_OUTPUT, 'steps.http.output', 0, expected);
        expect([...expected].filter(p => !offered.has(p))).toEqual([]);
    });

});

describe('discovery offers lists, entries and search over the same fields', () => {
    const fields = allFields(groups);

    it('offers each entry of a name/value list by its name', () => {
        const paths = new Map(fields.map(f => [f.path, f]));
        const subject = paths.get('steps.src.output.gmail.payload.headers[name="Subject"].value');
        expect(subject?.key).toBe('Subject');
        expect(subject?.sample).toBe('Report');
        // The runtime matches names without case: only the first "Received" is offered.
        expect(paths.get('steps.src.output.gmail.payload.headers[name="Received"].value')?.sample).toBe('from a');
        expect([...paths.keys()].filter(p => /headers\[name="received"\]/i.test(p) && p.startsWith('steps.src.output.gmail'))).toHaveLength(1);
        expect(paths.get('steps.src.output.Tags[Key="Owner"].Value')?.sample).toBe('ops');
        expect(paths.get('steps.src.output.value[*].internetMessageHeaders[name="X-Mailer"].value')?.sample).toBe('Outlook');
        // The list and its columns stay.
        expect(paths.has('steps.src.output.gmail.payload.headers')).toBe(true);
        expect(paths.has('steps.src.output.gmail.payload.headers[*].value')).toBe(true);
    });

    it('offers every list in the payload as something to repeat over, and only lists', () => {
        const lists = collectArrayPaths(groups, buildSampleRoot(groups)) as Array<{ path: string }>;
        for (const l of lists) expect(Array.isArray(getPath(RUNTIME, l.path)), l.path).toBe(true);
        const offered = new Set(lists.map(l => l.path));
        for (const p of [
            'steps.src.output.gmail.payload.headers',
            'steps.src.output.stripe.data.object.lines.data',
            'steps.src.output.hubspot.results[*].associations.contacts.results',
            'steps.src.output.jira.fields.issuelinks',
            'steps.src.output.value[*].toRecipients',
        ]) expect(offered.has(p), p).toBe(true);
        expect([...offered].some(p => p.startsWith('steps.code.output.logs'))).toBe(false);
    });

    it('search finds deep fields', () => {
        const hits = allFields(filterGroups(groups, 'address') as Group[]).map(f => f.path);
        expect(hits).toContain('steps.src.output.value[*].from.emailAddress.address');
        const story = allFields(filterGroups(groups, 'story points') as Group[]).map(f => f.path);
        expect(story).toContain('steps.src.output.jira.fields["Story Points"]');
    });
});
