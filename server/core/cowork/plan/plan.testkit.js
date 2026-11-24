/**
 * Shared set-up of the plan tests (./*.test.js): tool lookups a test controls, and the plan the Cowork design uses
 * as its running example ("Supplier radar": read supplier mail, pick out the orders, update a table, draft replies,
 * tell the owner).
 */

'use strict';

/** app and effect per tool name; a name that is not listed belongs to no app and writes (the fail-closed default). */
const TOOLS = Object.freeze({
    outlook_search: ['outlook', 'reads'],
    outlook_read: ['outlook', 'reads'],
    outlook_create_draft: ['outlook', 'writes'],
    outlook_compose: ['outlook', 'sends'],
    outlook_reply_in_thread: ['outlook', 'sends'],
    gmail_read: ['gmail', 'reads'],
    drive_search: ['google-drive', 'reads'],
    drive_upload: ['google-drive', 'writes'],
    contacts_search: ['google-contacts', 'reads'],
    read_url: ['browser-fetch', 'reads'],
    agent_search: ['agent-search', 'reads'],
    set_reminder: [null, 'writes'],
});

const OPEN_WEB = new Set(['read_url', 'agent_search']);

/** Lookups over TOOLS (plus `extra`, same shape). */
function fakeLookups(extra = {}) {
    const all = { ...TOOLS, ...extra };
    return {
        appOfTool: (tool) => (all[tool] ? all[tool][0] : null),
        effectOfTool: (tool) => (all[tool] ? all[tool][1] : 'writes'),
        isOpenWebRead: (tool) => OPEN_WEB.has(tool),
    };
}

const ref = (value) => ({ kind: 'ref', value });
const literal = (value) => ({ kind: 'literal', value });
const template = (value) => ({ kind: 'template', value });

/**
 * A definition from a list of steps, wired in order, on a weekday schedule unless `trigger` says otherwise.
 * @param {Array<Record<string, any>>} steps
 * @param {Record<string, any>} [trigger]
 * @returns {{ trigger: Record<string, any>, steps: Array<Record<string, any>>, edges: Array<Record<string, any>>, [key: string]: any }}
 */
function planOf(steps, trigger = { id: 'trg', type: 'trigger', kind: 'schedule', cron: '30 7 * * 1-5' }) {
    const ids = [trigger.id, ...steps.map((s) => s.id)];
    return { trigger, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })) };
}

/** The running example. Every step is on Cowork's list, and outside text reaches no recipient and no target. */
function supplierRadar() {
    return planOf([
        { id: 'mail', type: 'integration_action', label: 'Get the new supplier mail', tool: 'outlook_search', inputs: { query: literal('from:suppliers newer_than:1d') } },
        {
            id: 'orders', type: 'data_extraction', label: 'Read each mail and pick out the order', source: ref('steps.mail.output.messages'),
            fields: [{ name: 'supplier' }, { name: 'orderNumber' }, { name: 'amount' }, { name: 'replyBy' }],
        },
        { id: 'overdue', type: 'filter', label: 'Keep what is overdue', items: ref('steps.orders.output.rows'), where: '{{item.replyBy}} < today' },
        { id: 'table', type: 'datatable', label: 'Update the Open orders table', datatableId: 'tbl_open_orders', op: 'save_row', values: { amount: ref('steps.orders.output.amount') } },
        { id: 'reply', type: 'ai_step', label: 'Write a reply for each overdue order', prompt: 'Write a short reply about {{steps.overdue.output.items}}.' },
        { id: 'draft', type: 'integration_action', label: 'Save the replies as drafts', tool: 'outlook_create_draft', inputs: { to: literal('orders@hoekstra-staal.example'), body: ref('steps.reply.output.text') } },
        { id: 'digest', type: 'notification', label: 'Send me the digest', title: 'Supplier radar', body: '{{steps.orders.output.rows}}', channels: ['notification', 'email'] },
    ]);
}

/**
 * A plan's steps as a run executes them (./planRunCopy.mts runCopyOf): every AI step asked for its own verdict
 * (core/automationRunner/aiStepVerdict.mts), nothing else changed.
 * @param {{ steps?: unknown[] } & Record<string, unknown>} definition
 */
function withVerdicts(definition) {
    const steps = (definition.steps ?? []).map((s) => (s && typeof s === 'object' && /** @type {{ type?: unknown }} */ (s).type === 'ai_step' ? { ...s, reportOutcome: true } : s));
    return { ...definition, steps };
}

module.exports = { fakeLookups, planOf, supplierRadar, ref, literal, template, withVerdicts };
