/**
 * "Nested data mapping": the Automations demo's workflow whose data is as
 * awkward as what real systems send, so the input and output mapping screens
 * can be looked at against it (and screenshotted, see the S8 harness).
 *
 * A purchasing inbox is read the way Microsoft Graph answers: `value[]`,
 * `@odata.*` keys, `from.emailAddress.address`, attachments with
 * `content-type` and `Größe (KB)`, an open extension holding `Story Points`
 * and `Kostenplaats €`, a name/value header list (`internetMessageHeaders`,
 * the shape of Gmail's `payload.headers`), and messages that do not all carry
 * the same keys. An ERP lookup answers with JSON TEXT (a string, served as
 * text/plain), holding `data.items[].line_items[].properties[]` and
 * `data.payload`: JSON text again, whose `items[].meta` is JSON text holding
 * `ai`, a ```json fenced answer with `verdict.score` and
 * `verdict["reason code"]`. A per-item step downloads every
 * attachment and needs both the message id and the attachment id. An AI step
 * answers with ```json fenced text. The reply and the notification at the end
 * read deep fields through text with pills, a formula with a transform and a
 * list column.
 *
 * The run recorded below gives every step a real output, so the builder's
 * pickers, the "Comes in" panel and the output tables show data instead of
 * placeholders (hydrateLastRun → buildRealOutputMap). Everything is invented;
 * addresses use the reserved `.example` domain.
 */

import { minutesAgo } from './common';
import { ME } from './automationsPeople';
import { MAILBOX } from './automationsNestedOutputs';
import type { DemoRun } from './automationsRuns';

export { NESTED_STEP_RESULTS } from './automationsNestedOutputs';

type Obj = Record<string, unknown>;

export const NESTED_AUTOMATION_ID = 'auto_demo_nested_mapping';
export const NESTED_AUTOMATION_TITLE = 'Nested data mapping';

// ── The definition ───────────────────────────────────────────────────────

const ref = (path: string) => ({ kind: 'ref', path });
const template = (value: string) => ({ kind: 'template', value });
const literal = (value: unknown) => ({ kind: 'literal', value });

const MAIL = 'steps.list_mail.output.value[0]';
const ORDER = 'steps.fetch_order.output.body.data.items[0]';
// JSON text inside JSON text: the body (text) holds data.payload (text),
// whose items carry meta (text) holding ai (```json fenced text).
const PAYLOAD = 'steps.fetch_order.output.body.data.payload';
const VERDICT = `${PAYLOAD}.items[0].meta.ai.verdict`;

/** The Graph mail list: the source of most of the awkward keys. */
const listMail = (): Obj => ({
    id: 'list_mail',
    type: 'integration_action',
    label: 'Read the purchasing inbox',
    tool: 'outlook_list_messages',
    appId: 'outlook',
    inputs: {
        mailbox: literal(MAILBOX),
        folder: literal('Inbox'),
        filter: template('receivedDateTime ge {{ trigger.output.since }} and hasAttachments eq true'),
        expand: literal('attachments,extensions'),
        top: literal(3),
    },
});

/** The ERP lookup: a JSON template body, an answer that is JSON text. */
const fetchOrder = (): Obj => ({
    id: 'fetch_order',
    type: 'http_request',
    label: 'Look up the order in the ERP',
    method: 'POST',
    url: 'https://erp.fabrikam.example/api/v2/orders/search',
    headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': `{{ ${MAIL}.conversationId }}`,
    },
    body: [
        '{',
        `  "customerEmail": "{{ ${MAIL}.from.emailAddress.address }}",`,
        `  "costCentre": "{{ ${MAIL}.extensions[0]["Kostenplaats €"] }}",`,
        `  "subject": "{{ ${MAIL}.subject }}"`,
        '}',
    ].join('\n'),
});

/** Runs once per attachment of every message, and needs two ids for each. */
const saveAttachments = (): Obj => ({
    id: 'save_attachments',
    type: 'integration_action',
    label: 'Download each attachment',
    tool: 'outlook_get_attachment',
    appId: 'outlook',
    // One run per attachment of every message: the list is the
    // attachments of all messages flattened into one.
    forEach: { overRef: 'steps.list_mail.output.value[*].attachments', itemVar: 'attachment', maxIterations: 50 },
    inputs: {
        messageId: ref('loop.attachment.messageId'),
        attachmentId: ref('loop.attachment.id'),
        saveTo: template('/Purchasing/{{ loop.attachment.name }}'),
    },
});

/** An AI step that answers with ```json fenced text. */
const extractTerms = (): Obj => ({
    id: 'extract_terms',
    type: 'ai_step',
    label: 'Compare invoice and order',
    modelTier: 'fast',
    prompt: [
        'Compare the invoice with the order. Answer with JSON only: the invoice number, total, currency and due date,',
        'every line with sku, quantity and price, and every difference between invoice and order.',
        '',
        `Order: {{ ${ORDER} }}`,
        'Invoice files: {{ steps.save_attachments.output.results[*].output.name }}',
    ].join('\n'),
});

/** The reply: text with pills, a formula with a transform, list columns, a picked header and the deepest level. */
const replySupplier = (): Obj => ({
    id: 'reply_supplier',
    type: 'integration_action',
    label: 'Reply to the supplier',
    tool: 'outlook_send_mail',
    appId: 'outlook',
    inputs: {
        // A formula with a transform: the address, lowercased.
        to: { kind: 'expr', value: `lower(${MAIL}.from.emailAddress.address)` },
        // A list column: every cc address of the message.
        cc: ref(`${MAIL}.ccRecipients[*].emailAddress.address`),
        // One element of a name/value list, picked by its name.
        subject: template(`Re: {{ ${MAIL}.internetMessageHeaders[name="Subject"].value }}`),
        body: template([
            `Hello {{ ${MAIL}.from.emailAddress.name }},`,
            '',
            // The deepest level: three layers of JSON text down.
            `Quality check on {{ ${PAYLOAD}.items[0].sku }}: reason {{ ${VERDICT}["reason code"] }}, score {{ ${VERDICT}.score }}.`,
            'We received invoice {{ steps.extract_terms.output.invoice.number }} for order '
                + `{{ ${ORDER}.order_number }} (your reference {{ ${MAIL}.internetMessageHeaders[name="X-Supplier-Ref"].value }}).`,
            `Attachment: {{ ${MAIL}.attachments[0]["Größe (KB)"] }} KB, {{ ${MAIL}.attachments[0]["content-type"] }}. `
                + `Cost centre {{ ${MAIL}.extensions[0]["Kostenplaats €"] }}, {{ ${MAIL}.extensions[0]["Story Points"] }} story points.`,
            `First line: {{ ${ORDER}.line_items[0].title }}, colour {{ ${ORDER}.line_items[0].properties[0].value }}.`,
            '',
            'Kind regards,',
            'Purchasing',
        ].join('\n')),
        // A list two layers of JSON text down.
        categories: ref(`${PAYLOAD}.items[0].meta.tags`),
        importance: literal('high'),
    },
});

/** The notification: title and body as text with pills. */
const notifyMe = (): Obj => ({
    id: 'notify_me',
    type: 'notification',
    label: 'Tell me about differences',
    title: `Order {{ ${ORDER}.order_number }}: {{ steps.extract_terms.output.differences.length }} difference(s)`,
    body: [
        '{{ steps.extract_terms.output.differences[0].sku }}: ordered {{ steps.extract_terms.output.differences[0].order }}, '
            + 'invoiced {{ steps.extract_terms.output.differences[0].invoice }}.',
        'Tracking: {{ steps.fetch_order.output.body.data.items[0].shipments[0].tracking }}',
        'Request id: {{ steps.fetch_order.output.body.meta.request_id }}',
    ].join('\n'),
    channels: ['inapp', 'email'],
});

function nestedDefinition(): Obj {
    return {
        title: NESTED_AUTOMATION_TITLE,
        trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
        steps: [listMail(), fetchOrder(), saveAttachments(), extractTerms(), replySupplier(), notifyMe()],
        edges: [
            { from: 'trg', to: 'list_mail' },
            { from: 'list_mail', to: 'fetch_order' },
            { from: 'fetch_order', to: 'save_attachments' },
            { from: 'save_attachments', to: 'extract_terms' },
            { from: 'extract_terms', to: 'reply_supplier' },
            { from: 'reply_supplier', to: 'notify_me' },
        ],
    };
}

/** The automation row's own fields; automations.js adds the shared defaults. */
export function nestedAutomationFields(): Obj {
    return {
        id: NESTED_AUTOMATION_ID,
        title: NESTED_AUTOMATION_TITLE,
        description: 'Reads supplier mail the way Microsoft Graph sends it, looks the order up in the ERP and replies with the differences.',
        definition: nestedDefinition(),
        version: 2,
        liveVersion: 2,
        liveAt: minutesAgo(60 * 30),
        isActive: true,
        triggerType: 'manual',
        lastRunAt: minutesAgo(14),
        lastStatus: 'success',
        icon: 'Braces',
        createdAt: minutesAgo(60 * 50),
        updatedAt: minutesAgo(14),
    };
}

/** The one recorded run: every step went through, so every node has output. */
export function seedNestedRuns(): DemoRun[] {
    return [{
        id: 'run_demo_nm_01', automationId: NESTED_AUTOMATION_ID, version: 2, status: 'success', isTest: false,
        triggerKind: 'manual', howStarted: 'manual', startedBy: ME, startedAt: minutesAgo(14), durationMs: 18_400,
        steps: 'SSSSSS',
        outcome: { code: 'success', params: { step: 'Tell me about differences', stepId: 'notify_me', kind: 'text' }, text: 'Finished with "Tell me about differences"' },
        triggerPayload: { mailbox: MAILBOX, since: '2026-10-01T00:00:00Z' },
    }];
}

// ── The Outlook actions in the demo catalog ──────────────────────────────

const str = (description: string, extra: Obj = {}) => ({ type: 'string', description, ...extra });

/** Catalog apps (GET /api/automation/catalog), so the steps get typed input forms. */
export const NESTED_CATALOG_APPS = [{
    id: 'outlook',
    label: 'Outlook',
    available: true,
    actions: [
        {
            name: 'outlook_list_messages',
            label: 'List messages',
            description: 'Lists the messages in a mail folder, newest first, as Microsoft Graph returns them.',
            inputSchema: {
                type: 'object',
                properties: {
                    mailbox: str('The mailbox to read', { format: 'email' }),
                    folder: str('Mail folder', { default: 'Inbox' }),
                    filter: str('Only messages that match this OData filter'),
                    expand: str('Related data to include', { enum: ['attachments', 'extensions', 'attachments,extensions'] }),
                    top: { type: 'integer', description: 'How many messages at most' },
                },
                required: ['folder'],
            },
            outputSample: null,
            sideEffect: false,
            effect: 'reads',
            integrationId: 'outlook',
            integrationLabel: 'Outlook',
        },
        {
            name: 'outlook_get_attachment',
            label: 'Get attachment',
            description: 'Downloads one attachment of a message and saves it in Files.',
            inputSchema: {
                type: 'object',
                properties: {
                    messageId: str('The message the attachment belongs to'),
                    attachmentId: str('The attachment to download'),
                    saveTo: str('Where to save it in Files'),
                },
                required: ['messageId', 'attachmentId'],
            },
            outputSample: { id: '', name: '', contentType: '', size: 0, file: { path: '', url: '' } },
            sideEffect: false,
            effect: 'reads',
            integrationId: 'outlook',
            integrationLabel: 'Outlook',
        },
        {
            name: 'outlook_send_mail',
            label: 'Send email',
            description: 'Sends an email from the connected mailbox.',
            inputSchema: {
                type: 'object',
                properties: {
                    to: str('Recipient', { format: 'email' }),
                    cc: { type: 'array', items: { type: 'string', format: 'email' }, description: 'Copy to' },
                    subject: str('Subject'),
                    body: str('Message', { format: 'multiline' }),
                    importance: str('Importance', { enum: ['low', 'normal', 'high'] }),
                    categories: { type: 'array', items: { type: 'string' }, description: 'Outlook categories for the sent message' },
                },
                required: ['to', 'subject', 'body'],
            },
            outputSample: { id: '', sentDateTime: '' },
            sideEffect: true,
            effect: 'sends',
            integrationId: 'outlook',
            integrationLabel: 'Outlook',
        },
    ],
}];
