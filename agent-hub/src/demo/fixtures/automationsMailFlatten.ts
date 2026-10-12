/**
 * "Fabrikam invoices as one table": the Automations demo's "Flatten a list"
 * node after a list of mails (spec section 8), so the flatten editor, its run
 * sentence and its output table can be looked at (and screenshotted) against
 * the flow people build:
 *
 *   Manual trigger → Search (pinned, 4 mails) → Read many (4 mails × 16
 *   attachments) → Flatten (one row per attachment, with its mail's From,
 *   To, Subject and Date) → Filter a list (the PDF and XML invoices: 8 of 64)
 *   → Read attachment (once per row of the filter).
 *
 * Every mail carries 14 newsletter images next to its PDF and XML (UBL)
 * invoice, and a body of about 1.5 KB, so the "Left out: Body (long text)"
 * line shows.
 *
 * A second automation, "Contoso orders as lines", flattens a pinned HTTP body
 * of 5 webshop orders with Keep it anyway on: one order has no lines (one row
 * without line details) and one has its single line as an object.
 *
 * Shapes follow server/integrations/gmailTools.js (gmail_read_many) and the
 * flatten and filter steps of server/core/automationRunner/execCollections.js.
 * Everything is invented; addresses use the reserved `.example` domain.
 */

import { minutesAgo } from './common';
import { ME } from './automationsPeople';
import { opaqueId } from './automationsMailFanout';
import type { DemoRun } from './automationsRuns';

type Obj = Record<string, unknown>;
type StepResult = { stepType: string; input: unknown; output: unknown };

export const MAIL_FLATTEN_AUTOMATION_ID = 'auto_demo_mail_flatten';
export const MAIL_FLATTEN_AUTOMATION_TITLE = 'Fabrikam invoices as one table';

const FABRIKAM = 'Fabrikam Facturen <facturen@fabrikam.example>';
const CONTOSO = 'Contoso Billing <billing@contoso.example>';
const TO = 'crediteuren@contoso.example';
const QUERY = 'has:attachment factuur newer_than:30d';

const LOGOS = [
    'logo-header.png', 'icon-facebook.png', 'icon-linkedin.png', 'icon-x.png', 'icon-instagram.png', 'icon-youtube.png', 'badge-iso.png',
    'badge-thuiswinkel.png', 'banner-q4.png', 'spacer.png', 'footer-logo.png', 'qr-pay.png', 'stars.png', 'app-store.png',
];

/** id, from, subject, invoice number, date; newest first, as the search returns them. */
const MAILS: Array<[string, string, string, string, string]> = [
    ['19a11e7b3f0c6a59', CONTOSO, 'Invoice C-77012', 'C-77012', 'Mon, 28 Sep 2026 07:12:40 +0000 (UTC)'],
    ['19a0c4d1a8e35f02', FABRIKAM, 'Je Fabrikam factuur F-2026-1003', 'F-2026-1003', 'Mon, 21 Sep 2026 06:41:09 +0000 (UTC)'],
    ['19a06b2e91c4d877', FABRIKAM, 'Je Fabrikam factuur F-2026-1002', 'F-2026-1002', 'Mon, 14 Sep 2026 06:40:55 +0000 (UTC)'],
    ['19a01f3c7d2e4b10', FABRIKAM, 'Je Fabrikam factuur F-2026-1001', 'F-2026-1001', 'Mon, 07 Sep 2026 06:39:31 +0000 (UTC)'],
];

const MIME: Record<string, string> = { png: 'image/png', pdf: 'application/pdf', xml: 'application/xml' };

/** PNG 1-9 KB, PDF 80-120 KB, XML 10-15 KB; deterministic per file. */
function sizeOf(ext: string, seed: number): number {
    if (ext === 'pdf') return 80_000 + (seed * 7_919) % 40_000;
    if (ext === 'xml') return 10_000 + (seed * 3_571) % 5_000;
    return 1_000 + (seed * 1_237) % 8_000;
}

const bodyOf = (subject: string, sender: string) => [
    'Beste klant,', '',
    `In de bijlage vind je de factuur bij "${subject}", als PDF en als XML (UBL) voor je boekhouding.`,
    'Betaal binnen 30 dagen na factuurdatum op rekening NL00 BANK 0123 4567 89 onder vermelding van het factuurnummer.',
    ...Array.from({ length: 9 }, (_, i) => `Regel ${i + 1}: deze e-mail is automatisch verstuurd. Vragen over deze factuur? Antwoord op deze e-mail of bel onze klantenservice op werkdagen.`),
    '', 'Met vriendelijke groet,', sender.split(' <')[0],
].join('\n');

function readMail([id, from, subject, invoice, date]: (typeof MAILS)[number], mi: number) {
    const names = [...LOGOS, `${invoice}.pdf`, `${invoice}.xml`];
    return {
        id, threadId: id, from, to: TO, subject, date,
        body: bodyOf(subject, from),
        attachments: names.map((filename, i) => {
            const ext = filename.split('.').pop() as string;
            return {
                attachmentId: opaqueId(900 + mi * 20 + i), filename, mimeType: MIME[ext], size: sizeOf(ext, mi * 16 + i + 1),
                canOCR: ext !== 'png', messageId: id, threadId: id,
            };
        }),
    };
}

const MESSAGES = MAILS.map(readMail);
const READ_MANY = { messages: MESSAGES, count: MESSAGES.length, notFound: [], failed: [] };
const SEARCH = {
    query: QUERY, total: MESSAGES.length,
    results: MESSAGES.map(m => ({ id: m.id, to: TO, date: m.date, from: m.from, isBulk: false, snippet: m.body.replace(/\s+/g, ' ').slice(0, 120), subject: m.subject, precedence: null, hasListUnsubscribe: false })),
};

export const MAIL_FLATTEN_ROUTE = 'steps.mf_read_many.output.messages[*].attachments';

/** The stored step, exactly as auto-map writes it (spec J1). */
export const MAIL_FLATTEN_STEP = {
    id: 'mf_flatten', type: 'flatten', label: 'One row per attachment', arrayRef: MAIL_FLATTEN_ROUTE, keepEmpty: false,
    parents: [{
        overRef: 'steps.mf_read_many.output.messages', itemVar: 'message', auto: true,
        fields: [
            { from: 'id', to: 'messageId', mode: 'fill' },
            { from: 'threadId', to: 'threadId', mode: 'fill' },
            { from: 'from', to: 'from', mode: 'copy' },
            { from: 'to', to: 'to', mode: 'copy' },
            { from: 'subject', to: 'subject', mode: 'copy' },
            { from: 'date', to: 'date', mode: 'copy' },
        ],
    }],
};

/** One row per attachment: its own fields, then its mail's From, To, Subject and Date. */
const ROWS = MESSAGES.flatMap(m => m.attachments.map(a => ({ ...a, from: m.from, to: m.to, subject: m.subject, date: m.date })));
const FLATTEN_OUT = { items: ROWS, count: ROWS.length, inputCount: MESSAGES.length, emptyCount: 0 };

/** The Filter's rule: the PDF and the XML invoice of every mail. */
export const FILTER_EXPR = 'equals(fileType(item), "pdf") || endsWith(item.filename, ".xml")';
const KEPT = ROWS.filter(r => r.mimeType !== MIME.png);
const FILTER_OUT = { items: KEPT, count: KEPT.length, inputCount: ROWS.length, rejectedCount: ROWS.length - KEPT.length };

function attachmentRow(row: (typeof ROWS)[number], index: number) {
    const content = `${row.filename}\n\n(Invented demo text of this invoice from ${row.from.split(' <')[0]}.)`;
    return {
        index, item: row, status: 'success',
        output: { filename: row.filename, mimeType: row.mimeType, content, charCount: content.length, truncated: false, extractedVia: row.mimeType === MIME.pdf ? 'pdfjs' : 'text' },
    };
}
const READ_ROWS = KEPT.map(attachmentRow);
const READ_ATTACHMENTS = { iterations: READ_ROWS.length, succeeded: READ_ROWS.length, failed: 0, results: READ_ROWS };

/** stepId → the row a run of that step recorded; spread into the demo's run engine. */
export const MAIL_FLATTEN_STEP_RESULTS: Record<string, StepResult> = {
    mf_find: { stepType: 'integration_action', input: { query: QUERY, maxResults: 4 }, output: SEARCH },
    mf_read_many: { stepType: 'integration_action', input: { messageIds: MESSAGES.map(m => m.id) }, output: READ_MANY },
    mf_flatten: { stepType: 'flatten', input: { arrayRef: MAIL_FLATTEN_ROUTE }, output: FLATTEN_OUT },
    mf_filter: { stepType: 'filter', input: { arrayRef: 'steps.mf_flatten.output.items', expr: FILTER_EXPR }, output: FILTER_OUT },
    mf_read_file: { stepType: 'integration_action', input: { overRef: 'steps.mf_filter.output.items' }, output: READ_ATTACHMENTS },
};

const ref = (path: string) => ({ kind: 'ref', path });
const literal = (value: unknown) => ({ kind: 'literal', value });
const gmailStep = (id: string, label: string, tool: string, extra: Obj): Obj => ({ id, type: 'integration_action', label, tool, appId: 'gmail', ...extra });
const chain = (ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));

export function mailFlattenDefinition(): Obj {
    return {
        title: MAIL_FLATTEN_AUTOMATION_TITLE,
        trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
        steps: [
            gmailStep('mf_find', 'Search', 'gmail_search', {
                inputs: { query: literal(QUERY), maxResults: literal(4) }, pinnedOutput: SEARCH, pinnedAt: minutesAgo(60 * 26),
            }),
            gmailStep('mf_read_many', 'Read many', 'gmail_read_many', { inputs: { messageIds: ref('steps.mf_find.output.results[*].id') } }),
            { ...MAIL_FLATTEN_STEP, parents: MAIL_FLATTEN_STEP.parents.map(p => ({ ...p, fields: p.fields.map(f => ({ ...f })) })) },
            { id: 'mf_filter', type: 'filter', label: 'Filter a list', arrayRef: 'steps.mf_flatten.output.items', expr: FILTER_EXPR },
            gmailStep('mf_read_file', 'Read attachment', 'gmail_read_attachment', {
                forEach: { overRef: 'steps.mf_filter.output.items', itemVar: 'attachment' },
                inputs: { messageId: ref('loop.attachment.messageId'), attachmentId: ref('loop.attachment.attachmentId'), filename: ref('loop.attachment.filename'), mimeType: ref('loop.attachment.mimeType') },
            }),
        ],
        edges: chain(['trg', 'mf_find', 'mf_read_many', 'mf_flatten', 'mf_filter', 'mf_read_file']),
    };
}

/** The automation row's own fields; automations.js adds the shared defaults. */
export function mailFlattenAutomationFields(): Obj {
    return {
        id: MAIL_FLATTEN_AUTOMATION_ID,
        title: MAIL_FLATTEN_AUTOMATION_TITLE,
        description: 'Turns the attachments of the invoice mails into one table, keeps the PDF and XML invoices and reads them.',
        definition: mailFlattenDefinition(),
        version: 1, liveVersion: null, liveAt: null, neverLive: true, isDraft: true, isActive: false,
        triggerType: 'manual', lastRunAt: minutesAgo(3), lastStatus: 'success', icon: 'Mail',
        createdAt: minutesAgo(60 * 2), updatedAt: minutesAgo(3),
    };
}

interface RunSeed { id: string; automationId: string; steps: string; step: string; stepId: string; count: number; at: number }

const recordedRun = ({ id, automationId, steps, step, stepId, count, at }: RunSeed): DemoRun => ({
    id, automationId, version: 1, status: 'success', isTest: true, triggerKind: 'manual', howStarted: 'manual', startedBy: ME,
    startedAt: minutesAgo(at), durationMs: 8_400, steps, triggerPayload: null,
    outcome: { code: 'success', params: { step, stepId, kind: 'list', count, noun: 'items', where: null }, text: `${step}: ${count} items found` },
});

// ── Second automation: Contoso orders as lines (spec J2) ─────────────────

export const ORDERS_FLATTEN_AUTOMATION_ID = 'auto_demo_orders_flatten';
export const ORDERS_FLATTEN_AUTOMATION_TITLE = 'Contoso orders as lines';
export const ORDERS_FLATTEN_ROUTE = 'steps.of_http.output.body.orders[*].lines';

const line = (id: string, sku: string, description: string, quantity: number, price: number) => ({ id, sku, description, quantity, price, status: 'open' });
const order = (n: number, customer: string, status: string, lines: unknown, total: number) => ({
    id: `ord_${n}`, number: `CO-2026-0${n}`, customer, orderedAt: `2026-09-${n - 400}T10:15:00Z`, status, total,
    shipping: { method: 'post', city: 'Utrecht' }, notes: '', lines,
});

const ORDERS = [
    order(410, 'Fabrikam BV', 'paid', [line('ln_1', 'FB-100', 'Desk lamp', 2, 34.5), line('ln_2', 'FB-210', 'Monitor arm', 1, 89)], 158),
    order(411, 'Northwind Traders', 'paid', [line('ln_3', 'NW-001', 'Paper A4', 10, 4.95), line('ln_4', 'NW-014', 'Stapler', 2, 12.5), line('ln_5', 'NW-020', 'Pens', 5, 3.2)], 90.5),
    order(412, 'Contoso Retail', 'shipped', [line('ln_6', 'CR-300', 'Label printer', 1, 149), line('ln_7', 'CR-301', 'Labels', 4, 9.99)], 188.96),
    order(413, 'Fabrikam BV', 'cancelled', [], 0),
    order(414, 'Contoso Retail', 'paid', line('ln_8', 'CR-410', 'Headset', 1, 59), 59),
];
const HTTP_OUT = { status: 200, headers: { 'content-type': 'application/json' }, body: { orders: ORDERS } };

/** The stored plan from that sample (`id` and `status` named after the order: generic keys). */
export const ORDERS_FLATTEN_STEP = {
    id: 'of_flatten', type: 'flatten', label: 'One row per line', arrayRef: ORDERS_FLATTEN_ROUTE, keepEmpty: true,
    parents: [{
        overRef: 'steps.of_http.output.body.orders', itemVar: 'order', auto: true,
        fields: [
            { from: 'id', to: 'orderId', mode: 'copy' },
            { from: 'number', to: 'number', mode: 'copy' },
            { from: 'customer', to: 'customer', mode: 'copy' },
            { from: 'orderedAt', to: 'orderedAt', mode: 'copy' },
            { from: 'status', to: 'orderStatus', mode: 'copy' },
            { from: 'total', to: 'total', mode: 'copy' },
            { from: 'notes', to: 'notes', mode: 'copy' },
        ],
    }],
};

const LINE_KEYS = ['id', 'sku', 'description', 'quantity', 'price', 'status'];
const orderFields = (o: (typeof ORDERS)[number]) => ({
    orderId: o.id, number: o.number, customer: o.customer, orderedAt: o.orderedAt, orderStatus: o.status, total: o.total, notes: o.notes,
});
const ORDER_ROWS = ORDERS.flatMap((o) => {
    const lines = Array.isArray(o.lines) ? o.lines : [o.lines];
    if (!lines.length) return [{ ...Object.fromEntries(LINE_KEYS.map(k => [k, null])), ...orderFields(o) }];
    return lines.map(l => ({ ...l, ...orderFields(o) }));
});
const ORDERS_OUT = { items: ORDER_ROWS, count: ORDER_ROWS.length, inputCount: ORDERS.length, emptyCount: 1 };

export const ORDERS_FLATTEN_STEP_RESULTS: Record<string, StepResult> = {
    of_http: { stepType: 'http_request', input: { method: 'GET', url: 'https://shop.contoso.example/api/orders' }, output: HTTP_OUT },
    of_flatten: { stepType: 'flatten', input: { arrayRef: ORDERS_FLATTEN_ROUTE }, output: ORDERS_OUT },
};

export function ordersFlattenDefinition(): Obj {
    return {
        title: ORDERS_FLATTEN_AUTOMATION_TITLE,
        trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
        steps: [
            { id: 'of_http', type: 'http_request', label: 'Get orders', method: 'GET', url: 'https://shop.contoso.example/api/orders', pinnedOutput: HTTP_OUT, pinnedAt: minutesAgo(60 * 5) },
            { ...ORDERS_FLATTEN_STEP, parents: ORDERS_FLATTEN_STEP.parents.map(p => ({ ...p, fields: p.fields.map(f => ({ ...f })) })) },
        ],
        edges: chain(['trg', 'of_http', 'of_flatten']),
    };
}

export function ordersFlattenAutomationFields(): Obj {
    return {
        ...mailFlattenAutomationFields(),
        id: ORDERS_FLATTEN_AUTOMATION_ID,
        title: ORDERS_FLATTEN_AUTOMATION_TITLE,
        description: 'Turns the lines of the webshop orders into one table, with each order\'s number and customer on every line.',
        definition: ordersFlattenDefinition(),
        icon: 'Globe', lastRunAt: minutesAgo(2), updatedAt: minutesAgo(2),
    };
}

/** The recorded test runs of both automations. */
export function seedMailFlattenRuns(): DemoRun[] {
    return [
        recordedRun({ id: 'run_demo_mflat_01', automationId: MAIL_FLATTEN_AUTOMATION_ID, steps: 'SSSSS', step: 'Read attachment', stepId: 'mf_read_file', count: READ_ROWS.length, at: 3 }),
        recordedRun({ id: 'run_demo_oflat_01', automationId: ORDERS_FLATTEN_AUTOMATION_ID, steps: 'SS', step: 'One row per line', stepId: 'of_flatten', count: ORDER_ROWS.length, at: 2 }),
    ];
}
