/**
 * App Studio catalog — the action and step tables: the top-level action kinds
 * (ACTION_SPECS) and the sequence-step kinds (STEP_SPECS), plus the native AI /
 * email / file field tables both of them share.
 */

'use strict';

const { LIMITS } = require('./limits');

// Top-level action kinds (definition.actions map values). A v1 bare action or
// a v2 { kind:'sequence', steps:[Step] }. `open_modal` is new in v2.
const ACTION_KINDS = ['run_automation', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'create_record', 'navigate', 'toast', 'open_url', 'open_modal', 'close_modal', 'sequence'];

// Step kinds inside a sequence. A bare v1 action is an implicit 1-step
// sequence, so the v1 kinds appear here too. Each step is tagged client/server
// and mutatesData — the executor runs client steps in the browser and server
// steps on the API; validation enforces that a client-only kind carries no
// data-mutation fields (the client/server partition invariant).
const STEP_KINDS = [
    'navigate', 'toast', 'open_url', 'open_modal', 'close_modal', 'reset_form', 'download_file', 'confirm', 'set_variable', 'refresh',
    'run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval',
    'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse',
    'condition', 'loop', 'switch',
];
// Steps that read/write persistent DATA / call the model server-side. Everything
// else is client-only chrome/navigation/flow-control and MUST NOT mutate data.
// The native AI steps resolve the OWNER's model tier and run acts-as-owner, so
// they belong here (server-executed) alongside the record kinds. generate_file
// and file_intake write bytes into the owner's storage envelope — server-side
// by definition, and so are fill_document and generate_presentation, which
// render one, and redact_pdf, which writes a cleaned copy of one.
const DATA_MUTATING_STEP_KINDS = ['run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse'];
const CLIENT_STEP_KINDS = STEP_KINDS.filter((k) => !DATA_MUTATING_STEP_KINDS.includes(k));

const TOAST_TONES = ['info', 'success', 'warning', 'danger'];

/**
 * Action = { kind: 'run_automation'|'navigate'|'toast'|'open_url', ...fields }.
 * `kind` is the discriminator; the map key in definition.actions IS the
 * action's id (never duplicated inside the object).
 *
 * Per-kind action fields (validated in validate.js):
 *   run_automation: { automationId: string|null, inputMapping?: { [param]:
 *                     {kind:'static',value} | {kind:'field',name,formId?} },
 *                     onSuccess?: Effects, onError?: Effects }
 *   navigate:       { screenId, params? } — params is a map of
 *                     { [key]: {kind:'static',value} | {kind:'formula',expr} }
 *                     resolved client-side and exposed as screen.params
 *   toast:          { message, tone? }
 *   open_url:       { url (https), newTab? }
 * Effects (bounded — never chains): { toast?: {message, tone?}, navigateTo?: screenId|null }
 */
// ---------------------------------------------------------------------------
// Native AI action/step fields. Shared between the top-level action catalog
// (ACTION_SPECS — bare v1 actions wired to a control) and the sequence-step
// catalog (STEP_SPECS). Handled server-side by appStudio/aiRuntime.js +
// actionExecutor.js. Field types beyond the record kinds:
//   'aiSchema'  — [{ name, type, description?, required? }] output field list
//                 (type ∈ AI_SCHEMA_FIELD_TYPES)
//   'aiWriteTo' — { tableId, mapping: { [column]: <schema field name> },
//                   upsertOn?: <column> — read the same document twice and the
//                   same rows are UPDATED instead of doubled,
//                   constants?: { [column]: <binding> } }
//                 `constants` is resolved ONCE and stamped on every extracted
//                 row. Without it the rows are orphans: nothing records which
//                 ticket or document they came from, so they cannot be shown in
//                 context and a retention purge cannot find them.
//   'stringList' — knowledge base ids for RAG grounding
// ---------------------------------------------------------------------------
const AI_SCHEMA_FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'array', 'object'];

// How the step hands documents to the model.
//   'auto'   — extracted text; page images only when the text layer fails;
//              plus a native PDF document block when the provider takes one.
//   'text'   — text only, never pictures. Cheap; right for a purchase order.
//   'images' — FORCE page rendering even when the text layer is dense. A
//              vector technical drawing has a rich text layer, so 'auto'
//              never rasterises it and the model never sees the geometry —
//              this mode exists for exactly that document.
const AI_DOCUMENT_MODES = ['auto', 'text', 'images'];

const AI_EXTRACT_FIELDS = {
    source: { type: 'binding', required: true },     // a File-upload input's value (descriptor or array)
    schema: { type: 'aiSchema', required: true },    // fields to extract per record/row
    // Live rows appended to the extraction prompt. This is what lets one step
    // read a drawing WHILE knowing the purchase order's quantities and the
    // shop's operations vocabulary — the cross-document join.
    promptContext: { type: 'binding' },
    // ONE more source is never enough: an AI draft needs the conversation AND
    // the order lines it is about, and a table can only be pointed at once.
    // Each entry is labelled, so the model is told what it is reading instead
    // of being handed two anonymous arrays and left to guess which is which.
    contextSources: { type: 'contextSources' },
    documentMode: { type: 'enum', values: AI_DOCUMENT_MODES, default: 'auto' },
    modelTier: { type: 'string', maxLen: 60 },
    knowledgeBaseIds: { type: 'stringList' },
    // LARGE datasets (genome files) the model may query in bounded slices
    // during this step — a list of studio_dataset descriptors or dataset ids.
    // The step pre-authorizes each one (owner-scoped, status 'ready') and hands
    // the model ONE closed-over query tool; the file itself never enters the
    // prompt. See aiRuntime.runStructuredWithTools.
    datasets: { type: 'binding' },
    writeTo: { type: 'aiWriteTo' },                  // optional: insert each extracted row into a table
    // 'summary' keeps the extracted rows OUT of the step result, the way
    // file_intake's own resultDetail does. A step that both extracts 163 rows
    // and writes them would otherwise ship them back as well and trip the 64KB
    // body cap — and the caller already has them, in the table.
    resultDetail: { type: 'enum', values: ['full', 'summary'], default: 'full' },
    resultVar: { type: 'string', maxLen: 60 },
};
const AI_GENERATE_FIELDS = {
    prompt: { type: 'string', required: true, maxLen: 8000 },
    // Live data appended to the prompt as context. Without it `prompt` is a
    // fixed string, so an "AI draft" button has no ticket to draft ABOUT — point
    // this at the open record or thread.
    promptContext: { type: 'binding' },
    // ONE more source is never enough: an AI draft needs the conversation AND
    // the order lines it is about, and a table can only be pointed at once.
    // Each entry is labelled, so the model is told what it is reading instead
    // of being handed two anonymous arrays and left to guess which is which.
    contextSources: { type: 'contextSources' },
    attachments: { type: 'binding' },                // optional File-upload input value(s)
    documentMode: { type: 'enum', values: AI_DOCUMENT_MODES, default: 'auto' },
    output: { type: 'enum', values: ['text', 'structured'], default: 'text' },
    // Let the model write MARKDOWN and hand back HTML. Models are markedly
    // better at markdown than at hand-rolled HTML, and it costs far fewer
    // tokens: no tag soup in the response, and no prompt spent explaining
    // which tags are allowed. Only meaningful with output 'text'.
    markdownToHtml: { type: 'boolean', default: false },
    schema: { type: 'aiSchema' },                    // used when output === 'structured'
    modelTier: { type: 'string', maxLen: 60 },
    knowledgeBaseIds: { type: 'stringList' },
    // Same contract as ai_extract.datasets — bounded genome-slice tool access.
    datasets: { type: 'binding' },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};
const KB_QUERY_FIELDS = {
    query: { type: 'binding', required: true },
    knowledgeBaseIds: { type: 'stringList', required: true },
    topK: { type: 'int', min: 1, max: 20 },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

/**
 * Send a reply from a mailbox connector.
 *
 * `connectorId` decides the mailbox AND the identity: a runAs:'viewer' mailbox
 * sends as the agent who clicked, a runAs:'owner' one sends from the team
 * address. Threading is derived SERVER-side from replyToRecordId — a client
 * cannot hand us the headers that decide which conversation a message joins.
 *
 * Name the message with replyToRecordId, OR the conversation with
 * replyToThreadKey — a screen that lists conversations has the thread key, not a
 * message id, and without one of the two every reply starts a NEW conversation
 * the customer sees as an unrelated mail.
 *
 * There is deliberately no `bcc`: a support reply never needs one, and it is
 * the field that turns a reply button into a bulk-mail tool.
 */
const SEND_EMAIL_FIELDS = {
    connectorId: { type: 'string', required: true },
    to: { type: 'binding' },                       // defaults to the sender being replied to
    cc: { type: 'binding' },
    subject: { type: 'binding' },                  // defaults to "Re: <original>"
    body: { type: 'binding', required: true },
    bodyFormat: { type: 'enum', values: ['markdown', 'text', 'html'], default: 'markdown' },
    replyToRecordId: { type: 'binding' },          // the message being answered
    replyToThreadKey: { type: 'binding' },         // …or the conversation to answer
    attachments: { type: 'binding' },              // studio attachment descriptors only
    recordOutbound: { type: 'boolean', default: true },
    resultVar: { type: 'string', maxLen: 60 },
};

/**
 * generate_file — render rows into a REAL file (CSV/XLSX/ODS) in the app's
 * attachment store. The result is the bare studio_attachment descriptor
 * { kind, fileId, name, mime, size, rowCount } in `resultVar` — the shape
 * file_preview, send_email.attachments and file-column record writes already
 * accept, so no second delivery mechanism exists.
 *
 * `rows` is the one binding here allowed to READ: a records/aggregate binding
 * resolves through stepDataSource under the VIEWER's access filter (a formula
 * cannot read a table — buildServerScope pins `records` to {}).
 *
 * `columns` makes the file format DATA, not code: bind it to a table whose
 * rows are [{ name, from?, value?, order?, active? }] — `name` is the printed
 * header, `from` picks a field off each row, `value` is a constant. Absent →
 * union-of-keys, first-seen order.
 *
 * attachToRecordId + attachToFieldKey are not decoration: a ledger row with
 * recordId null is readable by the app OWNER only (attachmentAccess.js), so
 * without them the colleague who pressed Generate gets a 404 on Download.
 */
const GENERATE_FILE_FORMATS = ['csv', 'xlsx', 'ods'];
const GENERATE_FILE_FIELDS = {
    rows: { type: 'binding', required: true },
    columns: { type: 'binding' },
    format: { type: 'enum', values: GENERATE_FILE_FORMATS, default: 'csv' },
    fileName: { type: 'binding', required: true },
    delimiter: { type: 'enum', values: [';', ',', '\t'], default: ';' },   // csv only
    includeHeader: { type: 'boolean', default: true },
    // csv only. The byte-order mark stays ON by default because the usual
    // reader of an export is Dutch Excel, which renders Ø and é as mojibake
    // without it. But a CSV written for a MACHINE is the opposite case: the
    // BOM is three bytes glued to the front of the first header cell, so an
    // importer matching on "cadfile" sees "﻿cadfile" and a strict one
    // rejects the file. Turn it off when the reader is a system, not a person.
    bom: { type: 'boolean', default: true },
    sheetName: { type: 'string', maxLen: 31 },                             // xlsx/ods only
    attachToRecordId: { type: 'binding' },
    attachToFieldKey: { type: 'string', maxLen: 100 },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

/**
 * file_intake — redeem a conversation's mailed attachments in bulk, classify
 * each by deterministic rules (no model call: extension → CAD; a filename
 * pattern → purchase order; a PDF with a CAD base-name sibling → drawing),
 * pair drawings with their CAD files, and optionally upsert one row per pair.
 *
 * The attachments and messages tables are derived from the CONNECTOR's sync
 * config (same rule send_email uses) — a client never names them.
 *
 * writeTo reuses the aiWriteTo shape; mapping values name the step's fixed
 * outputs instead of schema fields: base_name, cad_name, cad_file,
 * drawing_name, drawing_file, role, file_name, match_status, part_key,
 * operation, folder, extra_cad. Upserts match on the mapped `base_name` column
 * plus every constant, so re-running the button updates rows instead of
 * duplicating them.
 *
 * The result (resultVar) reports the whole batch honestly:
 *   { filed, total, parts, refused: [{name, reason}], pairs: [...],
 *     poFile, poName, poSource, sheetFile, sheetName, sheets: [...],
 *     lineListFile, lineListName, skippedFolders: [...], emptyFolders: [...],
 *     others: [...], unpairedDrawings: [...], unpairedCad: [...] }
 * A file that fails its malware scan is a NAMED refusal, never a silent hole —
 * and so is a folder that produced no line: `skippedFolders` holds the ones
 * with files but no part (a "Labels" folder of 77 label sheets), `emptyFolders`
 * the ones with a part but no files (an article somebody forgot to attach).
 */
/**
 * fill_document — render a Document the OWNER designed in Studio (an invoice,
 * a quote, a letter on the company's letterhead), filled with this run's
 * values, into a PDF in the app's attachment store.
 *
 * The sibling of generate_file, and the difference is the artefact: that one
 * writes ROWS into a machine-readable file (CSV/XLSX), this one renders a
 * DESIGNED page a person will read or receive. The result is deliberately the
 * same bare studio_attachment descriptor, so file_preview,
 * send_email.attachments and file-column record writes all take it without
 * learning a second shape.
 *
 * `documentId` names one of the OWNER's documents — never the viewer's. An app
 * runs acts-as-owner, and the letterhead the app prints on is the company's,
 * not the person's who pressed the button.
 *
 * `values` is a map of placeholder name → binding, keyed exactly as the
 * document names its holes ({{customer.name}} → "customer.name"). A list
 * placeholder takes a binding that resolves to an ARRAY.
 *
 * attachToRecordId + attachToFieldKey carry the same warning generate_file
 * does: a ledger row with recordId null is readable by the app OWNER only
 * (attachmentAccess.js), so without them the colleague who pressed the button
 * gets a 404 on Download.
 */
const FILL_DOCUMENT_FIELDS = {
    documentVersionId: { type: 'string', maxLen: 100 },
    sectionOverrides: { type: 'recordValues' },
    documentId: { type: 'string', required: true, maxLen: 100 },
    values: { type: 'recordValues' },
    fileName: { type: 'binding' },
    // Only a PRESENTATION document reads it ('' = .pptx); a page is always a PDF.
    format: { type: 'enum', values: ['', 'pptx', 'pdf'], default: '' },
    attachToRecordId: { type: 'binding' },
    attachToFieldKey: { type: 'string', maxLen: 100 },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

/**
 * generate_presentation — slides in, a PowerPoint (or PDF deck) out, in the
 * owner's house style, as the same `studio_attachment` descriptor
 * generate_file / fill_document return. `slides` is the flexible one: the
 * markdown an ai_generate step wrote, a JSON deck, or a records binding over
 * a table whose rows carry a title and content (core/documents/deckCollect.js).
 * attachToRecordId + attachToFieldKey: same reason as generate_file's.
 */
const GENERATE_PRESENTATION_FORMATS = ['pptx', 'pdf'];
// The look vocabulary is owned by core/documents/deckThemeOptions.js.
const DECK_LOOK = require('../../core/documents/deckThemeOptions');
const GENERATE_PRESENTATION_FIELDS = {
    slides: { type: 'binding', required: true },
    title: { type: 'binding' },
    subtitle: { type: 'binding' },
    format: { type: 'enum', values: GENERATE_PRESENTATION_FORMATS, default: 'pptx' },
    fileName: { type: 'binding' },
    houseStyle: { type: 'boolean', default: true },
    // Optional look: the house style decides whatever is left blank.
    preset: { type: 'enum', values: ['', ...DECK_LOOK.DECK_PRESET_IDS], default: '' },
    accent: { type: 'binding' },
    font: { type: 'enum', values: ['', ...DECK_LOOK.DECK_FONTS], default: '' },
    coverStyle: { type: 'enum', values: ['', ...Object.keys(DECK_LOOK.COVER_STYLES)], default: '' },
    tableStyle: { type: 'enum', values: ['', ...Object.keys(DECK_LOOK.TABLE_STYLES)], default: '' },
    logoPlacement: { type: 'enum', values: ['', ...Object.keys(DECK_LOOK.LOGO_PLACEMENTS)], default: '' },
    background: { type: 'binding' },
    footerText: { type: 'binding' },
    attachToRecordId: { type: 'binding' },
    attachToFieldKey: { type: 'string', maxLen: 100 },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

/**
 * redact_pdf — a PDF in, a copy without the marks that identify a person or the
 * customer out (names, initials in Author/Checked fields, contact details, the
 * customer's logo, document metadata), as the same `studio_attachment`
 * descriptor the file-producing steps return, plus `removed`: what went.
 * `terms` adds words the customer is known by; `useAi` lets the owner's
 * model flag names the rules cannot know. Everything else on the page is left
 * byte-for-byte (core/documents/pdfRedaction).
 */
const REDACT_PDF_FIELDS = {
    source: { type: 'binding', required: true },
    terms: { type: 'binding' },
    useAi: { type: 'boolean', default: true },
    fileName: { type: 'binding' },
    attachToRecordId: { type: 'binding' },
    attachToFieldKey: { type: 'string', maxLen: 100 },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

const FILE_INTAKE_FIELDS = {
    connectorId: { type: 'string', required: true },
    threadKey: { type: 'binding', required: true },
    poPattern: { type: 'string', maxLen: 200 },    // default: inkoopbestelbon|purchase.?order|bestelbon|^PO\d+
    /**
     * Which CAD format is the DELIVERABLE when a part arrives as several.
     *
     * The ranking behind this ('step' first, then dxf, then the wider 3D zoo)
     * suits a portal whose line list names the .step. A waterjet shop often
     * names the .dxf every time — including for parts that only shipped a
     * solid — because for them the DXF is the cutting file and the solid is
     * reference. Only the HEAD of the ranking moves; nothing else reshuffles,
     * and the default keeps every existing app where it was.
     */
    cadPreferred: { type: 'enum', values: ['step', 'dxf'], default: 'step' },
    /**
     * How much of the report to hand back. 'summary' drops `pairs` and the
     * other per-file arrays and keeps the counts.
     *
     * Not a nicety: a step's result variable travels back to the browser and
     * then rides in the BODY of every later step of the same action. `pairs`
     * holds two file descriptors per part, so a 243-file order pushed that body
     * past the 64 kB request ceiling and every step after the intake answered
     * 413. A caller that loops over the written rows instead of over `pairs`
     * asks for 'summary' and stops carrying the order around.
     */
    resultDetail: { type: 'enum', values: ['full', 'summary'], default: 'full' },
    writeTo: { type: 'aiWriteTo' },                // one row per CAD/drawing pair
    // "This conversation has nothing attached" is a useful answer when a
    // PERSON pressed a button, and pure noise when the step runs on its own —
    // opening a plain question would fail the whole sequence with an error
    // toast. Opt in and an empty conversation is a successful no-op instead.
    // No default: a definition that never set it stays byte-identical.
    allowEmpty: { type: 'boolean' },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

/**
 * dataset_query — bounded slice out of a LARGE dataset (a multi-GB genome
 * file uploaded through input_dataset and indexed at ingest). Exactly ONE of
 * gene | region | rsid selects the slice; the server range-reads only the
 * blocks that can hold it (core/datasets/query) and returns ≤`limit` rows.
 * Truncation is always REPORTED in the result (`truncated` + `notes`), never
 * silent.
 *
 * `dataset` takes the studio_dataset descriptor an input_dataset component
 * registered (or a bare dataset id string); resolution is OWNER-scoped, so a
 * forged foreign id can never resolve — same discipline as attachments.
 *
 * `writeTo` reuses the aiWriteTo shape; mapping values name the row fields:
 * chrom, pos, id, ref, alt, qual, filter, info (JSON text), plus `gene` /
 * `region` stamped from the query itself.
 *
 * `resultDetail:'summary'` drops `rows` and keeps counts — the same 64 kB
 * step-body lesson file_intake documents above.
 */
const DATASET_QUERY_FIELDS = {
    dataset: { type: 'binding', required: true },
    gene: { type: 'binding' },
    region: { type: 'binding' },
    rsid: { type: 'binding' },
    filterPass: { type: 'boolean' },
    minQual: { type: 'int', min: 0, max: 100000 },
    limit: { type: 'int', min: 1, max: 200 },
    includeGenotypes: { type: 'boolean' },
    writeTo: { type: 'aiWriteTo' },
    resultDetail: { type: 'enum', values: ['full', 'summary'], default: 'full' },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

/**
 * ai_browse — an AI agent browses the live web (headless Chromium) and the
 * viewer watches the screenshot stream in a browser_view component. The step
 * runs ONLY on the dedicated streaming endpoint (POST …/step/stream); the
 * plain /step route refuses it.
 *
 * Gated three ways before a browser slot is ever taken: the OWNER's
 * browser-fetch integration toggle (the org kill switch), the per-app
 * `definition.aiBrowsing.enabled` flag (HUMAN-set in App settings — the
 * builder AI can author this step but can never switch browsing on), and the
 * action's own role gate. `allowedDomains` here NARROWS the app-level list;
 * it can never widen it.
 *
 * The result is DATA in resultVar ({ status, answer, visitedUrls, steps });
 * nothing auto-chains. Put a `confirm` step between a browse and any
 * create_record/send_email that uses its answer — the page content is
 * untrusted text.
 */
const AI_BROWSE_FIELDS = {
    task: { type: 'binding', required: true },
    url: { type: 'binding' },
    allowedDomains: { type: 'stringList' },
    maxSteps: { type: 'int', min: 1, max: 20 },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

/**
 * create_record fields — shared by ACTION_SPECS and STEP_SPECS.
 *
 * "Add a row" is one of the four things a button most often does, so it is a
 * top-level ACTION kind as well as a sequence step. The two tables are the SAME
 * object rather than two copies: a field added to the step and forgotten on the
 * action is a field canonicalize would silently drop from every bare
 * create_record action, and nothing would say so.
 */
const CREATE_RECORD_FIELDS = {
    tableId: { type: 'string', required: true },
    values: { type: 'recordValues', required: true },
    resultVar: { type: 'string', maxLen: 60 },
};

const ACTION_SPECS = {
    run_automation: {
        fields: {
            automationId: { type: 'string', nullable: true, required: true },
            inputMapping: { type: 'inputMapping', required: false },
            onSuccess: { type: 'effects', required: false },
            onError: { type: 'effects', required: false },
        },
    },
    ai_extract: { fields: AI_EXTRACT_FIELDS },
    ai_generate: { fields: AI_GENERATE_FIELDS },
    kb_query: { fields: KB_QUERY_FIELDS },
    send_email: { fields: SEND_EMAIL_FIELDS },
    // Writes a row into one of the app's own tables. Server-executed, exactly
    // like the step of the same name — see CREATE_RECORD_FIELDS.
    create_record: { fields: CREATE_RECORD_FIELDS },
    navigate: {
        fields: {
            screenId: { type: 'string', required: true },
            params: { type: 'navParams' },
        },
    },
    toast: {
        fields: {
            message: { type: 'string', required: true, maxLen: 500 },
            tone: { type: 'enum', values: TOAST_TONES, default: 'info' },
        },
    },
    open_url: {
        fields: {
            url: { type: 'url', required: true },
            newTab: { type: 'boolean', default: true },
        },
    },
    open_modal: { fields: { modalId: { type: 'string', required: true } } },
    // The other half of open_modal. Without it an authored Cancel button inside
    // a dialog could not be wired to anything, and a save sequence left the
    // dialog standing open over the form it had just submitted.
    close_modal: { fields: { modalId: { type: 'string', required: true } } },
    // A sequence runs an ordered list of Steps. Its `steps` are validated by
    // the STEP_SPECS table (see validate.js validateActionSteps).
    sequence: { fields: { steps: { type: 'steps', required: true } } },
};

// ---------------------------------------------------------------------------
// Action steps (v2). A Step is { kind, ...fields } where kind ∈ STEP_KINDS.
// Per-kind field tables mirror ACTION_SPECS. Field `type`s used here:
//   string | url | enum | boolean | int | formula (expr string, compiled) |
//   binding (full binding object) | inputMapping | recordValues
//     ({ [col]: binding }) | steps (nested Step[] — branches/bodies) |
//   navParams ({ [key]: {kind:'static',value}|{kind:'formula',expr} }, ≤
//     LIMITS.MAX_NAVIGATE_PARAMS keys — resolved client-side → screen.params).
// `mutatesData` classifies the step for the client/server partition.
// ---------------------------------------------------------------------------

const STEP_SPECS = {
    navigate: {
        mutatesData: false,
        fields: {
            screenId: { type: 'string', required: true },
            params: { type: 'navParams' },
        },
    },
    toast: {
        mutatesData: false,
        fields: {
            message: { type: 'string', required: true, maxLen: 500 },
            tone: { type: 'enum', values: TOAST_TONES, default: 'info' },
        },
    },
    open_url: {
        mutatesData: false,
        fields: { url: { type: 'url', required: true }, newTab: { type: 'boolean', default: true } },
    },
    open_modal: { mutatesData: false, fields: { modalId: { type: 'string', required: true } } },
    close_modal: { mutatesData: false, fields: { modalId: { type: 'string', required: true } } },
    // Clear a mounted form's fields back to their defaults, by form NAME
    // (props.name, node.id fallback — same key registerFormValue uses).
    // Exists because valueFrom deliberately cannot clear a field (pushing ''
    // twice is a no-op by design): without this, switching context on a
    // single-screen app leaves half-typed text in the composer and it gets
    // submitted against the NEW context — the wrong-thread reply bug.
    reset_form: { mutatesData: false, fields: { form: { type: 'string', required: true, maxLen: 100 } } },
    // Hand a file the action just produced straight to the browser.
    //
    // The alternative was parking a file_preview on the screen so the user
    // could find a Download button under it, which costs permanent vertical
    // space on every screen to serve a moment that happens once per run.
    // open_url cannot do this: its `url` is a literal https:// string by
    // contract, and an attachment lives at a per-app, per-file path that only
    // exists after the step above generated it.
    //
    // `file` takes the descriptor a generate_file / file_intake step produced
    // (typically vars.<resultVar>); the client resolves it through the same
    // attachment route file_preview uses, so access is checked identically.
    download_file: {
        mutatesData: false,
        fields: {
            file: { type: 'binding', required: true },
            fileName: { type: 'binding' },
        },
    },
    confirm: {
        mutatesData: false,
        fields: {
            message: { type: 'string', required: true, maxLen: 500 },
            title: { type: 'string', maxLen: 120 },
            confirmLabel: { type: 'string', maxLen: 80 },
            cancelLabel: { type: 'string', maxLen: 80 },
        },
    },
    set_variable: {
        mutatesData: false, // client variable state, not persistent data
        fields: {
            name: { type: 'string', required: true, maxLen: 60 },
            value: { type: 'binding', required: true },
        },
    },
    // Refresh is a DATA concern, so it narrows by table or saved dataset.
    // `actionId` is the v2.0 field; the runtime always ignored it and reloaded
    // everything, so it stays accepted (old definitions keep working) but
    // nothing reads it. With no field set, the whole app's data is invalidated —
    // the original behaviour.
    refresh: {
        mutatesData: false,
        fields: {
            tableId: { type: 'string' },
            datasetId: { type: 'string' },
            actionId: { type: 'string' },   // deprecated, ignored
        },
    },
    run_automation: {
        mutatesData: true,
        fields: {
            automationId: { type: 'string', nullable: true, required: true },
            inputMapping: { type: 'inputMapping' },
            resultVar: { type: 'string', maxLen: 60 },
        },
    },
    /**
     * `resultVar` on the record steps.
     *
     * The runner already writes it for EVERY server step generically
     * (useActionRunner's SERVER_STEP_KINDS branch), and collectVariableRefs
     * already counts it — but with no field in the spec, canonicalize stripped
     * it on every save. So "create the story, then create its tasks under it"
     * was unwritable: the new row's id existed only as
     * `actions.<id>.result.id`, which the very next server step overwrites.
     * Naming the result is what makes a parent-then-children sequence — the
     * shape of every hierarchy — expressible at all.
     */
    create_record: {
        mutatesData: true,
        fields: CREATE_RECORD_FIELDS,
    },
    update_record: {
        mutatesData: true,
        fields: {
            tableId: { type: 'string', required: true },
            recordId: { type: 'binding', required: true },
            values: { type: 'recordValues', required: true },
            resultVar: { type: 'string', maxLen: 60 },
            // OPTIONAL compare-and-set. Bind it to the updated_at of the row
            // the person edited (an inline grid commit carries the whole row,
            // so {kind:'formula',expr:'form.updated_at'}) and the write is
            // refused when someone else changed the row first — instead of
            // silently overwriting them. Omit it and the step stays
            // last-write-wins, which is right for server-authoritative flows
            // where nobody is holding a stale copy.
            expectedUpdatedAt: { type: 'binding' },
        },
    },
    delete_record: {
        mutatesData: true,
        fields: {
            tableId: { type: 'string', required: true },
            recordId: { type: 'binding', required: true },
            resultVar: { type: 'string', maxLen: 60 },
        },
    },
    /**
     * request_approval — create a durable approval request from an app action.
     *
     * There is no run behind it: the decision itself is the outcome. The row
     * lands in the deciders' Approvals inbox (assignee, group, owner, org
     * admin — the same canDecide set run-sourced approvals have) and the app
     * reacts through `onDecided` (a record write executed inside the decide,
     * per-outcome column templates over {{answers.*}}/{{reason}}/…) and the
     * `approval.decided` trigger event. Creation acts as the app OWNER (the
     * row's owner); the real viewer is RECORDED as requested_by, never
     * impersonated — an `anon:` requester can ask, never decide.
     *
     * `fields` are the approver's questions (form vocabulary, no `file`);
     * `context` is an app-chosen payload (e.g. { recordId }) echoed into the
     * hook templates and the event. `resultVar` receives
     * { approvalId, status: 'pending', expiresAt } — the app's durable handle.
     */
    request_approval: {
        mutatesData: true,
        fields: {
            prompt: { type: 'binding', required: true },
            details: { type: 'binding' },                       // markdown shown to the approver
            fields: { type: 'approvalQuestions' },              // questions answered at decide time
            assigneeUserId: { type: 'string', maxLen: 80, nullable: true },
            assigneeGroupId: { type: 'string', maxLen: 80, nullable: true },
            // Panel (multiple approvers) — used INSTEAD of the assignee.
            // Seats are the users plus the groups (a group seat is filled by
            // whichever member votes first), ≤ 10 in total. `rule` decides
            // how votes resolve; quorumCount is N for rule 'quorum'; the
            // final approver is an optional second sign-off stage.
            approverUserIds: { type: 'stringList' },
            approverGroupIds: { type: 'stringList' },
            rule: { type: 'enum', values: ['all', 'first', 'quorum'], default: 'all' },
            quorumCount: { type: 'int', min: 1, max: 10 },
            finalApproverUserId: { type: 'string', maxLen: 80, nullable: true },
            finalApproverGroupId: { type: 'string', maxLen: 80, nullable: true },
            // Stages — an ORDERED chain of up to five named steps, each with
            // its own approvers and its own rule. Set INSTEAD of the assignee,
            // the panel and the final approver: those are the one-stage and
            // two-stage shapes written out longhand, and combining them with a
            // chain would leave a configured approver nobody ever asks.
            // A stage's optional `when` is evaluated ONCE, at request time,
            // against the action scope — which is how "over €5,000 also needs
            // the director" is expressed without a second action.
            stages: { type: 'approvalStages' },
            expiresInHours: { type: 'int', min: 0, max: 720 },  // absent = no deadline (0 too)
            // Nudge + takeover clocks; both must land before the deadline or
            // they are dropped at request time. Escalation WIDENS the decider
            // set (the original approver keeps their rights).
            remindAfterHours: { type: 'int', min: 1, max: 720 },
            escalateToUserId: { type: 'string', maxLen: 80, nullable: true },
            escalateToGroupId: { type: 'string', maxLen: 80, nullable: true },
            escalateAfterHours: { type: 'int', min: 1, max: 720 },
            attachments: { type: 'binding' },                   // studio_attachment descriptor(s)
            context: { type: 'recordValues' },                  // { key: binding } — resolved at request time
            onDecided: { type: 'approvalOnDecided' },           // record-write hook, snapshotted
            resultVar: { type: 'string', maxLen: 60 },
        },
    },
    ai_extract: { mutatesData: true, fields: AI_EXTRACT_FIELDS },
    ai_generate: { mutatesData: true, fields: AI_GENERATE_FIELDS },
    kb_query: { mutatesData: true, fields: KB_QUERY_FIELDS },
    send_email: { mutatesData: true, fields: SEND_EMAIL_FIELDS },
    generate_file: { mutatesData: true, fields: GENERATE_FILE_FIELDS },
    fill_document: { mutatesData: true, fields: FILL_DOCUMENT_FIELDS },
    generate_presentation: { mutatesData: true, fields: GENERATE_PRESENTATION_FIELDS },
    redact_pdf: { mutatesData: true, fields: REDACT_PDF_FIELDS },
    file_intake: { mutatesData: true, fields: FILE_INTAKE_FIELDS },
    dataset_query: { mutatesData: true, fields: DATASET_QUERY_FIELDS },
    ai_browse: { mutatesData: true, fields: AI_BROWSE_FIELDS },
    condition: {
        mutatesData: false, // flow-control; mutation lives in the child steps
        fields: {
            expr: { type: 'formula', required: true },
            then: { type: 'steps', required: true },
            else: { type: 'steps' },
        },
    },
    loop: {
        mutatesData: false,
        fields: {
            source: { type: 'binding', required: true },
            itemVar: { type: 'string', maxLen: 60 },
            indexVar: { type: 'string', maxLen: 60 },
            maxIterations: { type: 'int', min: 1, max: LIMITS.MAX_ACTION_LOOP_ITERATIONS },
            steps: { type: 'steps', required: true },
        },
    },
    switch: {
        mutatesData: false,
        fields: {
            expr: { type: 'formula', required: true },
            cases: { type: 'switchCases', required: true },
            default: { type: 'steps' },
        },
    },
};

module.exports = {
    ACTION_KINDS,
    ACTION_SPECS,
    STEP_KINDS,
    STEP_SPECS,
    CLIENT_STEP_KINDS,
    DATA_MUTATING_STEP_KINDS,
    TOAST_TONES,
    SEND_EMAIL_FIELDS,
    CREATE_RECORD_FIELDS,
    AI_SCHEMA_FIELD_TYPES,
    GENERATE_PRESENTATION_FORMATS,
    GENERATE_PRESENTATION_FIELDS,
};
