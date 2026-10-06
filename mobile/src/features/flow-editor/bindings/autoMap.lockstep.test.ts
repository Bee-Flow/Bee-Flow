/**
 * DIFFERENTIAL lockstep: agent-hub `Builder/mapping/autoMapInputs.js` and the
 * port (autoMap + autoMapIteration + autoMapStep) map the same definitions the
 * same way. When this fails the web side changed — update the port, don't
 * loosen the test.
 */

import * as am from './autoMap';
import { sampleType, tryIterationMapping } from './autoMapIteration';
import { applyAutoMapToStep, autoMapStep } from './autoMapStep';
import { CATALOG, chainDefinition } from './testing/fixture';
import { BUILDER, requireWeb } from './testing/web';
import type { FlowDefinition, FlowNode } from './types';
import { computeUpstreamGroups } from './upstream';
import { computeLoopBodyGroups } from './upstream/groups';

const web = requireWeb(`${BUILDER}/mapping/autoMapInputs.js`);

beforeAll(() => {
    jest.useFakeTimers({ now: new Date('2026-03-01T10:00:00Z') });
});
afterAll(() => {
    jest.useRealTimers();
});

/** trigger → search → <step>, with `step` swapped in. */
function below(step: FlowNode, extraSteps: FlowNode[] = []): FlowDefinition {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'search', type: 'integration_action', tool: 'gmail_search' }, ...extraSteps, step],
        edges: [{ from: 'trg', to: 'search' }, { from: 'search', to: step.id }, { from: step.id, to: 'next', label: 'then' }, { from: step.id, to: 'other', label: 'else' }],
    };
}

const SCENARIOS: FlowNode[] = [
    { id: 'read', type: 'integration_action', tool: 'gmail_read' },
    { id: 'read2', type: 'integration_action', tool: 'gmail_read', inputs: { messageId: { kind: 'literal', value: 'set' } } },
    { id: 'read3', type: 'integration_action', tool: 'gmail_read', forEach: { overRef: 'x' } },
    { id: 'send', type: 'integration_action', tool: 'gmail_send', inputs: { subject: { kind: 'literal', value: '' } } },
    { id: 'unknownTool', type: 'integration_action', tool: 'nope', inputs: { query: null, total: { kind: 'ref', path: '' } } },
    { id: 'ai', type: 'ai_step', inputs: { query: { kind: 'literal', value: '' }, apiKey: null, other: null } },
    { id: 'ai0', type: 'ai_step' },
    { id: 'layer', type: 'call_layer', layerKey: 'sub', inputs: {} },
    { id: 'layerNone', type: 'call_layer', layerKey: 'nope', inputs: { total: null } },
    { id: 'guard', type: 'guard' },
    { id: 'guardSet', type: 'guard', sourceRef: 'steps.x.output' },
    { id: 'tok', type: 'tokenize', sourceRef: '  ' },
    { id: 'set', type: 'set' },
    { id: 'setFields', type: 'set', fields: { total: null, query: { kind: 'literal', value: 'kept' } } },
    { id: 'setBlankList', type: 'set', arrayRef: '' },
    { id: 'setOps', type: 'set', operations: [{ op: 'rowId' }], fields: {} },
    { id: 'loop', type: 'loop' },
    { id: 'loopLegacy', type: 'loop', overRef: 'trigger.output.items' },
    { id: 'loopSet', type: 'loop', overRef: 'steps.a.output.x' },
    { id: 'cond', type: 'condition', expr: 'true' },
    { id: 'condSet', type: 'condition', expr: 'x > 1' },
    { id: 'sw', type: 'switch', cases: [{ name: 'a' }] },
    { id: 'swList', type: 'switch', arrayRef: '', cases: [{ name: 'a' }] },
    { id: 'filter', type: 'filter' },
    { id: 'limit', type: 'limit', arrayRef: 'trigger.output.items' },
    { id: 'dedupe', type: 'dedupe', arrayRef: 'steps.custom.output.x' },
    { id: 'agg', type: 'aggregate' },
    { id: 'sum', type: 'summarize' },
    { id: 'flat', type: 'flatten', arrayRef: '' },
    { id: 'flatSet', type: 'flatten', arrayRef: 'steps.custom.output.x[*].y' },
    { id: 'code', type: 'code' },
];

describe('applyAutoMapToStep', () => {
    it('flatten below a list of mails with attachments picks the same route, plan and label', () => {
        const step = { id: 'flat', type: 'flatten', arrayRef: '', label: 'Flatten a list' } as FlowNode;
        const def = below(step);
        const mail = { id: 'm1', threadId: 't1', subject: 'Invoice', attachments: [{ attachmentId: 'a1', filename: 'a.pdf', messageId: 'm1' }] };
        const realOutputById = new Map<string, unknown>([['search', { messages: [mail], count: 1 }]]);
        const port = applyAutoMapToStep(def, step.id, CATALOG, { realOutputById });
        expect(port.definition.steps?.find((s) => s.id === 'flat')).toMatchObject({ arrayRef: 'steps.search.output.messages[*].attachments' });
        expect(port).toStrictEqual(web.applyAutoMapToStep?.(def, step.id, CATALOG, { realOutputById }));
    });


    it.each(SCENARIOS.map((s) => [s.id, s]))('%s below a list', (_id, step) => {
        const def = below(step);
        expect(applyAutoMapToStep(def, step.id, CATALOG)).toStrictEqual(web.applyAutoMapToStep?.(def, step.id, CATALOG));
        expect(autoMapStep(step, def, CATALOG, { maxPerStep: 1 })).toStrictEqual(web.autoMapStep?.(step, def, CATALOG, { maxPerStep: 1 }));
    });

    it.each(SCENARIOS.map((s) => [s.id, s]))('%s below a list with real outputs', (_id, step) => {
        const def = below(step);
        const realOutputById = new Map<string, unknown>([['search', { results: [{ messageId: 'r1', body: 'hello', id: 'x' }], total: 1 }]]);
        expect(applyAutoMapToStep(def, step.id, CATALOG, { realOutputById })).toStrictEqual(
            web.applyAutoMapToStep?.(def, step.id, CATALOG, { realOutputById }),
        );
    });

    it('every step of the fixture chain', () => {
        const def = chainDefinition();
        for (const s of def.steps || []) {
            expect(applyAutoMapToStep(def, s.id, CATALOG)).toStrictEqual(web.applyAutoMapToStep?.(def, s.id, CATALOG));
        }
    });

    it('guards', () => {
        const def = below({ id: 'x', type: 'code' });
        expect(applyAutoMapToStep(def, 'missing', CATALOG)).toStrictEqual(web.applyAutoMapToStep?.(def, 'missing', CATALOG));
        expect(autoMapStep(null, def, CATALOG)).toStrictEqual(web.autoMapStep?.(null, def, CATALOG));
        const lone: FlowDefinition = { steps: [{ id: 'a', type: 'loop' }] };
        expect(autoMapStep({ id: 'a', type: 'loop' }, lone, CATALOG)).toStrictEqual(web.autoMapStep?.({ id: 'a', type: 'loop' }, lone, CATALOG));
        const marked = below({ id: 'ai', type: 'ai_step', inputs: { query: null }, autoMapped: ['old'] });
        expect(applyAutoMapToStep(marked, 'ai', CATALOG)).toStrictEqual(web.applyAutoMapToStep?.(marked, 'ai', CATALOG));
    });
});

describe('the matching helpers', () => {
    const groups = computeUpstreamGroups(chainDefinition(), 'last', CATALOG);

    it('autoMapInputs over schemas and bare keys', () => {
        for (const app of CATALOG.apps || []) {
            for (const action of app.actions || []) {
                const schema = action?.inputSchema;
                expect(am.autoMapInputs(schema, {}, groups)).toStrictEqual(web.autoMapInputs?.(schema, {}, groups));
                expect(am.autoMapInputs(schema, { query: 'x' }, groups, { maxPerStep: 2 })).toStrictEqual(
                    web.autoMapInputs?.(schema, { query: 'x' }, groups, { maxPerStep: 2 }),
                );
            }
        }
        const bare = { subject: null, Subject: null, from_email: null, fromEmail: null, total: null, body: null, token: null };
        expect(am.autoMapInputs(null, bare, groups)).toStrictEqual(web.autoMapInputs?.(null, bare, groups));
        expect(am.autoMapInputs(null, bare, [])).toStrictEqual(web.autoMapInputs?.(null, bare, []));
        const typed = { properties: { total: { type: ['null', 'integer'] }, subject: { type: 'number' }, tags: { type: 'array' } } };
        expect(am.autoMapInputs(typed, null, groups)).toStrictEqual(web.autoMapInputs?.(typed, null, groups));
    });

    it('nearest array / scannable refs and small predicates', () => {
        for (let n = 0; n <= groups.length; n += 5) {
            const slice = groups.slice(0, n);
            expect(am.nearestArrayRef(slice)).toBe(web.nearestArrayRef?.(slice));
            expect(am.nearestScannableRef(slice)).toBe(web.nearestScannableRef?.(slice));
        }
        const onlyObjects = [{ id: 'x', label: 'x', kind: 'x', basePath: 'steps.x.output', sample: {}, fields: [{ key: 'n', path: 'p', sample: 1 }] }];
        expect(am.nearestScannableRef(onlyObjects)).toBe(web.nearestScannableRef?.(onlyObjects));
        expect(am.nearestScannableRef(null)).toBe(web.nearestScannableRef?.(null));
        expect(am.nearestArrayRef(null)).toBe(web.nearestArrayRef?.(null));
        for (const v of [null, undefined, [], {}, 'x', 1, true]) expect(sampleType(v)).toBe(web.sampleType?.(v));
        for (const k of ['From_Email', 'api-key', 'password', 'clientSecret', 'name', null]) {
            expect(am.normalizeKey(k)).toBe(web.normalizeKey?.(k));
            expect(am.isSecretLikeKey(k)).toBe(web.isSecretLikeKey?.(k));
        }
        for (const tool of ['gmail_read', 'nope']) {
            expect(am.findInputSchemaForTool(CATALOG, tool)).toStrictEqual(web.findInputSchemaForTool?.(CATALOG, tool));
        }
        expect(am.findInputSchemaForTool(null, 'x')).toBe(null);
    });

    // A step that already runs per mail gets the mail's own id only for a key
    // that names the mail, and only once (web autoMapInputs.ownItemId.test.ts).
    it.each([
        ['result', { channelId: 'string', text: 'string' }, {}],
        ['mail', { projectId: 'string', summary: 'string' }, {}],
        ['mail', { messageId: 'string', labelId: 'string' }, { messageId: { kind: 'ref', path: 'loop.mail.id' } }],
        ['mail', { messageId: 'string', labelId: 'string' }, { messageId: { kind: 'literal', value: 'abc' } }],
        ['mail', { messageId: 'string', mailId: 'string' }, { mailId: { kind: 'template', value: '{{ loop.mail.id }}' } }],
        ['mail', { messageId: 'string', note: 'string' }, { note: { kind: 'template', value: 'Re {{loop.mail.id}}' } }],
        ['email', { messageId: 'string' }, {}],
        ['message', { message_id: 'string' }, {}],
    ])('the own item %s and %j', (itemVar, props, inputs) => {
        const schema = { properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])), required: Object.keys(props) };
        const step: FlowNode = { id: 'own', type: 'integration_action', tool: 'x', inputs, forEach: { overRef: 'steps.search.output.results', itemVar, maxIterations: 100 } };
        const local = computeUpstreamGroups(below(step), 'own', CATALOG);
        const mine = am.autoMapInputs(schema, inputs, local);
        expect(mine).toStrictEqual(web.autoMapInputs?.(schema, inputs, local));
        const idKey = Object.keys(mine).find((k) => mine[k]?.path === `loop.${itemVar}.id`);
        const named = ['mail', 'email', 'message'].includes(itemVar) && !Object.keys(inputs).some((k) => /id$/i.test(k));
        expect(idKey ? [idKey] : []).toEqual(named ? Object.keys(props).filter((k) => /^message_?id$/i.test(k)) : []);
    });

    // A step connected below a list gets an element's `id` for `<x>Id` only
    // when the element IS an x (web autoMapIteration.entity.test.ts).
    const OUTPUTS: Record<string, unknown> = {
        messages: { messages: [{ id: 'm1', snippet: 'Hello', text: 'Hello there' }] },
        orders: { orders: [{ id: 'o1', total: 5, line_items: [{ id: 'li1', sku: 'A' }] }] },
        mails: { results: [{ id: 'm1', subject: 'Invoice', from: 'a@b.nl' }] },
        invoices: { data: [{ object: 'invoice', id: 'in_1' }] },
        envelopes: { results: [{ index: 0, item: {}, status: 'success', output: { id: 'm1', subject: 'x', threadId: 't1' } }] },
        anonymous: { results: [{ id: 'r1', title: 'x', customer: { id: 'c1' } }] },
    };
    const SCHEMAS: Record<string, string[]> = {
        slack: ['channelId', 'text'], jira: ['projectId', 'summary'], read: ['messageId'], order: ['orderId'],
        lines: ['orderId', 'lineItemId', 'sku'], invoice: ['invoiceId'], customer: ['customerId'],
    };
    it.each(Object.keys(OUTPUTS).flatMap((o) => Object.keys(SCHEMAS).map((sc) => [o, sc])))('connects %s → %s like the web', (o, sc) => {
        const props = SCHEMAS[sc] as string[];
        const catalog = {
            apps: [{ actions: [
                { name: 'source', outputSample: OUTPUTS[o] },
                { name: 'target', inputSchema: { properties: Object.fromEntries(props.map((k) => [k, { type: 'string' }])), required: props } },
            ] }],
            triggerOutputs: { __manual: { fields: [], sample: {} } },
        };
        const def: FlowDefinition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 's1', type: 'integration_action', tool: 'source', inputs: {} }, { id: 's2', type: 'integration_action', tool: 'target', inputs: {} }],
            edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
        };
        const mine = applyAutoMapToStep(def, 's2', catalog as never);
        expect(mine).toStrictEqual(web.applyAutoMapToStep?.(def, 's2', catalog));
        const inputs = (mine.definition.steps?.[1]?.inputs || {}) as Record<string, unknown>;
        expect(inputs.channelId).toBeUndefined();
        expect(inputs.projectId).toBeUndefined();
    });

    it('the iteration fallback on its own', () => {
        const def = below({ id: 'r', type: 'integration_action', tool: 'gmail_read' });
        const local = computeUpstreamGroups(def, 'r', CATALOG);
        const schema = { properties: { messageId: { type: 'string' } }, required: ['messageId'] };
        const webIter = requireWeb(`${BUILDER}/mapping/autoMapIteration.ts`);
        expect(tryIterationMapping(schema, {}, local)).toStrictEqual({
            patch: { messageId: { kind: 'ref', path: 'loop.result.id' } },
            forEach: { overRef: 'steps.search.output.results', itemVar: 'result', maxIterations: 100 },
        });
        expect(tryIterationMapping(schema, {}, local)).toStrictEqual(webIter.tryIterationMapping?.(schema, {}, local));
        expect(tryIterationMapping({ properties: {} }, {}, local)).toBe(null);
        expect(tryIterationMapping(schema, {}, [])).toBe(null);
        const noMatch = { properties: { zzz: { type: 'number' } }, required: ['zzz'] };
        expect(tryIterationMapping(noMatch, {}, local)).toBe(null);
    });
});

// A LIST input gets a column of an upstream list of records: Gmail "Read
// many" below "Search" gets `results[*].id` (web autoMapInputs.listColumn.test.ts).
describe('a list input and the columns of an upstream list', () => {
    const list = (items: Record<string, unknown> = { type: 'string' }) => ({ type: 'array', items });
    const mail = (id: string) => ({ id, to: 'me@x.nl', from: 'A <a@x.nl>', subject: `Invoice ${id}`, isBulk: false, precedence: null });
    const LIST_CATALOG = {
        apps: [{ actions: [
            { name: 'gmail_search', outputSample: { results: [mail('m1'), mail('m2')], total: 2 } },
            { name: 'gmail_read', inputSchema: { properties: { messageId: { type: 'string' } }, required: ['messageId'] },
                outputSample: { id: 'm1', threadId: 't1', from: 'a@x.nl', subject: 'x', attachments: [{ attachmentId: 'a1', messageId: 'm1' }] } },
            { name: 'gmail_read_many', inputSchema: { properties: { messageIds: list() }, required: ['messageIds'] },
                outputSample: { messages: [{ id: 'm1', threadId: 't1', from: 'a@x.nl', subject: 'x', attachments: [{ attachmentId: 'a1', messageId: 'm1' }] }], count: 1 } },
            { name: 'gmail_bulk_modify', inputSchema: { properties: { messageIds: list(), addLabelIds: list(), removeLabelIds: list(), markRead: { type: 'boolean' } }, required: ['messageIds'] } },
            { name: 'contacts', outputSample: { contacts: [{ id: 'c1', email: 'a@x.nl', subject: 'Hi' }], emails: ['a@x.nl'], sender: 'b@x.nl' } },
            { name: 'generic', inputSchema: { properties: { ids: list(), emails: list(), subjects: list(), channelIds: list(), recipients: list(), objs: list({ type: 'object' }), messageId: { type: 'string' } }, required: [] } },
            { name: 'people', outputSample: { contacts: [{ uid: 'u1', fullName: 'An', email: 'an@x.nl', phone: '06-1' }, { uid: 'u2', fullName: 'Bo', email: 'bo@x.nl', phone: '06-2' }] } },
            { name: 'contacts_update', inputSchema: { properties: { addressbook: { type: 'string' }, uid: { type: 'string' }, fullName: { type: 'string' }, emails: list(), phones: list() }, required: ['addressbook', 'uid'] } },
            { name: 'mail_with_attachments', outputSample: { messageId: 'm1', threadId: 't1', from: 'a@x.nl', subject: 'x', attachments: [{ attachmentId: 'a1', messageId: 'm1' }] } },
            { name: 'labels', outputSample: { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'L3', name: 'Work', type: 'user' }] } },
            { name: 'memory_search', inputSchema: { properties: { types: list({ type: 'string', enum: ['person', 'fact'] }) }, required: [] } },
        ] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };
    const step = (id: string, tool: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type: 'integration_action', tool, inputs: {}, ...extra });
    const chainOf = (steps: FlowNode[]): FlowDefinition => {
        const ids = ['trg', ...steps.map((s) => s.id)];
        return { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i] as string, to })) };
    };
    const perResult = { overRef: 'steps.search.output.results', itemVar: 'result', maxIterations: 100 };
    const pinned = { results: [mail('1a10f4ea7f6d46a2'), mail('1a0eb272a8c8478c')], total: 201, query: 'factuur' };
    const FLOWS: [string, FlowDefinition, Map<string, unknown> | null][] = [
        ['read many below search', chainOf([step('search', 'gmail_search'), step('many', 'gmail_read_many')]), null],
        ['read many below a pinned search', chainOf([step('search', 'gmail_search'), step('many', 'gmail_read_many')]), new Map([['search', pinned]])],
        ['bulk modify below search', chainOf([step('search', 'gmail_search'), step('many', 'gmail_bulk_modify')]), null],
        ['bulk modify below a per-mail read', chainOf([step('search', 'gmail_search'), step('rd', 'gmail_read', { inputs: { messageId: { kind: 'ref', path: 'loop.result.id' } }, forEach: perResult }), step('many', 'gmail_bulk_modify')]), null],
        ['bulk modify below read many', chainOf([step('search', 'gmail_search'), step('rm', 'gmail_read_many'), step('many', 'gmail_bulk_modify')]), null],
        ['bulk modify that runs per item', chainOf([step('search', 'gmail_search'), step('many', 'gmail_bulk_modify', { forEach: perResult })]), null],
        ['generic plurals', chainOf([step('c', 'contacts'), step('many', 'generic')]), null],
        ['generic plurals below mails', chainOf([step('search', 'gmail_search'), step('many', 'generic')]), null],
        // 8: decided per item first: a contact per run, never every contact's emails.
        ['contacts update below contacts', chainOf([step('p', 'people'), step('many', 'contacts_update')]), null],
        // 9-11: below ONE mail, not its attachments' messageId and not a farther list.
        ['bulk modify below one read mail', chainOf([step('search', 'gmail_search'), step('rd', 'gmail_read', { inputs: { messageId: { kind: 'ref', path: 'steps.search.output.results[0].id' } } }), step('many', 'gmail_bulk_modify')]), null],
        ['bulk modify below a read mail without attachments', chainOf([step('search', 'gmail_search'), step('rd', 'gmail_read', { inputs: { messageId: { kind: 'ref', path: 'steps.search.output.results[0].id' } } }), step('many', 'gmail_bulk_modify')]),
            new Map([['rd', { id: 'm1', threadId: 't1', from: 'a@x.nl', subject: 'x', attachments: [] }]])],
        ['read many below a new-mail shape', chainOf([step('m', 'mail_with_attachments'), step('many', 'gmail_read_many')]), null],
        // 12: a column whose values the input does not allow.
        ['memory types below labels', chainOf([step('l', 'labels'), step('many', 'memory_search')]), null],
    ];

    it.each(FLOWS)('%s maps like the web', (_label, def, realOutputById) => {
        const opts = realOutputById ? { realOutputById } : {};
        const catalog = LIST_CATALOG as never;
        expect(applyAutoMapToStep(def, 'many', catalog, opts)).toStrictEqual(web.applyAutoMapToStep?.(def, 'many', LIST_CATALOG, opts));
        const target = (def.steps || []).find((s) => s.id === 'many') as FlowNode;
        const groups = computeUpstreamGroups(def, 'many', catalog, realOutputById);
        const schema = am.findInputSchemaForTool(catalog, target.tool);
        expect(am.autoMapInputs(schema, target.inputs as Record<string, unknown>, groups)).toStrictEqual(web.autoMapInputs?.(schema, target.inputs, groups));
        expect(am.autoMapInputs(schema, {}, groups, { maxPerStep: 1 })).toStrictEqual(web.autoMapInputs?.(schema, {}, groups, { maxPerStep: 1 }));
    });

    it('the screenshot case and the rules it keeps', () => {
        const map = (i: number) => applyAutoMapToStep(FLOWS[i]?.[1] as FlowDefinition, 'many', LIST_CATALOG as never, FLOWS[i]?.[2] ? { realOutputById: FLOWS[i]?.[2] as Map<string, unknown> } : {});
        const inputsOf = (i: number) => (map(i).definition.steps?.find((s) => s.id === 'many')?.inputs || {}) as Record<string, unknown>;
        expect(inputsOf(1)).toStrictEqual({ messageIds: { kind: 'ref', path: 'steps.search.output.results[*].id' } });
        expect(inputsOf(2)).toStrictEqual({ messageIds: { kind: 'ref', path: 'steps.search.output.results[*].id' } });
        expect(inputsOf(3)).toStrictEqual({ messageIds: { kind: 'ref', path: 'steps.rd.output.results[*].output.id' } });
        expect(inputsOf(4)).toStrictEqual({ messageIds: { kind: 'ref', path: 'steps.rm.output.messages[*].id' } });
        expect(inputsOf(5).messageIds).toBeUndefined();
        expect(inputsOf(6)).toStrictEqual({
            emails: { kind: 'ref', path: 'steps.c.output.emails' },
            ids: { kind: 'ref', path: 'steps.c.output.contacts[*].id' },
            subjects: { kind: 'ref', path: 'steps.c.output.contacts[*].subject' },
        });
        expect(Object.keys(inputsOf(7)).sort()).toStrictEqual(['ids', 'subjects']);
    });

    it('never every row for a step that runs per item, below one mail, or outside the allowed values', () => {
        const map = (i: number) => applyAutoMapToStep(FLOWS[i]?.[1] as FlowDefinition, 'many', LIST_CATALOG as never, FLOWS[i]?.[2] ? { realOutputById: FLOWS[i]?.[2] as Map<string, unknown> } : {});
        const stepOf = (i: number) => map(i).definition.steps?.find((s) => s.id === 'many') as FlowNode;
        expect(stepOf(8).forEach).toMatchObject({ overRef: 'steps.p.output.contacts', itemVar: 'contact' });
        expect(stepOf(8).inputs).toStrictEqual({ uid: { kind: 'ref', path: 'loop.contact.uid' }, fullName: { kind: 'ref', path: 'loop.contact.fullName' } });
        for (const i of [9, 10, 11, 12]) expect(map(i).mappedKeys).toStrictEqual([]);
    });

    it('a step inside a Loop body takes no column from outside the loop (a batch is its own column)', () => {
        const def = chainOf([step('search', 'gmail_search')]);
        const outerGroups = computeUpstreamGroups({ ...def, steps: [...(def.steps || []), step('lp', 'x')], edges: [...(def.edges || []), { from: 'search', to: 'lp' }] }, 'lp', LIST_CATALOG as never, null);
        const previewSample = { steps: { search: { output: pinned } } };
        const schema = am.findInputSchemaForTool(LIST_CATALOG as never, 'gmail_bulk_modify');
        for (const batchSize of [1, 5]) {
            const loop = { id: 'lp', type: 'loop', overRef: 'steps.search.output.results', itemVar: 'result', batchSize, body: [step('b', 'gmail_bulk_modify')] } as FlowNode;
            const groups = computeLoopBodyGroups(loop, 0, { outerGroups, previewSample, catalog: LIST_CATALOG as never, definition: def });
            const patch = am.autoMapInputs(schema, {}, groups);
            expect(patch).toStrictEqual(web.autoMapInputs?.(schema, {}, groups));
            expect(patch).toStrictEqual(batchSize > 1 ? { messageIds: { kind: 'ref', path: 'loop.result[*].id' } } : {});
        }
    });
});
