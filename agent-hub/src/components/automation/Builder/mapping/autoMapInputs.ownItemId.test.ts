// @vitest-environment node
/**
 * A step that runs once per item gets the item's own `id` for an `<x>Id`
 * input only when the item IS an x (its name or its type field says so),
 * and only once. A per-mail Slack post used to get channelId = the mail's
 * id, a per-mail Jira issue projectId = the mail's id, and "add label" the
 * message id a second time as its labelId: confident values that fail at
 * run time or, worse, hit the wrong resource. Left empty, the author is asked.
 */
import { describe, expect, it } from 'vitest';
import { autoMapInputs as autoMapInputsJs, autoMapStep } from './autoMapInputs';
import { computeUpstreamGroups } from './upstream';

type Patch = Record<string, { kind: string; path: string }>;
const autoMapInputs = (...a: Parameters<typeof autoMapInputsJs>) => autoMapInputsJs(...a) as Patch;
const schema = (props: Record<string, string>, required: string[] = Object.keys(props)) => ({
    properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])), required,
});

const MAILS = { results: [{ id: 'm1', subject: 'Invoice', from: 'a@b.nl', body: 'Hello' }] };

/** A step below "search mail" that already runs once per mail, as `itemVar`, with these tools in the catalog. */
function perItem(itemVar: string, tool: string, inputSchema: object, inputs: object = {}, output: object = MAILS) {
    const catalog = {
        apps: [{ actions: [{ name: 'search', outputSample: output }, { name: tool, inputSchema }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };
    const step = { id: 's2', type: 'integration_action', tool, inputs, forEach: { overRef: 'steps.s1.output.results', itemVar, maxIterations: 100 } };
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 's1', type: 'integration_action', tool: 'search', inputs: {} }, step],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
    return { step, definition, catalog, groups: computeUpstreamGroups(definition, 's2', catalog) };
}

describe('the item\'s own id, for a step that runs per item', () => {
    it('never fills an id of something else (a channel, a project)', () => {
        const slack = perItem('result', 'slack_post', schema({ channelId: 'string', text: 'string' }));
        const patch = autoMapInputs(schema({ channelId: 'string', text: 'string' }), {}, slack.groups);
        expect(patch.channelId).toBeUndefined();
        expect(patch.text).toEqual({ kind: 'ref', path: 'loop.result.body' });
        // Reconnecting does the same.
        expect(autoMapStep(slack.step, slack.definition, slack.catalog).step.inputs.channelId).toBeUndefined();

        const jira = perItem('mail', 'jira_create', schema({ projectId: 'string', summary: 'string' }));
        expect(autoMapInputs(schema({ projectId: 'string', summary: 'string' }), {}, jira.groups).projectId).toBeUndefined();
    });

    it('hands the item\'s id out once: a second id input stays empty', () => {
        const s = schema({ messageId: 'string', labelId: 'string' });
        const label = perItem('mail', 'gmail_add_label', s, { messageId: { kind: 'ref', path: 'loop.mail.id' } });
        expect(autoMapInputs(s, label.step.inputs, label.groups)).toEqual({});
        expect(autoMapStep(label.step, label.definition, label.catalog).step.inputs.labelId).toBeUndefined();
        // The author typed the message id by hand: the label is still not the mail.
        const typed = perItem('mail', 'gmail_add_label', s, { messageId: { kind: 'literal', value: 'abc' } });
        expect(autoMapInputs(s, typed.step.inputs, typed.groups).labelId).toBeUndefined();
        // Another id input holding it as a template counts too.
        const twice = schema({ messageId: 'string', mailId: 'string' });
        const tpl = perItem('mail', 'act', twice, { mailId: { kind: 'template', value: '{{ loop.mail.id }}' } });
        expect(autoMapInputs(twice, tpl.step.inputs, tpl.groups).messageId).toBeUndefined();
        // Text that merely mentions the id does not take the id's role.
        const note = schema({ messageId: 'string', note: 'string' });
        const quoted = perItem('mail', 'act', note, { note: { kind: 'template', value: 'Re {{loop.mail.id}}' } });
        expect(autoMapInputs(note, quoted.step.inputs, quoted.groups).messageId).toEqual({ kind: 'ref', path: 'loop.mail.id' });
    });

    it.each([
        ['mail', 'messageId'],
        ['message', 'message_id'],
        ['email', 'messageId'],
        ['order', 'orderId'],
        ['line_item', 'lineItemId'],
    ])('a %s IS what %s names: it gets the item\'s id', (itemVar, key) => {
        const s = schema({ [key]: 'string' });
        const { groups } = perItem(itemVar, 'act', s);
        expect(autoMapInputs(s, {}, groups)[key]).toEqual({ kind: 'ref', path: `loop.${itemVar}.id` });
    });

    it('a type field says what the item is (Stripe `object`, Graph `@odata.type`)', () => {
        const invoices = { results: [{ object: 'invoice', id: 'in_1', amount_due: 5 }] };
        const s = schema({ invoiceId: 'string' });
        expect(autoMapInputs(s, {}, perItem('result', 'act', s, {}, invoices).groups).invoiceId).toEqual({ kind: 'ref', path: 'loop.result.id' });
        const graph = { results: [{ '@odata.type': '#microsoft.graph.message', id: 'AAMk', subject: 'x' }] };
        const m = schema({ messageId: 'string' });
        expect(autoMapInputs(m, {}, perItem('value', 'act', m, {}, graph).groups).messageId).toEqual({ kind: 'ref', path: 'loop.value.id' });
    });

    it('an id the item carries for something else is used for that, by name', () => {
        const issues = { results: [{ id: 'i1', title: 'Bug', project: { id: 'P7', name: 'Web' } }] };
        const s = schema({ projectId: 'string', title: 'string' });
        const patch = autoMapInputs(s, {}, perItem('result', 'act', s, {}, issues).groups);
        expect(patch.projectId).toEqual({ kind: 'ref', path: 'loop.result.project.id' });
    });
});
