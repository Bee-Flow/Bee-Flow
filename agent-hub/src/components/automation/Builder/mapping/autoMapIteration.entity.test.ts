// @vitest-environment node
/**
 * A step dropped below a list, set to run once per element: its `<x>Id`
 * input gets the element's own `id` only when the element IS an x — the
 * list's name says so (`messages` → message, `line_items` → line item), its
 * type field does (`object: "invoice"`), or it is a mail (a subject and a
 * sender). A Slack post below a list of mails used to get channelId = the
 * mail's id on connect, a Jira issue projectId = the mail's id.
 */
import { describe, expect, it } from 'vitest';
import { autoMapStep } from './autoMapInputs';

type Step = { id: string; type: string; tool: string; inputs: Record<string, { kind: string; path: string }>; forEach?: { overRef: string; itemVar: string; parents?: unknown[] } };
const schema = (props: Record<string, string>, required: string[] = Object.keys(props)) => ({
    properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])), required,
});

/** Connect `tool` (with `inputSchema`) below a step that returned `output`. */
function connect(output: object, inputSchema: object) {
    const catalog = {
        apps: [{ actions: [{ name: 'source', outputSample: output }, { name: 'target', inputSchema }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 's1', type: 'integration_action', tool: 'source', inputs: {} }, { id: 's2', type: 'integration_action', tool: 'target', inputs: {} }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
    return autoMapStep(definition.steps[1], definition, catalog).step as Step;
}

const MESSAGES = { messages: [{ id: 'm1', snippet: 'Hello', text: 'Hello there' }] };

describe('the element\'s own id on connect', () => {
    it('is never a channel\'s or a project\'s id', () => {
        const slack = connect(MESSAGES, schema({ channelId: 'string', text: 'string' }));
        expect(slack.inputs.channelId).toBeUndefined();
        expect(slack.inputs.text).toEqual({ kind: 'ref', path: 'loop.message.text' });
        const jira = connect(MESSAGES, schema({ projectId: 'string', summary: 'string' }));
        expect(jira.inputs.projectId).toBeUndefined();
    });

    it.each([
        ['messages', MESSAGES, 'messageId', 'loop.message.id'],
        ['orders', { orders: [{ id: 'o1', total: 5 }] }, 'orderId', 'loop.order.id'],
        ['line_items', { line_items: [{ id: 'li1', sku: 'A' }] }, 'lineItemId', 'loop.line_item.id'],
        ['a mail by its headers', { results: [{ id: 'm1', subject: 'Invoice', from: 'a@b.nl' }] }, 'messageId', 'loop.result.id'],
        ['an invoice by its object field', { data: [{ object: 'invoice', id: 'in_1' }] }, 'invoiceId', 'loop.data.id'],
    ])('a list of %s gives the id it names', (_label, output, key, path) => {
        const step = connect(output, schema({ [key]: 'string' }));
        expect(step.inputs[key]).toEqual({ kind: 'ref', path });
        expect(step.forEach).toBeTruthy();
    });

    it('a record that says nothing about what it is keeps the id for the author', () => {
        const step = connect({ results: [{ id: 'r1', title: 'x' }] }, schema({ messageId: 'string' }));
        expect(step.inputs.messageId).toBeUndefined();
        expect(step.forEach).toBeUndefined();
    });

    it('each level of a list inside a list gives the id that names it', () => {
        const output = { orders: [{ id: 'o1', line_items: [{ id: 'li1', sku: 'A' }] }] };
        const step = connect(output, schema({ orderId: 'string', lineItemId: 'string', sku: 'string' }));
        expect(step.forEach?.overRef).toBe('steps.s1.output.orders[*].line_items');
        expect(step.inputs).toEqual({
            orderId: { kind: 'ref', path: 'loop.order.id' },
            lineItemId: { kind: 'ref', path: 'loop.line_item.id' },
            sku: { kind: 'ref', path: 'loop.line_item.sku' },
        });
    });
});
