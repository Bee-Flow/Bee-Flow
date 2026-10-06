/**
 * "Fabrikam invoice mails": the Automations demo's Gmail fan-out, so the output
 * tables can be looked at (and screenshotted) against nested per-item data.
 *
 * A search finds 4 mails (of 201). "Read" runs once per mail and returns 16
 * attachments for each: one PDF invoice and fifteen PNG logos and icons from
 * the mail's HTML. "Read attachment" runs once per attachment of every mail.
 * The 4 PDFs give text; the 60 images fail because no OCR provider is set up.
 * "Extract invoice lines" runs once per PDF text and answers in its output
 * schema: an invoice, its lines, and the taxes of each line. That is three
 * list levels to open one after the other.
 *
 * All 4 mails share one subject, so a breadcrumb has to tell rows with the
 * same title apart. Shapes follow server/integrations/gmailTools.js and the
 * per-item envelope of execForEachStep (core/automationRunner/execFlow.js),
 * and the search summary keeps the key order Postgres JSONB gives it.
 * Everything is invented; addresses use the reserved `.example` domain.
 */

import { minutesAgo } from './common';
import { ME } from './automationsPeople';
import type { DemoRun } from './automationsRuns';

type Obj = Record<string, unknown>;

export const MAIL_FANOUT_AUTOMATION_ID = 'auto_demo_mail_fanout';
export const MAIL_FANOUT_AUTOMATION_TITLE = 'Fabrikam invoice mails';

// ── The mails ────────────────────────────────────────────────────────────

interface LineSeed { sku: string; description: string; quantity: number; price: number; rate: number }
interface MailSeed { id: string; date: string; issued: string; invoice: string; pdfSize: number; lines: LineSeed[] }

const FROM = 'Fabrikam Tankpas <no-reply@fabrikam.example>';
const TO = 'finance@contoso.example';
const SUBJECT = 'Je Fabrikam factuur';
const QUERY = 'from:fabrikam.example factuur';

const line = (sku: string, description: string, quantity: number, price: number, rate = 21): LineSeed => ({ sku, description, quantity, price, rate });

/** Newest first, as the search returns them. Same subject on purpose. */
const MAILS: MailSeed[] = [
    {
        id: '1998e2b47c0a5d31', date: 'Tue, 29 Sep 2026 06:41:09 +0000 (UTC)', issued: '29-09-2026', invoice: 'F-2026-0917', pdfSize: 48_213,
        lines: [
            line('DSK-180-OAK', 'Zit-sta bureau 180×80, eiken', 4, 649),
            line('CHR-ERGO-2', 'Ergonomische bureaustoel', 5, 389),
            line('BK-ERGO-NL', 'Handboek ergonomie op kantoor', 2, 34.95, 9),
        ],
    },
    {
        id: '19947f0c2e6b18a4', date: 'Fri, 28 Aug 2026 06:38:52 +0000 (UTC)', issued: '28-08-2026', invoice: 'F-2026-0828', pdfSize: 47_902,
        lines: [line('MON-27-4K', 'Monitor 27 inch 4K', 2, 329), line('ARM-DUAL', 'Monitorarm, dubbel', 2, 89.5)],
    },
    {
        id: '198fd03a91c47e52', date: 'Thu, 30 Jul 2026 06:44:17 +0000 (UTC)', issued: '30-07-2026', invoice: 'F-2026-0731', pdfSize: 48_655,
        lines: [line('LMP-LED', 'Bureaulamp LED', 6, 54.95), line('CBL-USBC-2M', 'USB-C kabel 2 m', 10, 12.5)],
    },
    {
        id: '198b6e215f0d93c7', date: 'Mon, 29 Jun 2026 06:40:31 +0000 (UTC)', issued: '29-06-2026', invoice: 'F-2026-0630', pdfSize: 47_388,
        lines: [line('DSK-140-WHT', 'Bureau 140×70, wit', 2, 279), line('DEL-STD', 'Bezorging en montage', 1, 75)],
    },
];

/** The images of the mail's HTML, in the order Gmail lists the parts. */
const IMAGES: Array<[string, number]> = [
    ['Fabrikam_socialmedia_youtube.png', 1_571],
    ['Fabrikam_invoice_header.png', 6_709],
    ['Fabrikam_socialmedia_header.png', 3_240],
    ['Fabrikam_contact_header.png', 2_214],
    ['Fabrikam_logo.png', 4_812],
    ['Fabrikam_image_driver.png', 139_822],
    ['Fabrikam_socialmedia_facebook.png', 1_498],
    ['Fabrikam_socialmedia_instagram.png', 1_622],
    ['Fabrikam_socialmedia_linkedin.png', 1_387],
    ['Fabrikam_icon_fuel.png', 1_104],
    ['Fabrikam_icon_charging.png', 1_216],
    ['Fabrikam_icon_carwash.png', 1_093],
    ['Fabrikam_app_store_badge.png', 5_431],
    ['Fabrikam_google_play_badge.png', 5_978],
    ['Fabrikam_footer.png', 9_305],
];
/** Where the PDF sits among the images: just past the five a preview shows. */
const PDF_AT = 5;

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A long, opaque, deterministic id in Gmail's attachment-id alphabet (xorshift32). */
function opaqueId(seed: number, length = 88): string {
    let x = (seed * 2_654_435_761) >>> 0 || 1;
    let out = '';
    for (let i = 0; i < length; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        out += ID_ALPHABET[x & 63];
    }
    return out;
}

interface Attachment { filename: string; mimeType: string; size: number; attachmentId: string; canOCR: boolean; messageId: string; threadId: string }

/** The 16 attachments of one mail, with the 7 keys gmail_read gives each. */
function attachmentsOf(m: MailSeed, mailIndex: number): Attachment[] {
    const files = IMAGES.map(([filename, size]) => ({ filename, mimeType: 'image/png', size }));
    files.splice(PDF_AT, 0, { filename: `Factuur_${m.invoice}.pdf`, mimeType: 'application/pdf', size: m.pdfSize });
    return files.map((f, i) => ({
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        attachmentId: opaqueId(mailIndex * 100 + i + 1),
        canOCR: f.mimeType === 'application/pdf',
        messageId: m.id,
        threadId: m.id,
    }));
}

const bodyOf = (m: MailSeed) => [
    'Beste klant,',
    '',
    `In de bijlage vind je factuur ${m.invoice} van ${m.issued}. Het bedrag schrijven we binnen 14 dagen af van je rekening.`,
    'Je facturen staan ook altijd in de Fabrikam app. Vragen? Bel of mail gerust met onze klantenservice.',
    '',
    'Met vriendelijke groet,',
    'Fabrikam Tankpas',
].join('\n');

/** gmail_search's summary of one mail: its 9 keys in JSONB order. */
const summary = (m: MailSeed) => ({
    id: m.id,
    to: TO,
    date: m.date,
    from: FROM,
    isBulk: false,
    snippet: bodyOf(m).replace(/\s+/g, ' ').slice(0, 160).trim(),
    subject: SUBJECT,
    precedence: null,
    hasListUnsubscribe: false,
});

/** gmail_read's answer for one mail. */
const read = (m: MailSeed, mailIndex: number) => ({
    id: m.id, threadId: m.id, from: FROM, to: TO, subject: SUBJECT, date: m.date, body: bodyOf(m), attachments: attachmentsOf(m, mailIndex),
});

const SEARCH = { query: QUERY, total: 201, results: MAILS.map(summary) };

// ── The invoices inside the PDFs ─────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
const euro = (n: number) => n.toFixed(2).replace('.', ',');
const netOf = (l: LineSeed) => round2(l.quantity * l.price);
const taxOf = (l: LineSeed) => round2(netOf(l) * l.rate / 100);

/** What the AI step reads out of one PDF: invoice › lines › taxes. */
function extracted(m: MailSeed) {
    return {
        invoice: { number: m.invoice, total: round2(m.lines.reduce((sum, l) => sum + netOf(l) + taxOf(l), 0)), currency: 'EUR' },
        lines: m.lines.map(l => ({
            sku: l.sku, description: l.description, quantity: l.quantity, price: l.price, taxes: [{ rate: l.rate, amount: taxOf(l) }],
        })),
    };
}

/** The text pdfjs gets out of one invoice PDF. */
function pdfText(m: MailSeed): string {
    const { invoice } = extracted(m);
    return [
        `FACTUUR ${m.invoice}`,
        'Fabrikam B.V.',
        `Factuurdatum: ${m.issued}`,
        'Klant: Contoso B.V.',
        '',
        ...m.lines.map(l => `${l.sku}  ${l.description}  ${l.quantity} x ${euro(l.price)}  btw ${l.rate}%`),
        '',
        `Totaal incl. btw: EUR ${euro(invoice.total)}`,
    ].join('\n');
}

// ── What each step returned ──────────────────────────────────────────────

const OCR_HINT = 'Scanned or image-based files need an OCR provider (Azure Document Intelligence or Mistral OCR) configured.';

type ItemRow = { index: number; item: unknown; output: unknown; status: string; [key: string]: unknown };

/** The per-item envelope a "run once per item" step records. */
const perItem = (results: ItemRow[]) => {
    const failed = results.filter(r => r.status === 'error').length;
    return { iterations: results.length, succeeded: results.length - failed, failed, results };
};

/** One run of "Read attachment": text for a PDF, the extraction error for an image. */
function attachmentRow(m: MailSeed, a: Attachment, index: number): ItemRow {
    if (a.canOCR) {
        const content = pdfText(m);
        const sourceHandle = { kind: 'gmail_attachment', messageId: a.messageId, attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType, size: a.size };
        const output = { filename: a.filename, mimeType: a.mimeType, content, charCount: content.length, truncated: false, extractedVia: 'pdfjs', sourceHandle };
        return { index, item: a, output, status: 'success' };
    }
    return {
        index,
        item: a,
        output: null,
        error: `gmail_read_attachment failed: Could not extract text from ${a.filename} (${a.mimeType}): image attachment, no OCR provider configured. ${OCR_HINT}`,
        errorClass: 'IntegrationError',
        attempts: 1,
        status: 'error',
    };
}

const ATTACHMENT_ROWS = MAILS
    .flatMap((m, mi) => attachmentsOf(m, mi).map(a => ({ m, a })))
    .map(({ m, a }, index) => attachmentRow(m, a, index));

const ATTACHMENTS_REF = 'steps.mf_read.output.results[*].output.attachments';
// Only a PDF row has an output with `content`: the [*] walk skips the 60
// images (no output), so the step runs once per PDF text.
const PDF_TEXTS_REF = 'steps.mf_read_attachment.output.results[*].output.content';

/** stepId → the row a run of that step recorded; spread into the demo's run engine. */
export const MAIL_FANOUT_STEP_RESULTS: Record<string, { stepType: string; input: unknown; output: unknown }> = {
    mf_search: {
        stepType: 'integration_action',
        input: { query: QUERY, maxResults: 4 },
        output: SEARCH,
    },
    mf_read: {
        stepType: 'integration_action',
        input: { overRef: 'steps.mf_search.output.results' },
        output: perItem(MAILS.map((m, index) => ({ index, item: summary(m), output: read(m, index), status: 'success' }))),
    },
    mf_read_attachment: {
        stepType: 'integration_action',
        input: { overRef: ATTACHMENTS_REF },
        output: perItem(ATTACHMENT_ROWS),
    },
    mf_extract: {
        stepType: 'ai_step',
        input: { modelTier: 'fast', overRef: PDF_TEXTS_REF },
        output: perItem(MAILS.map((m, index) => ({ index, item: pdfText(m), output: extracted(m), status: 'success' }))),
    },
};

// ── The definition ───────────────────────────────────────────────────────

const ref = (path: string) => ({ kind: 'ref', path });
const literal = (value: unknown) => ({ kind: 'literal', value });

const obj = (properties: Obj, required?: string[]) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const list = (items: Obj) => ({ type: 'array', items });
const typed = (type: string, description?: string) => ({ type, ...(description ? { description } : {}) });

/** The AI step's declared answer: an invoice, its lines, the taxes per line. */
const INVOICE_SCHEMA = obj({
    invoice: obj({ number: typed('string', 'Invoice number'), total: typed('number', 'Total including tax'), currency: typed('string') }),
    lines: list(obj({
        sku: typed('string'),
        description: typed('string'),
        quantity: typed('number'),
        price: typed('number', 'Unit price excluding tax'),
        taxes: list(obj({ rate: typed('number', 'Percentage'), amount: typed('number') })),
    })),
}, ['invoice', 'lines']);

const gmailStep = (id: string, label: string, tool: string, extra: Obj): Obj => ({ id, type: 'integration_action', label, tool, appId: 'gmail', ...extra });

function mailFanoutDefinition(): Obj {
    return {
        title: MAIL_FANOUT_AUTOMATION_TITLE,
        trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
        steps: [
            gmailStep('mf_search', 'Search', 'gmail_search', {
                inputs: { query: literal(QUERY), maxResults: literal(4) },
                pinnedOutput: SEARCH,
                pinnedAt: minutesAgo(60 * 26),
            }),
            gmailStep('mf_read', 'Read', 'gmail_read', {
                forEach: { overRef: 'steps.mf_search.output.results', itemVar: 'result' },
                inputs: { messageId: ref('loop.result.id') },
            }),
            gmailStep('mf_read_attachment', 'Read attachment', 'gmail_read_attachment', {
                forEach: { overRef: ATTACHMENTS_REF, itemVar: 'attachment', parents: [{ itemVar: 'result', overRef: 'steps.mf_read.output.results' }] },
                inputs: {
                    messageId: ref('loop.attachment.messageId'),
                    attachmentId: ref('loop.attachment.attachmentId'),
                    filename: ref('loop.attachment.filename'),
                    mimeType: ref('loop.attachment.mimeType'),
                },
            }),
            {
                id: 'mf_extract',
                type: 'ai_step',
                label: 'Extract invoice lines',
                modelTier: 'fast',
                forEach: { overRef: PDF_TEXTS_REF, itemVar: 'invoiceText' },
                prompt: 'Read this invoice. Answer with its number, total and currency, and every line with its sku, description, quantity, unit price and taxes.\n\n{{ loop.invoiceText }}',
                outputSchema: INVOICE_SCHEMA,
            },
        ],
        edges: [
            { from: 'trg', to: 'mf_search' },
            { from: 'mf_search', to: 'mf_read' },
            { from: 'mf_read', to: 'mf_read_attachment' },
            { from: 'mf_read_attachment', to: 'mf_extract' },
        ],
    };
}

/** The automation row's own fields; automations.js adds the shared defaults. */
export function mailFanoutAutomationFields(): Obj {
    return {
        id: MAIL_FANOUT_AUTOMATION_ID,
        title: MAIL_FANOUT_AUTOMATION_TITLE,
        description: 'Reads every Fabrikam invoice mail and each of its attachments, and extracts the lines of the PDF invoices.',
        definition: mailFanoutDefinition(),
        version: 1,
        liveVersion: 1,
        liveAt: minutesAgo(60 * 26),
        isActive: true,
        triggerType: 'manual',
        lastRunAt: minutesAgo(9),
        lastStatus: 'success',
        icon: 'Mail',
        createdAt: minutesAgo(60 * 28),
        updatedAt: minutesAgo(9),
    };
}

/** The one recorded run: every step went through (60 attachments failed inside "Read attachment"). */
export function seedMailFanoutRuns(): DemoRun[] {
    return [{
        id: 'run_demo_mf_01', automationId: MAIL_FANOUT_AUTOMATION_ID, version: 1, status: 'success', isTest: false,
        triggerKind: 'manual', howStarted: 'manual', startedBy: ME, startedAt: minutesAgo(9), durationMs: 97_400,
        steps: 'SSSS',
        outcome: { code: 'success', params: { step: 'Extract invoice lines', stepId: 'mf_extract', kind: 'list', count: 4, noun: 'items', where: null }, text: 'Extract invoice lines: 4 items found' },
        triggerPayload: null,
    }];
}

// ── The Gmail actions in the demo catalog ────────────────────────────────

const str = (description: string) => ({ type: 'string', description });

const inputs = (properties: Obj, required: string[]) => ({ type: 'object', properties, required });

const gmailAction = (name: string, label: string, description: string, inputSchema: Obj, outputSample: Obj) => ({
    name, label, description, inputSchema, outputSample, sideEffect: false, effect: 'reads', integrationId: 'gmail', integrationLabel: 'Gmail',
});

/** Gmail in the catalog (GET /api/automation/catalog); the samples are server/automation/outputSchemas.js's. */
export const MAIL_FANOUT_CATALOG_APP = {
    id: 'gmail',
    label: 'Gmail',
    available: true,
    actions: [
        gmailAction('gmail_search', 'Search', 'Searches the mailbox with Gmail search syntax and returns a summary of each mail.', inputs({
            query: str('Gmail search query, such as from:, subject:, after: or has:attachment'),
            maxResults: { type: 'integer', default: 10, description: 'How many mails at most (up to 500)' },
        }, ['query']), {
            results: [
                { id: 'msg-1', from: 'sender@example.com', to: 'me@example.com', subject: 'Sample invoice', date: 'Mon, 06 Apr 2026 08:23:19 -0700', snippet: 'Beste klant, hierbij uw factuur...' },
                { id: 'msg-2', from: 'biller@example.com', to: 'me@example.com', subject: 'Factuur januari', date: 'Mon, 06 Apr 2026 09:15:42 -0700', snippet: 'Bedrag: €234.50' },
            ],
            total: 2,
        }),
        gmailAction('gmail_read', 'Read', 'Reads the full content of one mail by its message id.', inputs({
            messageId: str('The Gmail message id to read'),
        }, ['messageId']), {
            id: 'msg-1', threadId: 'th-1', from: 'sender@example.com', to: 'me@example.com', subject: 'Sample invoice', date: 'Mon, 06 Apr 2026 08:23:19 -0700',
            body: 'Beste klant,\n\nHierbij ontvangt u onze factuur met nummer 2026-001.\n\nBedrag: €1,234.50 (incl. BTW)\nBetalingstermijn: 30 dagen.\n\nMet vriendelijke groet.',
            attachments: [{ attachmentId: 'attach-1', filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf', size: 45678, canOCR: true, messageId: 'msg-1', threadId: 'th-1' }],
        }),
        gmailAction('gmail_read_attachment', 'Read attachment', 'Downloads one attachment of a mail and extracts its text.', inputs({
            messageId: str('The message the attachment belongs to'),
            attachmentId: str('The attachment to read'),
            filename: str('The file name of the attachment'),
            mimeType: str('The MIME type of the attachment'),
        }, ['messageId', 'attachmentId']), {
            filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf', content: 'INVOICE 2026-001\nDate: 2026-04-06\nAmount Due: €1,234.50',
            charCount: 1847, truncated: false, extractedVia: 'pdfjs',
            sourceHandle: { kind: 'gmail_attachment', messageId: 'msg-1', attachmentId: 'attach-1', filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf', size: 45678 },
        }),
    ],
};
