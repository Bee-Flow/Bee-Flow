// @typecheck strict
const DECK_LOOK = require('../../core/documents/deckThemeOptions');

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

module.exports = { ACTION_KINDS, STEP_KINDS, DATA_MUTATING_STEP_KINDS, CLIENT_STEP_KINDS, TOAST_TONES, AI_SCHEMA_FIELD_TYPES, AI_EXTRACT_FIELDS, AI_GENERATE_FIELDS, KB_QUERY_FIELDS, SEND_EMAIL_FIELDS, GENERATE_FILE_FIELDS, FILL_DOCUMENT_FIELDS, GENERATE_PRESENTATION_FORMATS, GENERATE_PRESENTATION_FIELDS, REDACT_PDF_FIELDS, FILE_INTAKE_FIELDS, DATASET_QUERY_FIELDS };
