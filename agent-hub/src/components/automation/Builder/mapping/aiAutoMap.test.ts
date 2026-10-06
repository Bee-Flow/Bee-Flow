/**
 * Auto-map's AI fallback, the editor half (aiAutoMap.ts).
 *
 * Pinned here: WHEN the AI is asked (only for empty inputs, only while a
 * required one is empty or nothing is mapped), WHAT goes out (bounded
 * samples from the offered upstream groups, paths but never typed values of
 * inputs already set), WHAT comes back in (only still-empty inputs, only
 * bindings the editor draws as pills), and that a refusal is silent and
 * stops further asking for a while.
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/mapping/aiAutoMap.test.ts
 */
import { getPath } from '@shared/expr/path.mjs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    acceptSuggestions, aiAutoMap, aiTargets, boundSample, buildSuggestRequest, essentialFromSchema,
    fillEmpty, mappedContext, paramsFromContract, paramsFromSchema, resetAiAutoMapAvailability, sourcesFromGroups,
} from './aiAutoMap';
import type { AiParam, SuggestMappingsRequest } from './aiAutoMap';

const MAIL = {
    value: [{
        id: 'm1',
        subject: 'Invoice 2026-031',
        from: { emailAddress: { name: 'Jan', address: 'jan@contoso.nl' } },
        internetMessageHeaders: [{ name: 'Subject', value: 'Invoice 2026-031' }, { name: 'X-Priority', value: '1' }],
    }],
};

const GROUPS = [
    { id: 'trg', kind: 'trigger', label: 'Trigger (manual)', basePath: 'trigger.output', sample: { note: '<string>' } },
    { id: 'g1', kind: 'integration_action', label: 'Get mail', basePath: 'steps.g1.output', sample: MAIL, hasRealData: true },
];

const SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string', title: 'Title', description: 'Task title' },
        assignee: { type: 'string', format: 'email' },
        priority: { type: 'string', enum: ['low', 'high'] },
        dueDate: { type: 'string', format: 'date-time' },
        apiToken: { type: 'string' },
        internalRef: { type: 'string', 'x-advanced': true },
    },
    required: ['title', 'assignee', 'apiToken'],
};

const ref = (path: string) => ({ kind: 'ref' as const, path });

beforeEach(() => resetAiAutoMapAvailability());

describe('which inputs the AI is asked about', () => {
    const params = paramsFromSchema(SCHEMA);

    it('reads type, format, enum and required off the schema', () => {
        const byKey = Object.fromEntries(params.map(p => [p.key, p]));
        expect(byKey.assignee).toMatchObject({ type: 'string', format: 'email', required: true });
        expect(byKey.priority.enum).toEqual(['low', 'high']);
        expect(byKey.title).toMatchObject({ title: 'Title', description: 'Task title', required: true });
        expect(paramsFromContract([{ name: 'iban', type: 'string', required: true }])).toEqual([
            { key: 'iban', type: 'string', description: null, required: true },
        ]);
    });

    it('asks while a required input is empty: the empty required ones and the optional ones the form shows', () => {
        const inputs = { title: ref('steps.g1.output.value[0].subject') };
        const keys = aiTargets(params, inputs, essentialFromSchema(SCHEMA, inputs)).map(p => p.key);
        // apiToken is secret-like: never asked. internalRef sits behind "Show more".
        expect(keys).toEqual(['assignee']);
        expect(aiTargets(params, inputs, null).map(p => p.key)).toEqual(['assignee', 'priority', 'dueDate', 'internalRef']);
    });

    it('does not ask once the required inputs have a value and something is mapped', () => {
        const inputs = { title: ref('a.b'), assignee: ref('a.c'), apiToken: { kind: 'literal', value: 'x' } };
        expect(aiTargets(params, inputs, null)).toEqual([]);
    });

    it('asks when nothing is mapped at all, even without required inputs', () => {
        const optional: AiParam[] = [{ key: 'note', type: 'string' }, { key: 'tag', type: 'string' }];
        expect(aiTargets(optional, {}, null).map(p => p.key)).toEqual(['note', 'tag']);
        expect(aiTargets(optional, { note: ref('x.y') }, null)).toEqual([]);
    });
});

describe('what goes out', () => {
    it('sources are the offered groups with a valid root, nearest last, real data marked', () => {
        const sources = sourcesFromGroups([
            ...GROUPS,
            { label: 'Expanded flowlet step', basePath: 'steps.c1/s2.output', sample: { a: 1 } },
            { label: 'Too big', basePath: 'steps.big.output', sample: { __truncated__: true, originalBytes: 9e6 } },
            { label: 'Nothing yet', basePath: 'steps.empty.output', sample: {} },
            { label: 'Each mail', basePath: 'loop.item', sample: MAIL.value[0] },
        ]);
        expect(sources.map(s => [s.root, s.real])).toEqual([
            ['trigger.output', false], ['steps.g1.output', true], ['loop.item', false],
        ]);
        expect(sources[1].sample).toEqual(MAIL);
    });

    it('far steps are left out before the request grows past what the server takes', () => {
        const big = (i: number) => ({ label: `Step ${i}`, basePath: `steps.s${i}.output`, sample: { rows: Array.from({ length: 50 }, () => 'x'.repeat(1900)) } });
        const sources = sourcesFromGroups(Array.from({ length: 10 }, (_, i) => big(i)));
        expect(sources.map(s => s.root)).toEqual(['steps.s5.output', 'steps.s6.output', 'steps.s7.output', 'steps.s8.output', 'steps.s9.output']);
        expect(JSON.stringify(sources).length).toBeLessThan(600_000);
    });

    it('of two triggers the one with real data wins the trigger slot', () => {
        const sources = sourcesFromGroups([
            { label: 'Form', basePath: 'trigger.output', sample: { name: '<string>' } },
            { label: 'Webhook', basePath: 'trigger.output', sample: { body: { id: 7 } }, hasRealData: true },
        ]);
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({ label: 'Webhook', real: true });
    });

    it('samples are bounded; JSON text stays JSON text, so paths into it still resolve', () => {
        const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, text: 'x'.repeat(300) })), body: JSON.stringify({ data: { items: [{ id: 'a' }] } }) };
        const out = boundSample(big) as { rows: unknown[]; body: string };
        expect(JSON.stringify(out).length).toBeLessThanOrEqual(150_000);
        expect(out.rows.length).toBeLessThan(5000);
        expect(JSON.parse(out.body)).toEqual({ data: { items: [{ id: 'a' }] } });
    });

    it('JSON text inside JSON text (down to a fenced AI answer) is bounded level by level and every path still resolves', () => {
        // The fixture of shared/expr/path.test.mjs, with a long list beside it.
        const lvl3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
        const lvl2 = JSON.stringify({
            items: [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: lvl3 }) }, { sku: 'B2', meta: '{"tags":["z"]}' }],
            noise: Array.from({ length: 3000 }, (_, i) => ({ i, text: 'n'.repeat(200) })),
        });
        const sample = { body: JSON.stringify({ data: { payload: lvl2 } }) };
        const root = { steps: { http: { output: boundSample(sample) } } };
        expect(JSON.stringify(root.steps.http.output).length).toBeLessThanOrEqual(150_000);
        const base = 'steps.http.output.body.data.payload';
        expect(typeof getPath(root, 'steps.http.output.body')).toBe('string');
        expect(getPath(root, `${base}.items[0].sku`)).toBe('A1');
        expect(getPath(root, `${base}.items[0].meta.tags[1]`)).toBe('y');
        expect(getPath(root, `${base}.items[0].meta.ai.verdict.score`)).toBe(0.93);
        expect(getPath(root, `${base}.items[0].meta.ai.verdict["reason code"]`)).toBe('R-7');
        expect(getPath(root, `${base}.items[*].meta.tags`)).toEqual(['x', 'y', 'z']);
        expect(getPath(root, `${base}.items[sku="B2"].meta.tags[0]`)).toBe('z');
    });

    it('inputs that already have a value go as the fields they read, never as what was typed', () => {
        const ctx = mappedContext({
            body: { kind: 'template', value: 'Dear {{steps.g1.output.value[0].from.emailAddress.name}}, call me' },
            to: ref('steps.g1.output.value[0].from.emailAddress.address'),
            secretNote: { kind: 'literal', value: 'my private text' },
            empty: { kind: 'literal', value: '' },
        }, new Set());
        expect(ctx).toEqual([
            { key: 'body', kind: 'template', paths: ['steps.g1.output.value[0].from.emailAddress.name'] },
            { key: 'to', kind: 'ref', paths: ['steps.g1.output.value[0].from.emailAddress.address'] },
            { key: 'secretNote', kind: 'literal', paths: [] },
        ]);
        expect(JSON.stringify(ctx)).not.toContain('my private text');
    });

    it('no request without inputs to fill or data to map from', () => {
        const params = paramsFromSchema(SCHEMA);
        expect(buildSuggestRequest({ params: [], inputs: {}, groups: GROUPS })).toBeNull();
        expect(buildSuggestRequest({ params, inputs: {}, groups: [] })).toBeNull();
        const body = buildSuggestRequest({ params: params.slice(0, 1), inputs: {}, groups: GROUPS, step: { label: 'Create task', tool: 'planner_create_task' } });
        expect(body?.step).toEqual({ label: 'Create task', tool: 'planner_create_task' });
        // Nulls are left out: the server refuses keys it does not know, not nulls,
        // but a smaller body is a smaller body.
        expect(body?.params[0]).toEqual({ key: 'title', type: 'string', title: 'Title', description: 'Task title', required: true });
    });
});

describe('what comes back in', () => {
    const params = paramsFromSchema(SCHEMA);
    const answer = {
        suggestions: [
            { key: 'title', binding: { kind: 'template', value: 'Invoice: {{steps.g1.output.value[0].subject}}' }, reason: 'The subject' },
            { key: 'assignee', binding: ref('steps.g1.output.value[0].from.emailAddress.address'), reason: 'The sender' },
            { key: 'priority', binding: { kind: 'expr', value: 'lower(steps.g1.output.value[0].internetMessageHeaders[name="X-Priority"].value)' } },
            { key: 'dueDate', binding: { kind: 'expr', value: 'steps.g1.output.a + steps.g1.output.b' } },
            { key: 'nope', binding: ref('steps.g1.output.value[0].id') },
        ],
    };

    it('keeps pill-shaped bindings for asked, still-empty inputs; drops raw formulas and strangers', () => {
        const { patch, keys, reasons } = acceptSuggestions(answer, { params, inputs: {} });
        expect(keys).toEqual(['title', 'assignee', 'priority']);
        expect(patch.assignee).toEqual(ref('steps.g1.output.value[0].from.emailAddress.address'));
        expect(reasons).toEqual({ title: 'The subject', assignee: 'The sender' });
    });

    it('never overwrites an input that has a value', () => {
        const mine = { kind: 'literal', value: 'My own title' };
        const { keys } = acceptSuggestions(answer, { params, inputs: { title: mine } });
        expect(keys).not.toContain('title');
        const { next, keys: filled } = fillEmpty({ title: mine }, { title: ref('x.y'), assignee: ref('a.b') });
        expect(next).toEqual({ title: mine, assignee: ref('a.b') });
        expect(filled).toEqual(['assignee']);
    });

    it('an answer that is not a list yields nothing', () => {
        expect(acceptSuggestions(null, { params, inputs: {} }).keys).toEqual([]);
        expect(acceptSuggestions({ suggestions: 'x' }, { params, inputs: {} }).keys).toEqual([]);
    });
});

describe('asking', () => {
    const params = paramsFromSchema(SCHEMA).filter(p => p.key === 'title' || p.key === 'assignee');

    it('sends one request and returns the verified patch', async () => {
        const sent: SuggestMappingsRequest[] = [];
        const api = { suggestMappings: async (body: SuggestMappingsRequest) => { sent.push(body); return { suggestions: [{ key: 'title', binding: ref('steps.g1.output.value[0].subject') }] }; } };
        const out = await aiAutoMap({ api, params, inputs: {}, groups: GROUPS });
        expect(sent).toHaveLength(1);
        expect(sent[0].params.map(p => p.key)).toEqual(['title', 'assignee']);
        expect(sent[0].sources.map(s => s.root)).toEqual(['trigger.output', 'steps.g1.output']);
        expect(out).toMatchObject({ status: 'ok', keys: ['title'] });
    });

    it('a refusal is silent, and an organisation without the AI is not asked again', async () => {
        let calls = 0;
        const api = { suggestMappings: async () => { calls += 1; throw Object.assign(new Error('off'), { status: 403 }); } };
        expect(await aiAutoMap({ api, params, inputs: {}, groups: GROUPS })).toMatchObject({ status: 'unavailable', keys: [] });
        expect(await aiAutoMap({ api, params, inputs: {}, groups: GROUPS })).toMatchObject({ status: 'unavailable' });
        expect(calls).toBe(1);
    });

    it('rate-limited or offline pauses the asking, it does not end it', async () => {
        let calls = 0;
        const api = { suggestMappings: async () => { calls += 1; throw Object.assign(new Error('slow down'), { status: 429 }); } };
        await aiAutoMap({ api, params, inputs: {}, groups: GROUPS });
        await aiAutoMap({ api, params, inputs: {}, groups: GROUPS });
        expect(calls).toBe(1);
        resetAiAutoMapAvailability();
        await aiAutoMap({ api, params, inputs: {}, groups: GROUPS });
        expect(calls).toBe(2);
    });

    it('nothing to map from is not a request', async () => {
        let calls = 0;
        const api = { suggestMappings: async () => { calls += 1; return {}; } };
        expect(await aiAutoMap({ api, params, inputs: {}, groups: [] })).toMatchObject({ status: 'skipped' });
        expect(await aiAutoMap({ api: null, params, inputs: {}, groups: GROUPS })).toMatchObject({ status: 'unavailable' });
        expect(calls).toBe(0);
    });
});
