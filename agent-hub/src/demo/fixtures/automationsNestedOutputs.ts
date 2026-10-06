/**
 * The recorded run of the Automations demo's "Nested data mapping"
 * (automationsNested.ts): what each step returned, shaped like the systems it
 * stands in for. Microsoft Graph mail (`value[]`, `@odata.*` keys, a
 * name/value header list, attachments with `content-type` and `Größe (KB)`),
 * an ERP answer that is JSON TEXT holding more JSON text three levels down,
 * and an AI answer in a ```json fence. Everything is invented; addresses use
 * the reserved `.example` domain.
 */

type Obj = Record<string, unknown>;

export const MAILBOX = 'purchasing@contoso.example';
const MSG_1 = 'AAMkADY3ZjM5LWQ1NGQtNGI1Ny1hNzE2LTRmODEwZjQ2ZjYxYQBGAAAAAAC7nN2qY0gyRKWvWS1NgSN0BwDkd1Ys7zl0SKl3yNnvMbZlAAAt4V1dAAA=';
const MSG_2 = 'AAMkADY3ZjM5LWQ1NGQtNGI1Ny1hNzE2LTRmODEwZjQ2ZjYxYQBGAAAAAAC7nN2qY0gyRKWvWS1NgSN0BwDkd1Ys7zl0SKl3yNnvMbZlAAAt4V1eAAA=';
const MSG_3 = 'AAMkADY3ZjM5LWQ1NGQtNGI1Ny1hNzE2LTRmODEwZjQ2ZjYxYQBGAAAAAAC7nN2qY0gyRKWvWS1NgSN0BwDkd1Ys7zl0SKl3yNnvMbZlAAAt4V1fAAA=';

interface AttachmentSeed { messageId: string; id: string; name: string; contentType: string; size: number; extra?: Obj }

/** One Graph attachment; our connector adds the `messageId` Graph leaves out. */
const attachment = ({ messageId, id, name, contentType, size, extra = {} }: AttachmentSeed) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    '@odata.mediaContentType': contentType,
    id,
    messageId,
    name,
    'content-type': contentType,
    size,
    'Größe (KB)': Math.round(size / 1024),
    isInline: false,
    lastModifiedDateTime: '2026-10-02T07:40:55Z',
    ...extra,
});

/** Three messages that do not all carry the same keys: real mail never does. */
const MAIL_LIST = {
    '@odata.context': `https://graph.microsoft.com/v1.0/$metadata#users('${encodeURIComponent(MAILBOX)}')/mailFolders('Inbox')/messages(attachments(),extensions())`,
    '@odata.nextLink': `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailFolders/Inbox/messages?$top=3&$skip=3`,
    value: [
        {
            '@odata.etag': 'W/"CQAAABYAAADkd1Ys7zl0SKl3yNnvMbZlAAAt4Wr+"',
            id: MSG_1,
            conversationId: 'AAQkADY3ZjM5LWQ1NGQtNGI1Ny1hNzE2LTRmODEwZjQ2ZjYxYQAQAJm6',
            receivedDateTime: '2026-10-02T07:41:18Z',
            subject: 'Invoice F-2026-0917 for order SO-2026-0917',
            bodyPreview: 'Good morning, please find attached the invoice and the packing slip for order SO-2026-0917.',
            importance: 'normal',
            hasAttachments: true,
            categories: ['Purchasing', 'Facilities'],
            from: { emailAddress: { name: 'Ingrid Möller', address: 'Ingrid.Moller@Fabrikam.example' } },
            toRecipients: [{ emailAddress: { name: 'Purchasing', address: MAILBOX } }],
            ccRecipients: [
                { emailAddress: { name: 'Jan de Wit', address: 'jan.dewit@contoso.example' } },
                { emailAddress: { name: 'Accounts payable', address: 'ap@contoso.example' } },
            ],
            // A name/value list, the shape Gmail's payload.headers has too.
            internetMessageHeaders: [
                { name: 'Message-ID', value: '<f2026-0917.4410@mail.fabrikam.example>' },
                { name: 'Subject', value: 'Invoice F-2026-0917 for order SO-2026-0917' },
                { name: 'X-Supplier-Ref', value: 'FAB-REF-88412' },
                { name: 'Content-Language', value: 'de-DE' },
            ],
            flag: { flagStatus: 'flagged', dueDateTime: { dateTime: '2026-10-09T00:00:00.0000000', timeZone: 'UTC' } },
            extensions: [{
                '@odata.type': '#microsoft.graph.openTypeExtension',
                id: 'Microsoft.OutlookServices.OpenTypeExtension.com.contoso.ticket',
                extensionName: 'com.contoso.ticket',
                'Story Points': 5,
                'Kostenplaats €': '4100-FAC',
            }],
            attachments: [
                attachment({ messageId: MSG_1, id: 'AAMkADY3ZjM5AAABEgAQAKs1b2', name: 'Invoice F-2026-0917.pdf', contentType: 'application/pdf', size: 48_213 }),
                attachment({ messageId: MSG_1, id: 'AAMkADY3ZjM5AAABEgAQAKs1b3', name: 'Packing slip SO-2026-0917.pdf', contentType: 'application/pdf', size: 21_877 }),
            ],
        },
        {
            '@odata.etag': 'W/"CQAAABYAAADkd1Ys7zl0SKl3yNnvMbZlAAAt4Wr/"',
            id: MSG_2,
            conversationId: 'AAQkADY3ZjM5LWQ1NGQtNGI1Ny1hNzE2LTRmODEwZjQ2ZjYxYQAQAJm7',
            receivedDateTime: '2026-10-02T09:12:03Z',
            subject: 'RE: delivery window week 41',
            bodyPreview: 'We can deliver on Tuesday between 08:00 and 12:00.',
            importance: 'low',
            hasAttachments: false,
            categories: [],
            from: { emailAddress: { name: "Daan O'Neill", address: 'daan.oneill@fabrikam.example' } },
            toRecipients: [{ emailAddress: { name: 'Purchasing', address: MAILBOX } }],
            ccRecipients: [],
            attachments: [],
        },
        {
            '@odata.etag': 'W/"CQAAABYAAADkd1Ys7zl0SKl3yNnvMbZlAAAt4WsA"',
            id: MSG_3,
            conversationId: 'AAQkADY3ZjM5LWQ1NGQtNGI1Ny1hNzE2LTRmODEwZjQ2ZjYxYQAQAJm8',
            receivedDateTime: '2026-10-02T11:30:44Z',
            subject: 'Fwd: credit note CN-2026-0042',
            bodyPreview: 'Forwarding the credit note we discussed.',
            importance: 'normal',
            hasAttachments: true,
            categories: ['Purchasing'],
            from: { emailAddress: { name: 'Jan de Wit', address: 'jan.dewit@contoso.example' } },
            toRecipients: [{ emailAddress: { name: 'Purchasing', address: MAILBOX } }],
            extensions: [{
                '@odata.type': '#microsoft.graph.openTypeExtension',
                id: 'Microsoft.OutlookServices.OpenTypeExtension.com.contoso.ticket',
                extensionName: 'com.contoso.ticket',
                'Story Points': null,
                'Kostenplaats €': '4100-FAC',
            }],
            attachments: [
                attachment({
                    messageId: MSG_3, id: 'AAMkADY3ZjM5AAABEgAQAKs1c1', name: 'Credit note CN-2026-0042.eml', contentType: 'message/rfc822', size: 9_310,
                    extra: { '@odata.type': '#microsoft.graph.itemAttachment' },
                }),
            ],
        },
    ],
};

/** The ERP's quality-check feed: JSON text whose items carry JSON text, down to a fenced AI answer. */
const QC_PAYLOAD = {
    batch: 'QC-2026-41',
    checked_at: '2026-10-02T06:15:00Z',
    items: [
        {
            sku: 'DSK-180-OAK',
            quantity: 4,
            meta: JSON.stringify({
                tags: ['oversize', 'assembly'],
                ai: '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7', note: 'Quantity on the invoice differs from the order' } }, null, 2) + '\n```',
            }),
        },
        { sku: 'CHR-ERGO-2', quantity: 6, meta: '{"tags":["upholstery"]}' },
    ],
};

/** The ERP's answer, as the TEXT it sends (labelled text/plain). */
const ORDER_SEARCH = {
    data: {
        items: [
            {
                id: 'ord_7Hk2',
                order_number: 'SO-2026-0917',
                status: 'partially_shipped',
                customer: { id: 'cus_118', name: 'Contoso B.V.', vat_id: 'NL001234567B01' },
                line_items: [
                    {
                        sku: 'DSK-180-OAK', title: 'Sit-stand desk 180×80', quantity: 4,
                        unit_price: { amount: '649.00', currency: 'EUR' },
                        properties: [{ name: 'Colour', value: 'Oak' }, { name: 'Assembly', value: 'Yes' }],
                    },
                    {
                        sku: 'CHR-ERGO-2', title: 'Ergonomic chair', quantity: 6,
                        unit_price: { amount: '389.00', currency: 'EUR' },
                        properties: [{ name: 'Upholstery', value: 'Anthracite' }],
                    },
                ],
                shipments: [{ carrier: 'PostNL', tracking: '3SFABR0917001', delivered_at: null }],
            },
            {
                id: 'ord_7Hk9',
                order_number: 'SO-2026-0931',
                status: 'open',
                customer: { id: 'cus_118', name: 'Contoso B.V.', vat_id: 'NL001234567B01' },
                line_items: [],
                shipments: [],
            },
        ],
        payload: JSON.stringify(QC_PAYLOAD),
    },
    meta: { page: 1, per_page: 25, total: 2, request_id: 'req_01J9ZK6T3Q8W' },
};

const ATTACHMENTS = MAIL_LIST.value.flatMap(m => m.attachments as Obj[]);

/** The AI step's answer: fenced JSON, as models like to send it. */
const AI_ANSWER = [
    '```json',
    JSON.stringify({
        invoice: { number: 'F-2026-0917', total: 4930.0, currency: 'EUR', due_date: '2026-10-30' },
        lines: [
            { sku: 'DSK-180-OAK', quantity: 4, price: 649.0 },
            { sku: 'CHR-ERGO-2', quantity: 5, price: 389.0 },
        ],
        differences: [{ sku: 'CHR-ERGO-2', field: 'quantity', order: 6, invoice: 5 }],
    }, null, 2),
    '```',
].join('\n');

/** stepId → the row a run of that step recorded; spread into the demo's run engine. */
export const NESTED_STEP_RESULTS: Record<string, { stepType: string; input: unknown; output: unknown }> = {
    list_mail: {
        stepType: 'integration_action',
        input: { mailbox: MAILBOX, folder: 'Inbox', filter: 'receivedDateTime ge 2026-10-01T00:00:00Z and hasAttachments eq true', expand: 'attachments,extensions', top: 3 },
        output: MAIL_LIST,
    },
    fetch_order: {
        stepType: 'http_request',
        input: { method: 'POST', url: 'https://erp.fabrikam.example/api/v2/orders/search' },
        output: {
            status: 200,
            ok: true,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': 'req_01J9ZK6T3Q8W' },
            body: JSON.stringify(ORDER_SEARCH, null, 2),
            truncated: false,
        },
    },
    save_attachments: {
        stepType: 'integration_action',
        input: { overRef: 'steps.list_mail.output.value[*].attachments' },
        output: {
            iterations: ATTACHMENTS.length,
            succeeded: ATTACHMENTS.length,
            failed: 0,
            results: ATTACHMENTS.map((a, index) => ({
                index,
                item: a,
                status: 'success',
                output: {
                    id: a.id,
                    name: a.name,
                    contentType: a['content-type'],
                    size: a.size,
                    file: { path: `/Purchasing/${String(a.name)}`, url: `https://cloud.contoso.example/f/${4810 + index}` },
                },
            })),
        },
    },
    extract_terms: {
        stepType: 'ai_step',
        input: { modelTier: 'fast' },
        output: AI_ANSWER,
    },
    reply_supplier: {
        stepType: 'integration_action',
        input: { to: 'ingrid.moller@fabrikam.example', importance: 'high' },
        output: { id: 'AAMkADY3ZjM5sent0001', sentDateTime: '2026-10-05T08:02:11Z', demo: 'No email was sent. The demo has no network access.' },
    },
    notify_me: {
        stepType: 'notification',
        input: { channels: ['inapp', 'email'] },
        output: { delivered: { title: 'Order SO-2026-0917: 1 difference(s)', body: 'CHR-ERGO-2: ordered 6, invoiced 5.', channels: ['inapp', 'email'] } },
    },
};

