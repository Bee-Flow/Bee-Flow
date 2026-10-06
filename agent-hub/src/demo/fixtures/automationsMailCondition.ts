/**
 * "Fabrikam attachments by type": the Automations demo's Condition node after
 * a list of mails, so the Condition editor can be looked at (and
 * screenshotted) against the flow people actually build:
 *
 *   Manual trigger → Search (pinned, 4 of 201) → Read many (one call, 4 mails)
 *   → Condition (keep the mails that have a PDF) → Read attachment (once per
 *   attachment of every mail).
 *
 * The mails differ on purpose, so every obvious task gives a different answer:
 * three of the four carry a PDF, one carries only a Word file and a PowerPoint;
 * three come from Fabrikam, one from Contoso. Next to the documents every mail
 * has a logo image, the way a newsletter-style mail does.
 *
 * "Read attachment" reads its list from "Read many", NOT from the Condition,
 * exactly like the flow this was taken from: on the canvas the Condition sits
 * in between, but what it keeps does not reach the step after it.
 *
 * A second automation, "Fabrikam attachments split by type", is the same mails
 * done the way the fixed Condition builds it: a Condition with three outputs
 * (pdf / word / powerpoint + Otherwise) that works through the attachments of
 * every mail, and "Read attachment" on the pdf output reading what that output
 * holds (4 of the 11 attachments).
 *
 * Shapes follow server/integrations/gmailTools.js (gmail_read_many: messages,
 * count, notFound, failed), the filter step of
 * server/core/automationRunner/execCollections.js (items, count, inputCount,
 * rejectedCount) and the per-item envelope of execForEachStep. Everything is
 * invented; addresses use the reserved `.example` domain.
 */

import { minutesAgo } from './common';
import { ME } from './automationsPeople';
import { opaqueId } from './automationsMailFanout';
import type { DemoRun } from './automationsRuns';

type Obj = Record<string, unknown>;

export const MAIL_CONDITION_AUTOMATION_ID = 'auto_demo_mail_condition';
export const MAIL_CONDITION_AUTOMATION_TITLE = 'Fabrikam attachments by type';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PNG = 'image/png';

const FABRIKAM = 'Fabrikam Tankpas <no-reply@fabrikam.example>';
const CONTOSO = 'Contoso Facilitair <facilitair@contoso.example>';
const TO = 'finance@contoso.example';
const QUERY = 'has:attachment newer_than:120d';

interface MailSeed { id: string; from: string; subject: string; date: string; files: Array<[string, string, number]> }

/** Newest first, as the search returns them. */
const MAILS: MailSeed[] = [
    {
        id: '1998e2b47c0a5d31', from: FABRIKAM, subject: 'Je Fabrikam factuur F-2026-0917', date: 'Tue, 29 Sep 2026 06:41:09 +0000 (UTC)',
        files: [['Factuur_F-2026-0917.pdf', PDF, 48_213], ['Specificatie_F-2026-0917.docx', DOCX, 21_904], ['Fabrikam_logo.png', PNG, 4_812]],
    },
    {
        id: '19947f0c2e6b18a4', from: CONTOSO, subject: 'Offerte schoonmaak Q4', date: 'Fri, 28 Aug 2026 06:38:52 +0000 (UTC)',
        files: [['Offerte_schoonmaak_Q4.pdf', PDF, 112_480], ['Contoso_logo.png', PNG, 3_977]],
    },
    {
        id: '198fd03a91c47e52', from: FABRIKAM, subject: 'Nieuwe tarieven en voorwaarden 2027', date: 'Thu, 30 Jul 2026 06:44:17 +0000 (UTC)',
        files: [['Tarieven_2027.pptx', PPTX, 1_284_115], ['Voorwaarden_2027.docx', DOCX, 38_640], ['Fabrikam_logo.png', PNG, 4_812]],
    },
    {
        id: '198b6e215f0d93c7', from: FABRIKAM, subject: 'Je Fabrikam factuur F-2026-0630', date: 'Mon, 29 Jun 2026 06:40:31 +0000 (UTC)',
        files: [['Factuur_F-2026-0630.pdf', PDF, 47_388], ['Bezorgbewijs_0630.pdf', PDF, 18_022], ['Fabrikam_logo.png', PNG, 4_812]],
    },
];

const bodyOf = (m: MailSeed) => `Beste klant,\n\nIn de bijlage vind je de stukken bij "${m.subject}".\n\nMet vriendelijke groet,\n${m.from.split(' <')[0]}`;

/** gmail_read's shape of one mail (gmail_read_many returns a list of these). */
const read = (m: MailSeed, mi: number) => ({
    id: m.id,
    threadId: m.id,
    from: m.from,
    to: TO,
    subject: m.subject,
    date: m.date,
    body: bodyOf(m),
    attachments: m.files.map(([filename, mimeType, size], i) => ({
        filename, mimeType, size, attachmentId: opaqueId(500 + mi * 10 + i), canOCR: mimeType !== PNG, messageId: m.id, threadId: m.id,
    })),
});

const MESSAGES = MAILS.map(read);

const SEARCH = {
    query: QUERY,
    total: 201,
    results: MAILS.map(m => ({ id: m.id, to: TO, date: m.date, from: m.from, isBulk: false, snippet: bodyOf(m).replace(/\s+/g, ' ').slice(0, 120), subject: m.subject, precedence: null, hasListUnsubscribe: false })),
};

const READ_MANY = { messages: MESSAGES, count: MESSAGES.length, notFound: [], failed: [] };

/** What the Condition keeps: the mails with a PDF among their attachments. */
export const CONDITION_EXPR = 'contains(item.attachments[*].mimeType, "pdf")';
const KEPT = MESSAGES.filter(m => m.attachments.some(a => a.mimeType.includes('pdf')));
const CONDITION_OUT = { items: KEPT, count: KEPT.length, inputCount: MESSAGES.length, rejectedCount: MESSAGES.length - KEPT.length };

/** One run of "Read attachment": text for a document, the OCR error for the logo. */
function attachmentRow(a: ReturnType<typeof read>['attachments'][number], index: number) {
    if (a.mimeType === PNG) {
        return {
            index, item: a, output: null, status: 'error', errorClass: 'IntegrationError', attempts: 1,
            error: `gmail_read_attachment failed: Could not extract text from ${a.filename} (${a.mimeType}): image attachment, no OCR provider configured.`,
        };
    }
    const content = `${a.filename}\n\n(Invented demo text of this document.)`;
    return {
        index, item: a, status: 'success',
        output: { filename: a.filename, mimeType: a.mimeType, content, charCount: content.length, truncated: false, extractedVia: a.mimeType === PDF ? 'pdfjs' : 'officeparser' },
    };
}

const ATTACHMENT_ROWS = MESSAGES.flatMap(m => m.attachments).map(attachmentRow);
const READ_ATTACHMENTS = {
    iterations: ATTACHMENT_ROWS.length,
    succeeded: ATTACHMENT_ROWS.filter(r => r.status === 'success').length,
    failed: ATTACHMENT_ROWS.filter(r => r.status === 'error').length,
    results: ATTACHMENT_ROWS,
};

const ATTACHMENTS_REF = 'steps.mc_read_many.output.messages[*].attachments';

/** stepId → the row a run of that step recorded; spread into the demo's run engine. */
export const MAIL_CONDITION_STEP_RESULTS: Record<string, { stepType: string; input: unknown; output: unknown }> = {
    mc_search: { stepType: 'integration_action', input: { query: QUERY, maxResults: 4 }, output: SEARCH },
    mc_read_many: { stepType: 'integration_action', input: { messageIds: MAILS.map(m => m.id) }, output: READ_MANY },
    mc_condition: { stepType: 'filter', input: { arrayRef: 'steps.mc_read_many.output.messages', expr: CONDITION_EXPR }, output: CONDITION_OUT },
    mc_read_attachment: { stepType: 'integration_action', input: { overRef: ATTACHMENTS_REF }, output: READ_ATTACHMENTS },
};

// ── The definition ───────────────────────────────────────────────────────

const ref = (path: string) => ({ kind: 'ref', path });
const literal = (value: unknown) => ({ kind: 'literal', value });
const gmailStep = (id: string, label: string, tool: string, extra: Obj): Obj => ({ id, type: 'integration_action', label, tool, appId: 'gmail', ...extra });

/** What "Read attachment" reads from the attachment it loops over. */
const ATTACHMENT_INPUTS = {
    messageId: ref('loop.attachment.messageId'),
    attachmentId: ref('loop.attachment.attachmentId'),
    filename: ref('loop.attachment.filename'),
    mimeType: ref('loop.attachment.mimeType'),
};

/** Search (pinned, 4 mails) then Read many over its results; ids start with `prefix`. */
const searchAndReadMany = (prefix: string): Obj[] => [
    gmailStep(`${prefix}_search`, 'Search', 'gmail_search', {
        inputs: { query: literal(QUERY), maxResults: literal(4) },
        pinnedOutput: SEARCH,
        pinnedAt: minutesAgo(60 * 26),
    }),
    gmailStep(`${prefix}_read_many`, 'Read many', 'gmail_read_many', {
        inputs: { messageIds: ref(`steps.${prefix}_search.output.results[*].id`) },
    }),
];

export function mailConditionDefinition(): Obj {
    return {
        title: MAIL_CONDITION_AUTOMATION_TITLE,
        trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
        steps: [
            ...searchAndReadMany('mc'),
            // The Condition as the editor saves a one-output node in list mode
            // (flow/routeModel.js writeRoute: a `filter`).
            { id: 'mc_condition', type: 'filter', label: 'Condition', arrayRef: 'steps.mc_read_many.output.messages', expr: CONDITION_EXPR },
            gmailStep('mc_read_attachment', 'Read attachment', 'gmail_read_attachment', {
                forEach: { overRef: ATTACHMENTS_REF, itemVar: 'attachment', parents: [{ itemVar: 'message', overRef: 'steps.mc_read_many.output.messages' }] },
                inputs: ATTACHMENT_INPUTS,
            }),
        ],
        edges: [
            { from: 'trg', to: 'mc_search' },
            { from: 'mc_search', to: 'mc_read_many' },
            { from: 'mc_read_many', to: 'mc_condition' },
            { from: 'mc_condition', to: 'mc_read_attachment' },
        ],
    };
}

/** The automation row's own fields; automations.js adds the shared defaults. */
export function mailConditionAutomationFields(): Obj {
    return {
        id: MAIL_CONDITION_AUTOMATION_ID,
        title: MAIL_CONDITION_AUTOMATION_TITLE,
        description: 'Reads the mails with attachments, keeps the ones with a PDF and reads their attachments.',
        definition: mailConditionDefinition(),
        version: 1,
        liveVersion: null,
        liveAt: null,
        neverLive: true,
        isDraft: true,
        isActive: false,
        triggerType: 'manual',
        lastRunAt: minutesAgo(6),
        lastStatus: 'success',
        icon: 'Mail',
        createdAt: minutesAgo(60 * 3),
        updatedAt: minutesAgo(6),
    };
}

/** The one recorded test run: every step went through (the logos failed inside "Read attachment"). */
export function seedMailConditionRuns(): DemoRun[] {
    return [{
        id: 'run_demo_mc_01', automationId: MAIL_CONDITION_AUTOMATION_ID, version: 1, status: 'success', isTest: true,
        triggerKind: 'manual', howStarted: 'manual', startedBy: ME, startedAt: minutesAgo(6), durationMs: 21_300,
        steps: 'SSSS',
        outcome: { code: 'success', params: { step: 'Read attachment', stepId: 'mc_read_attachment', kind: 'list', count: ATTACHMENT_ROWS.length, noun: 'items', where: null }, text: `Read attachment: ${ATTACHMENT_ROWS.length} items found` },
        triggerPayload: null,
    }];
}

// ── Second automation: the attachments split by type ─────────────────────

export const MAIL_SPLIT_AUTOMATION_ID = 'auto_demo_mail_split';
export const MAIL_SPLIT_AUTOMATION_TITLE = 'Fabrikam attachments split by type';

/** The outputs, in case order, and the file type each one keeps. */
export const SPLIT_CASES = ['pdf', 'word', 'powerpoint'] as const;
const CASE_OF_MIME: Record<string, string> = { [PDF]: 'pdf', [DOCX]: 'word', [PPTX]: 'powerpoint' };
const SPLIT_REF = 'steps.ms_read_many.output.messages[*].attachments';

const ALL_ATTACHMENTS = MESSAGES.flatMap(m => m.attachments);
const MATCHES_BY_CASE: Record<string, typeof ALL_ATTACHMENTS> = { pdf: [], word: [], powerpoint: [], default: [] };
for (const a of ALL_ATTACHMENTS) MATCHES_BY_CASE[CASE_OF_MIME[a.mimeType] ?? 'default'].push(a);
const SPLIT_BRANCHES = Object.keys(MATCHES_BY_CASE).filter(k => MATCHES_BY_CASE[k].length > 0).map(k => `case:${k}`);

/** What the list switch recorded (execControl.js, collection mode). */
const SPLIT_OUT = {
    mode: 'collection',
    branch: SPLIT_BRANCHES[0],
    branches: SPLIT_BRANCHES,
    matchesByCase: MATCHES_BY_CASE,
    counts: Object.fromEntries(Object.entries(MATCHES_BY_CASE).map(([k, v]) => [k, v.length])),
    total: ALL_ATTACHMENTS.length,
    matched: SPLIT_BRANCHES.map(b => b.slice(5)).join(','),
};

const PDF_ROWS = MATCHES_BY_CASE.pdf.map(attachmentRow);
const READ_PDFS = { iterations: PDF_ROWS.length, succeeded: PDF_ROWS.length, failed: 0, results: PDF_ROWS };

export const MAIL_SPLIT_STEP_RESULTS: Record<string, { stepType: string; input: unknown; output: unknown }> = {
    ms_search: { stepType: 'integration_action', input: { query: QUERY, maxResults: 4 }, output: SEARCH },
    ms_read_many: { stepType: 'integration_action', input: { messageIds: MAILS.map(m => m.id) }, output: READ_MANY },
    ms_split: { stepType: 'switch', input: { arrayRef: SPLIT_REF }, output: SPLIT_OUT },
    ms_read_attachment: { stepType: 'integration_action', input: { overRef: 'steps.ms_split.output.matchesByCase.pdf' }, output: READ_PDFS },
};

export function mailSplitDefinition(): Obj {
    return {
        title: MAIL_SPLIT_AUTOMATION_TITLE,
        trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
        steps: [
            ...searchAndReadMany('ms'),
            // Several outputs in list mode: a switch with `arrayRef` whose cases are rules.
            {
                id: 'ms_split', type: 'switch', label: 'Condition', arrayRef: SPLIT_REF, routeStyle: 'rules',
                cases: SPLIT_CASES.map(name => ({ name, expr: `equals(fileType(item), "${name}")` })),
            },
            gmailStep('ms_read_attachment', 'Read attachment', 'gmail_read_attachment', {
                forEach: { overRef: 'steps.ms_split.output.matchesByCase.pdf', itemVar: 'attachment' },
                inputs: ATTACHMENT_INPUTS,
            }),
        ],
        edges: [
            { from: 'trg', to: 'ms_search' },
            { from: 'ms_search', to: 'ms_read_many' },
            { from: 'ms_read_many', to: 'ms_split' },
            { from: 'ms_split', to: 'ms_read_attachment', label: 'case:pdf', caseName: 'pdf' },
        ],
    };
}

export function mailSplitAutomationFields(): Obj {
    return {
        ...mailConditionAutomationFields(),
        id: MAIL_SPLIT_AUTOMATION_ID,
        title: MAIL_SPLIT_AUTOMATION_TITLE,
        description: 'Splits the attachments of the mails into PDF, Word and PowerPoint, and reads the PDFs.',
        definition: mailSplitDefinition(),
        lastRunAt: minutesAgo(4),
        updatedAt: minutesAgo(4),
    };
}

export function seedMailSplitRuns(): DemoRun[] {
    return [{
        id: 'run_demo_ms_01', automationId: MAIL_SPLIT_AUTOMATION_ID, version: 1, status: 'success', isTest: true,
        triggerKind: 'manual', howStarted: 'manual', startedBy: ME, startedAt: minutesAgo(4), durationMs: 9_800,
        steps: 'SSSS',
        outcome: { code: 'success', params: { step: 'Read attachment', stepId: 'ms_read_attachment', kind: 'list', count: PDF_ROWS.length, noun: 'items', where: null }, text: `Read attachment: ${PDF_ROWS.length} items found` },
        triggerPayload: null,
    }];
}
