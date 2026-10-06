/**
 * Auto-map on messy, real-world shapes: deep keys, JSON text, wrapper keys,
 * any key spelling, name/value lists, and lists inside lists. Every path it
 * binds is checked against the RUNTIME's walker, so "mapped" means "the run
 * gets that value".
 */
import { describe, expect, it } from 'vitest';
import { autoMapInputs as autoMapInputsJs, autoMapStep, nearestArrayRef } from './autoMapInputs';
import { computeUpstreamGroups } from './upstream';

const { walkPath, resolveInputs } = require('../../../../../../server/automation/bind');
const { execForEachStep } = require('../../../../../../server/core/automationRunner/execFlow');

// A JS module: its result types as `{}`; a patch maps an input to a ref.
type Patch = Record<string, { kind: string; path: string }>;
const autoMapInputs = (...a: Parameters<typeof autoMapInputsJs>) => autoMapInputsJs(...a) as Patch;

type Group = { id: string; label: string; kind: string; basePath: string; sample: unknown; fields: Array<{ key: string; path: string; sample: unknown }> };
/** A group as a describer would build it for a step that ran: top-level fields only, the sample in full. */
function stepGroup(id: string, output: Record<string, unknown>, kind = 'integration_action'): Group {
    const basePath = `steps.${id}.output`;
    return {
        id, label: id, kind, basePath, sample: output,
        fields: Object.entries(output).map(([key, sample]) => ({ key, path: `${basePath}${/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`}`, sample })),
    };
}
const rootOf = (groups: Group[]) => ({ steps: Object.fromEntries(groups.map(g => [g.id, { output: g.sample }])) });
const schema = (props: Record<string, string>, required: string[] = []) => ({
    properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])), required,
});

describe('deep and ugly shapes', () => {
    // A JSON:API answer that came back as TEXT, under the usual wrappers.
    const http = stepGroup('http', {
        status: 200,
        body: JSON.stringify({ data: { id: 'c-9', type: 'contacts', attributes: { 'first-name': 'Ann', 'Last Name': 'de Vries', email: 'ann@example.nl', 'Prénom': 'Anne' } } }),
    }, 'http_request');

    it('reaches keys inside JSON text and under wrapper keys, in any spelling', () => {
        const patch = autoMapInputs(schema({ email: 'string', firstName: 'string', last_name: 'string', prenom: 'string' }), {}, [http]);
        expect(patch).toEqual({
            email: { kind: 'ref', path: 'steps.http.output.body.data.attributes.email' },
            firstName: { kind: 'ref', path: 'steps.http.output.body.data.attributes["first-name"]' },
            last_name: { kind: 'ref', path: 'steps.http.output.body.data.attributes["Last Name"]' },
            prenom: { kind: 'ref', path: 'steps.http.output.body.data.attributes["Prénom"]' },
        });
        const root = rootOf([http]);
        expect(walkPath(patch.firstName.path, root)).toBe('Ann');
        expect(walkPath(patch.last_name.path, root)).toBe('de Vries');
        expect(walkPath(patch.prenom.path, root)).toBe('Anne');
    });

    it('the nearest step wins, however deep its field sits', () => {
        const far = stepGroup('crm', { email: 'old@example.nl' });
        const patch = autoMapInputs(schema({ email: 'string' }), {}, [far, http]);
        expect(patch.email.path).toBe('steps.http.output.body.data.attributes.email');
    });

    it('a wrapper does not make a field farther than its sibling', () => {
        const g = stepGroup('s', { meta: { owner: { email: 'meta@x.nl' } }, data: { email: 'data@x.nl' } });
        expect(autoMapInputs(schema({ email: 'string' }), {}, [g]).email.path).toBe('steps.s.output.data.email');
    });

    it('a name/value list: "subject" is the Subject header\'s value', () => {
        const mail = stepGroup('raw', {
            id: 'm1',
            payload: { headers: [{ name: 'From', value: 'a@x.nl' }, { name: 'Subject', value: 'Invoice 12' }, { name: 'X-Mailer', value: 'x' }] },
            tags: [{ Key: 'Owner', Value: 'tom' }, { Key: 'Cost-Center', Value: '42' }],
        });
        const patch = autoMapInputs(schema({ subject: 'string', from: 'string', owner: 'string', costCenter: 'string' }), {}, [mail]);
        expect(patch.subject.path).toBe('steps.raw.output.payload.headers[name="Subject"].value');
        expect(patch.owner.path).toBe('steps.raw.output.tags[Key="Owner"].Value');
        const root = rootOf([mail]);
        expect(walkPath(patch.subject.path, root)).toBe('Invoice 12');
        expect(walkPath(patch.from.path, root)).toBe('a@x.nl');
        expect(walkPath(patch.owner.path, root)).toBe('tom');
        expect(walkPath(patch.costCenter.path, root)).toBe('42');
    });

    it('never puts a list column into a one-value field', () => {
        const orders = stepGroup('shop', { orders: [{ sku: 'A' }, { sku: 'B' }] });
        expect(autoMapInputs(schema({ sku: 'string' }), {}, [orders])).toEqual({});
        // A whole list only into a parameter that takes a list.
        expect(autoMapInputs(schema({ orders: 'array' }), {}, [orders]).orders.path).toBe('steps.shop.output.orders');
        expect(autoMapInputs(schema({ orders: 'string' }), {}, [orders])).toEqual({});
    });
});

describe('which list a step runs once per item over', () => {
    const search = { results: [{ id: 'm1', subject: 'Invoice' }, { id: 'm2', subject: 'Receipt' }, { id: 'm3', subject: 'Hi' }], total: 3 };
    const read = { id: 'm1', threadId: 't1', subject: 'Invoice', attachments: [{ attachmentId: 'a1', filename: 'x.pdf', messageId: 'm1' }] };
    const catalog = (extra: object[] = []) => ({
        apps: [{
            actions: [
                { name: 'gmail_search', outputSample: search },
                { name: 'gmail_read', inputSchema: schema({ messageId: 'string' }, ['messageId']), outputSample: read },
                { name: 'gmail_mark_read', inputSchema: schema({ messageId: 'string' }, ['messageId']), outputSample: { read: true } },
                { name: 'gmail_read_attachment', inputSchema: schema({ messageId: 'string', attachmentId: 'string' }, ['messageId', 'attachmentId']), outputSample: { content: '' } },
                ...extra,
            ],
        }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    });
    const def = (last: object) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            { id: 's2', type: 'integration_action', tool: 'gmail_read', inputs: { messageId: { kind: 'ref', path: 'loop.result.id' } }, forEach: { overRef: 'steps.s1.output.results', itemVar: 'result', maxIterations: 100 } },
            last,
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }, { from: 's2', to: (last as { id: string }).id }],
    });

    it('"mark as read" after "read each mail" runs once per MAIL, not once per attachment', () => {
        const step = { id: 's3', type: 'integration_action', tool: 'gmail_mark_read', inputs: {} };
        const { step: out } = autoMapStep(step, def(step), catalog());
        expect(out.forEach).toEqual({ overRef: 'steps.s2.output.results', itemVar: 'result', maxIterations: 100 });
        expect(out.inputs.messageId).toEqual({ kind: 'ref', path: 'loop.result.output.id' });
    });

    it('"read attachment" needs an attachment id, so it does run per attachment, keeping the mail', () => {
        const step = { id: 's3', type: 'integration_action', tool: 'gmail_read_attachment', inputs: {} };
        const { step: out } = autoMapStep(step, def(step), catalog());
        expect(out.forEach).toEqual({
            overRef: 'steps.s2.output.results[*].output.attachments', itemVar: 'attachment', maxIterations: 100,
            parents: [{ itemVar: 'result', overRef: 'steps.s2.output.results' }],
        });
        expect(out.inputs.attachmentId).toEqual({ kind: 'ref', path: 'loop.attachment.attachmentId' });
    });

    it('an input the inner element lacks is read from the element it came from', async () => {
        // Outlook-like: attachments carry no message id. The mail is a mail
        // (a subject and a sender), which is what lets its `id` be the messageId.
        const cat = catalog([{ name: 'outlook_read', inputSchema: schema({ messageId: 'string' }, ['messageId']), outputSample: { id: 'o1', subject: 'Invoice', from: 'a@b.nl', attachments: [{ attachmentId: 'a1', name: 'x.pdf' }] } }]);
        const d = def({ id: 's3', type: 'integration_action', tool: 'gmail_read_attachment', inputs: {} });
        d.steps[1] = { ...d.steps[1], tool: 'outlook_read' };
        const { step: out } = autoMapStep(d.steps[2], d, cat);
        expect(out.inputs).toEqual({
            attachmentId: { kind: 'ref', path: 'loop.attachment.attachmentId' },
            messageId: { kind: 'ref', path: 'loop.result.output.id' },
        });
        // The run gives each attachment ITS mail's id.
        const state = {
            trigger: { output: {} }, vars: {}, secrets: {}, loop: {},
            steps: { s2: { output: { results: [
                { index: 0, item: {}, status: 'success', output: { id: 'o1', attachments: [{ attachmentId: 'a1' }, { attachmentId: 'a2' }] } },
                { index: 1, item: {}, status: 'success', output: { id: 'o2', attachments: [{ attachmentId: 'a3' }] } },
            ] } } },
        };
        const res = await execForEachStep({ ...out, id: 's3' }, {}, state, 'live', async (s: { inputs: object }, _c: unknown, sub: object) => ({ output: resolveInputs(s.inputs, sub) }));
        expect(res.output.results.map((r: { output: unknown }) => r.output)).toEqual([
            { attachmentId: 'a1', messageId: 'o1' }, { attachmentId: 'a2', messageId: 'o1' }, { attachmentId: 'a3', messageId: 'o2' },
        ]);
    });

});

describe('which list: Loops, a step already per item, item names', () => {
    const search = { results: [{ id: 'm1', subject: 'Invoice' }, { id: 'm2', subject: 'Receipt' }, { id: 'm3', subject: 'Hi' }], total: 3 };
    const read = { id: 'm1', threadId: 't1', subject: 'Invoice', attachments: [{ attachmentId: 'a1', filename: 'x.pdf', messageId: 'm1' }] };
    const catalog = (extra: object[] = []) => ({
        apps: [{
            actions: [
                { name: 'gmail_search', outputSample: search },
                { name: 'gmail_read', inputSchema: schema({ messageId: 'string' }, ['messageId']), outputSample: read },
                { name: 'gmail_mark_read', inputSchema: schema({ messageId: 'string' }, ['messageId']), outputSample: { read: true } },
                ...extra,
            ],
        }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    });
    const def = (last: object) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            { id: 's2', type: 'integration_action', tool: 'gmail_read', inputs: { messageId: { kind: 'ref', path: 'loop.result.id' } }, forEach: { overRef: 'steps.s1.output.results', itemVar: 'result', maxIterations: 100 } },
            last,
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }, { from: 's2', to: (last as { id: string }).id }],
    });

    it('a Loop after "read each mail" loops over the mails', () => {
        const step = { id: 'lp', type: 'loop', overRef: '', itemVar: 'item', body: [] };
        expect(autoMapStep(step, def(step), catalog()).step.overRef).toBe('steps.s2.output.results');
    });

    it('a step that already runs per mail takes the mail\'s id, and does not move into its attachments', () => {
        const step = { id: 's3', type: 'integration_action', tool: 'gmail_mark_read', inputs: {}, forEach: { overRef: 'steps.s2.output.results[*].output', itemVar: 'mail' } };
        const groups = computeUpstreamGroups(def(step), 's3', catalog());
        const patch = autoMapInputs(schema({ messageId: 'string' }, ['messageId']), {}, groups);
        expect(patch.messageId).toEqual({ kind: 'ref', path: 'loop.mail.id' });
    });

    it('an item name is always an identifier', () => {
        const cat = catalog([{ name: 'shop', outputSample: { 'line-items': [{ sku: 'A' }] } }, { name: 'stock', inputSchema: schema({ sku: 'string' }, ['sku']) }]);
        const d = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'o', type: 'integration_action', tool: 'shop', inputs: {} }, { id: 'k', type: 'integration_action', tool: 'stock', inputs: {} }],
            edges: [{ from: 'trg', to: 'o' }, { from: 'o', to: 'k' }],
        };
        const { step } = autoMapStep(d.steps[1], d, cat);
        expect(step.forEach).toEqual({ overRef: 'steps.o.output["line-items"]', itemVar: 'line_item', maxIterations: 100 });
        expect(step.inputs.sku).toEqual({ kind: 'ref', path: 'loop.line_item.sku' });
    });
});

describe('lists at any depth', () => {
    it('Stripe invoice lines three levels down', () => {
        const trg = { id: 'trg', label: 'Stripe', kind: 'trigger', basePath: 'trigger.output', sample: { id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1', lines: { object: 'list', data: [{ id: 'il_1', amount: 100 }] } } } }, fields: [] };
        expect(nearestArrayRef([trg])).toBe('trigger.output.data.object.lines.data');
    });

    it('Graph over HTTP: the list inside the JSON text body, from the NEAREST step', () => {
        const search = stepGroup('gs', { results: [{ id: 'm1' }] });
        const graph = stepGroup('http', { status: 200, body: JSON.stringify({ '@odata.context': 'x', '@odata.nextLink': 'y', value: [{ id: 'ev1', attendees: [{ type: 'required' }] }] }) }, 'http_request');
        const ref = nearestArrayRef([search, graph]);
        expect(ref).toBe('steps.http.output.body.value');
        expect(walkPath(ref, rootOf([search, graph]))).toHaveLength(1);
    });

    it('a Code step\'s logs are never the list, its own data is', () => {
        const code = stepGroup('c', { result: { order: { id: 9, lines: [{ sku: 'A' }] } }, logs: ['parsed'], httpCalls: 0 }, 'code');
        expect(nearestArrayRef([code])).toBe('steps.c.output.result.order.lines');
        const onlyLogs = stepGroup('c', { result: { total: 3 }, logs: ['x'], httpCalls: 0 }, 'code');
        expect(nearestArrayRef([onlyLogs])).toBeNull();
    });
});

describe('JSON text inside JSON text, several levels deep', () => {
    // An HTTP body (text) holding a payload (text) holding items whose meta is
    // text again, down to a fenced AI answer — the runtime reads every level.
    const lvl3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
    const items = [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: lvl3 }) }, { sku: 'B2', meta: '{"tags":["z"]}' }];
    const body = (payload: unknown) => JSON.stringify({ data: { payload: JSON.stringify(payload) } });

    it('a one-value field finds its key at the bottom', () => {
        const http = stepGroup('http', { status: 200, body: body({ meta: JSON.stringify({ ai: lvl3 }) }) }, 'http_request');
        const patch = autoMapInputs(schema({ reasonCode: 'string', score: 'number' }), {}, [http]);
        expect(patch.reasonCode.path).toBe('steps.http.output.body.data.payload.meta.ai.verdict["reason code"]');
        expect(walkPath(patch.reasonCode.path, rootOf([http]))).toBe('R-7');
        expect(walkPath(patch.score.path, rootOf([http]))).toBe(0.93);
    });

    it('inside a list: a required field makes the step run once per item, read through every level', async () => {
        const cat = {
            apps: [{ actions: [
                { name: 'fetch', outputSample: { status: 200, body: body({ items }) } },
                { name: 'flag', inputSchema: schema({ reasonCode: 'string' }, ['reasonCode']) },
            ] }],
            triggerOutputs: { __manual: { fields: [], sample: {} } },
        };
        const d = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'http', type: 'integration_action', tool: 'fetch', inputs: {} }, { id: 'f', type: 'integration_action', tool: 'flag', inputs: {} }],
            edges: [{ from: 'trg', to: 'http' }, { from: 'http', to: 'f' }],
        };
        const { step } = autoMapStep(d.steps[1], d, cat);
        expect(step.forEach).toEqual({ overRef: 'steps.http.output.body.data.payload.items', itemVar: 'item', maxIterations: 100 });
        expect(step.inputs.reasonCode).toEqual({ kind: 'ref', path: 'loop.item.meta.ai.verdict["reason code"]' });
        const state = { trigger: { output: {} }, vars: {}, secrets: {}, loop: {}, steps: { http: { output: { status: 200, body: body({ items }) } } } };
        const res = await execForEachStep(step, {}, state, 'live', async (s: { inputs: object }, _c: unknown, sub: object) => ({ output: resolveInputs(s.inputs, sub) }));
        expect(res.output.results.map((r: { output: { reasonCode?: string } }) => r.output.reasonCode)).toEqual(['R-7', undefined]);
    });

    it('a step already per item reads the field through its item', () => {
        const own = { id: 'f__foreach', label: 'Current item (item)', kind: 'loop', basePath: 'loop.item', ownItem: true, sample: items[0], fields: [] };
        const patch = autoMapInputs(schema({ reasonCode: 'string' }), {}, [stepGroup('http', { body: body({ items }) }), own]);
        expect(patch.reasonCode.path).toBe('loop.item.meta.ai.verdict["reason code"]');
        expect(walkPath(patch.reasonCode.path, { loop: { item: items[0] } })).toBe('R-7');
    });
});
