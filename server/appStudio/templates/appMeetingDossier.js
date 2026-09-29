/**
 * App Studio template — Meeting dossier.
 *
 * The minutes nobody writes. A meeting is recorded, transcribed with speaker
 * separation, and the two things that actually matter — the DECISIONS taken and
 * the ACTIONS owned — are pulled out of the transcript and tracked until they
 * are done. Bee Flow self-hosts WhisperX, so this is a workflow an organisation
 * can run on recordings it would never hand to a public API. That is as much
 * the point of the template as the feature is.
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS ────────────────────────────────
 *
 * AN EXTRACTED ITEM IS A SUGGESTION UNTIL A PERSON OWNS IT.
 *
 * A model reading a transcript is good at "something was agreed here" and bad
 * at "and Bas is doing it by Friday". So the model never writes an owner, never
 * writes a due date, and never writes who took a decision. It writes
 * `owner_hint`, `due_hint` and `decided_by_hint` — the words the transcript
 * actually used, verbatim — into columns that are read as EVIDENCE, not as
 * assignment. `confirmation` starts at 'suggested' (stamped as a writeTo
 * constant, where nothing the model returns can reach it), and the Review
 * screen is the only place it becomes 'confirmed'. Confirming is a FORM: a
 * person types the owner and the date, pre-filled with the hint so agreeing is
 * one click and disagreeing is just as easy.
 *
 * A team stops trusting a tool the first time it assigns work to the wrong
 * person. This is the whole reason the app has a review queue at all, and the
 * reason the Actions board and the Decision log read confirmed rows only.
 *
 * ── THE AI SEAM, STATED HONESTLY ───────────────────────────────────────────
 *
 * There is no `transcribe` step. Transcription reaches WhisperX through a
 * ROUTINE, so "Send for transcription" flips the recording to `queued` and then
 * fires { kind:'run_automation', automationId:null } — the one tolerated
 * warning at install (action.automation_unset). The routine's contract is a
 * QUEUE, not an argument list: pick up recordings whose transcription_status is
 * 'queued', run WhisperX, write the diarised text back into `transcript_text`,
 * set the status to 'done'. That is said in the Dossier callout and again on
 * Setup, because a button that silently does nothing is worse than no button.
 *
 * Reading decisions and actions OUT of a transcript, by contrast, IS an app
 * step: two `ai_extract` steps with a schema, a writeTo and provenance
 * constants. It needs no routine and no configuration.
 *
 * And the whole app works with neither. Paste or type the transcript, or skip
 * it entirely and write the decisions and actions in by hand — "Record a
 * decision" and "Record an action" create confirmed rows directly. Nothing in
 * the app is a dead end without AI.
 *
 * ── WHY THERE IS NO transcript_segments TABLE ──────────────────────────────
 *
 * Diarisation output is per-segment (speaker · start time · text), so a segment
 * table is the obvious model. It is the wrong one HERE, for a reason specific
 * to this subject: a recording is the most sensitive artefact most organisations
 * hold, and segments would put the most sensitive text in the app into a second,
 * unbounded child table. Purging it would then need a bulk delete — and there is
 * no step for that. (A `loop` over a records binding cannot help: a loop's
 * source resolves against the CLIENT data cache, which only holds bindings that
 * a component on the current screen rendered.)
 *
 * So the transcript is ONE richtext field on ONE row, and retention is one
 * write: media → null, transcript_text → null, purged → true. What survives is
 * the minute — decisions and actions, each carrying the `source_quote` and
 * `source_timecode` it came from — which is exactly the data-minimisation
 * story you want: keep the outcome, drop the recording of everyone's voice.
 *
 * The diarisation shape is not lost. `speaker_map` maps SPEAKER_00 → a person
 * per meeting, a human does that mapping, and it is fed to the extraction as
 * `promptContext` so the model's hints name people instead of labels. A label
 * table is four short rows; it is not the sensitive artefact.
 *
 * ── CONSTRAINTS THAT SHAPED THIS FILE (none of them obvious) ───────────────
 *
 *  • NO JOINS. Every read is FROM one table, and a filter or sort may only name
 *    that table's own columns. The decision log is meant to OUTLIVE the meeting
 *    it came from, so `meeting_title` and `meeting_date` are DENORMALISED onto
 *    every decision and action (and `meeting_title` + `retention_until` onto
 *    every recording). They are display copies and the app treats them as such:
 *    the actions that create the rows write them, and nothing else does.
 *
 *  • A BINDING FILTER FORMULA may only read currentUser / vars / forms / screen
 *    / today. Reading form.*, item.*, records.* or now makes the fetch layer and
 *    the cache key diverge and the component loads forever. Every dynamic scope
 *    here goes through `vars`.
 *
 *  • A SERVER step (create/update/delete_record, ai_extract) sees only form,
 *    vars, item, value, currentUser, now and today. `screen`, `forms`,
 *    `actions`, `records` and `datasets` are {} server-side, so nothing here
 *    reads `screen.params` — that resolves in preview and writes NULL in
 *    production.
 *
 *  • AN OPTIONAL FILTER whose formula resolves to null is OMITTED ENTIRELY.
 *    That is load-bearing three times over: the Review queue, the Actions board
 *    and the Decision log all take the selected meeting as an OPTIONAL scope, so
 *    with nothing selected they show everything — which is what those screens
 *    are for — and narrow to one meeting the moment one is picked. The Dossier,
 *    which is about one meeting, uses required:true and shows nothing until you
 *    pick one, rather than mixing four meetings' transcripts together.
 *
 *  • A height:'fill' SECTION stretches its FIRST grid row only, so every screen
 *    is one auto-height header section plus one fill section whose children are
 *    a single 12-column row.
 *
 *  • `filter_bar` publishes into ONE hardcoded variable, vars.filters — one bar
 *    per screen, and `filters` is never declared as a variable.
 *
 *  • An aggregate binding with no explicit `limit` is silently capped at 50.
 *
 * ── WHAT THIS TEMPLATE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * No attendance table. Who was in the room is a sentence, and modelling it as
 * rows buys nothing this app reads: no screen filters by attendee, and the two
 * things that do name a person — an action's owner and a decision's author —
 * are typed by a human at confirmation time anyway.
 *
 * No automatic e-mailing of the minute. send_email needs a mailbox connector
 * configured, and this template must install and run with nothing connected.
 */

'use strict';

const THEME_DEFAULTS = {
    radius: 'md',
    density: 'comfortable',
    fontScale: 'md',
    appearance: 'auto',
};

// ---------------------------------------------------------------------------
// Access
//
// Three roles, and the split follows the sensitivity of the ARTEFACT rather
// than the seniority of the person. `default:'role'` inverts the default to
// deny, so every grant below is a decision instead of an oversight. The owner
// is never listed — resolveScope short-circuits them to full access.
// ---------------------------------------------------------------------------

/** Vocabularies and the people list: the secretary's to change, everyone's to read. */
const ACCESS_CONFIG = {
    default: 'role',
    roles: {
        secretary: { read: 'all', create: true, update: 'all', delete: 'all' },
        member: { read: 'all', create: false, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * Meeting METADATA — title, date, kind, classification, retention. Readable by
 * everyone: knowing that a board meeting happened on the 8th is not the
 * sensitive part, and an action item names its meeting anyway.
 */
const ACCESS_MEETINGS = {
    default: 'role',
    roles: {
        secretary: { read: 'all', create: true, update: 'all', delete: 'all' },
        member: { read: 'all', create: false, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * THE MEDIA. The recording, the transcript, and the map of who is which speaker
 * — the most sensitive rows in the app, because a transcript contains
 * everything said, including what nobody meant to minute.
 *
 * read:'none' for members AND for auditors. An auditor's job is the decision
 * log; giving them the tape as well would make "we recorded it" a much harder
 * sentence to say to a works council. `create:true` on the secretary is
 * load-bearing: ai_extract and every write here run as the VIEWER.
 */
const ACCESS_MEDIA = {
    default: 'role',
    roles: {
        secretary: { read: 'all', create: true, update: 'all', delete: 'all' },
        member: { read: 'none', create: false, update: false, delete: false },
        auditor: { read: 'none', create: false, update: false, delete: false },
    },
};

/**
 * The decision log — the thing people actually go back to. Everyone reads it;
 * only the secretary writes it, and nobody deletes a decision, not even them:
 * a decision is superseded, never removed, or the log stops being a record.
 */
const ACCESS_DECISIONS = {
    default: 'role',
    roles: {
        secretary: { read: 'all', create: true, update: 'all', delete: false },
        member: { read: 'all', create: false, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * Action items. A member may raise one in the meeting and must be able to move
 * their own card, so update is 'all' rather than 'own': row-level "mine" is not
 * expressible here (the row was created by whoever ran the extraction, not by
 * its owner), and a board where you cannot move your own card is not a board.
 * `confirmed_by` and the audit columns are what make that honest.
 */
const ACCESS_ACTIONS = {
    default: 'role',
    roles: {
        secretary: { read: 'all', create: true, update: 'all', delete: 'all' },
        member: { read: 'all', create: true, update: 'all', delete: 'own' },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

const COLOR_OPTIONS = [
    { value: 'primary', label: 'Primary' },
    { value: 'neutral', label: 'Neutral' },
    { value: 'success', label: 'Green' },
    { value: 'warning', label: 'Amber' },
    { value: 'danger', label: 'Red' },
    { value: 'info', label: 'Blue' },
];

/**
 * The confidentiality classification. Plain words rather than a house scheme,
 * because the point of the column is that a reader knows what they are holding
 * before they press play.
 */
const CLASSIFICATION_OPTIONS = [
    { value: 'internal', label: 'Internal' },
    { value: 'confidential', label: 'Confidential' },
    { value: 'restricted', label: 'Restricted — named people only' },
];

const SOURCE_OPTIONS = [
    { value: 'recording', label: 'Audio or video recording' },
    { value: 'transcript', label: 'Transcript file' },
    { value: 'notes', label: 'Typed notes' },
];

/** The routine's state machine, and the only column it has to write back. */
const TRANSCRIPTION_OPTIONS = [
    { value: 'none', label: 'Not requested' },
    { value: 'queued', label: 'Queued for transcription' },
    { value: 'done', label: 'Transcribed' },
    { value: 'failed', label: 'Failed' },
];

/** THE distinction. Nothing reaches the board or the log until it is confirmed. */
const CONFIRMATION_OPTIONS = [
    { value: 'suggested', label: 'Suggested — needs a person' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'discarded', label: 'Discarded' },
];

/** Kept rather than inferred: "a human wrote this" and "a model read this" age differently. */
const ORIGIN_OPTIONS = [
    { value: 'manual', label: 'Written by hand' },
    { value: 'extracted', label: 'Extracted from a transcript' },
];

const DECISION_STATE_OPTIONS = [
    { value: 'active', label: 'Active' },
    { value: 'superseded', label: 'Superseded' },
];

const STATUS_CATEGORY_OPTIONS = [
    { value: 'open', label: 'Not started' },
    { value: 'doing', label: 'In progress' },
    { value: 'done', label: 'Done' },
];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const dataModel = {
    modelVersion: 1,
    roles: [
        { key: 'secretary', label: 'Secretary' },
        { key: 'member', label: 'Team member' },
        { key: 'auditor', label: 'Auditor' },
    ],
    roleMapping: { default: 'member', byGroup: {} },
    tables: [
        // ── Vocabularies ───────────────────────────────────────────────────
        {
            id: 'tbl_mdkind',
            key: 'meeting_kinds',
            name: 'Meeting kinds',
            icon: 'Tags',
            access: ACCESS_CONFIG,
            fields: [
                // The KEY is what a meeting stores. Unique, or two kinds would
                // quietly become one everywhere the app groups by it.
                { id: 'fld_mkkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_mkname1', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_mkcol01', key: 'color', type: 'select', required: false, unique: false, options: COLOR_OPTIONS, default: 'neutral' },
                // What a NEW meeting of this kind starts at. A board recording
                // and a stand-up voice memo do not deserve the same retention
                // clock, and making that a property of the kind is what stops
                // the choice being made row by row by whoever is in a hurry.
                {
                    id: 'fld_mkcls01', key: 'default_classification', type: 'select', required: false, unique: false,
                    options: CLASSIFICATION_OPTIONS, default: 'internal',
                },
                { id: 'fld_mkret01', key: 'default_retention_days', type: 'number', subtype: 'integer', required: false, unique: false, default: 90 },
                { id: 'fld_mkpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_mdstat',
            key: 'action_statuses',
            name: 'Action statuses',
            icon: 'ListChecks',
            access: ACCESS_CONFIG,
            fields: [
                // Text keys pointing at THIS table rather than a `select` on the
                // action item: a select's options live in the data model, and the
                // data model is only editable from the builder. "Add a Waiting on
                // client column" would mean a developer changing the schema of a
                // live table. Here the secretary adds a row and the board grows a
                // column, because the kanban reads its columns from this query.
                { id: 'fld_askey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_asname1', key: 'name', type: 'text', required: true, unique: false },
                {
                    id: 'fld_ascat01', key: 'category', type: 'select', required: true, unique: false,
                    options: STATUS_CATEGORY_OPTIONS, default: 'open',
                },
                { id: 'fld_ascol01', key: 'color', type: 'select', required: false, unique: false, options: COLOR_OPTIONS, default: 'neutral' },
                { id: 'fld_aspos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_mdppl',
            key: 'people',
            name: 'People',
            icon: 'IdCard',
            access: ACCESS_CONFIG,
            fields: [
                { id: 'fld_ppname1', key: 'name', type: 'text', required: true, unique: false },
                // The identity "Only mine" matches on. Inside Nextcloud the
                // embedded app resolves currentUser.email for the signed-in NC
                // user; standalone it is the Bee Flow account's e-mail. Same
                // string either way, which is why the board works in both places
                // without a second identity model.
                { id: 'fld_ppmail1', key: 'email', type: 'text', required: false, unique: false },
                { id: 'fld_ppteam1', key: 'team', type: 'text', required: false, unique: false },
                { id: 'fld_ppact01', key: 'is_active', type: 'bool', required: false, unique: false, default: true },
            ],
        },

        // ── The meeting and its media ──────────────────────────────────────
        {
            id: 'tbl_mdmeet',
            key: 'meetings',
            name: 'Meetings',
            icon: 'CalendarClock',
            access: ACCESS_MEETINGS,
            fields: [
                { id: 'fld_mttit01', key: 'title', type: 'text', required: true, unique: false },
                { id: 'fld_mtdat01', key: 'meeting_date', type: 'date', required: true, unique: false },
                // A key into meeting_kinds — see the note on action_statuses.
                { id: 'fld_mtkin01', key: 'kind', type: 'text', required: false, unique: false, default: 'team' },
                { id: 'fld_mtcha01', key: 'chair_name', type: 'text', required: false, unique: false },
                // Prose, not rows. See "what this template deliberately does not do".
                { id: 'fld_mtatt01', key: 'attendees', type: 'text', required: false, unique: false },
                { id: 'fld_mtloc01', key: 'location', type: 'text', required: false, unique: false },
                {
                    id: 'fld_mtcls01', key: 'classification', type: 'select', required: true, unique: false,
                    options: CLASSIFICATION_OPTIONS, default: 'internal',
                },
                // The date the MEDIA has to be gone by. On the meeting because it
                // is decided when the meeting is scheduled, not when someone
                // remembers to upload the file.
                { id: 'fld_mtret01', key: 'retention_until', type: 'date', required: false, unique: false },
                { id: 'fld_mtsum01', key: 'summary', type: 'richtext', required: false, unique: false },
                { id: 'fld_mtclo01', key: 'is_closed', type: 'bool', required: false, unique: false, default: false },
            ],
        },
        {
            id: 'tbl_mdrec',
            key: 'recordings',
            name: 'Recordings & transcripts',
            icon: 'Paperclip',
            access: ACCESS_MEDIA,
            fields: [
                { id: 'fld_rcmet01', key: 'meeting_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_mdmeet' } },
                // DENORMALISED. The retention grid lists recordings, not
                // meetings, and there are no joins to follow to the title.
                { id: 'fld_rctit01', key: 'meeting_title', type: 'text', required: false, unique: false },
                { id: 'fld_rclbl01', key: 'label', type: 'text', required: true, unique: false },
                {
                    id: 'fld_rcsrc01', key: 'source', type: 'select', required: false, unique: false,
                    options: SOURCE_OPTIONS, default: 'recording',
                },
                // The bytes. Audio, video, or a .txt/.md transcript — the
                // extraction step reads any of them, which is what makes the
                // whole app usable by an organisation with no GPU at all.
                { id: 'fld_rcmed01', key: 'media', type: 'file', required: false, unique: false },
                // ONE field, so a purge is ONE write. See the module header.
                { id: 'fld_rctxt01', key: 'transcript_text', type: 'richtext', required: false, unique: false },
                {
                    id: 'fld_rcsta01', key: 'transcription_status', type: 'select', required: false, unique: false,
                    options: TRANSCRIPTION_OPTIONS, default: 'none',
                },
                { id: 'fld_rcdur01', key: 'duration_minutes', type: 'number', subtype: 'integer', required: false, unique: false },
                // DENORMALISED from the meeting, so the retention view is a
                // single-table query over the rows that actually hold bytes.
                { id: 'fld_rcret01', key: 'retention_until', type: 'date', required: false, unique: false },
                // A tombstone, not a deletion: "there was a recording and it is
                // gone" is a fact a retention policy has to be able to show.
                { id: 'fld_rcpur01', key: 'purged', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_rcpon01', key: 'purged_on', type: 'date', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_mdspk',
            key: 'speaker_map',
            name: 'Speakers',
            icon: 'Users',
            access: ACCESS_MEDIA,
            fields: [
                { id: 'fld_spmet01', key: 'meeting_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_mdmeet' } },
                // What diarisation emits: SPEAKER_00, SPEAKER_01, …
                { id: 'fld_splbl01', key: 'speaker_label', type: 'text', required: true, unique: false },
                // What a HUMAN says that label is. Never guessed by the app: a
                // wrong name here would propagate into every owner hint.
                { id: 'fld_spnam01', key: 'person_name', type: 'text', required: false, unique: false },
                { id: 'fld_spmai01', key: 'person_email', type: 'text', required: false, unique: false },
                { id: 'fld_sppos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },

        // ── What outlives the meeting ──────────────────────────────────────
        {
            id: 'tbl_mddec',
            key: 'decisions',
            name: 'Decisions',
            icon: 'FileCheck',
            access: ACCESS_DECISIONS,
            fields: [
                { id: 'fld_dcmet01', key: 'meeting_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_mdmeet' } },
                // DENORMALISED so the log reads standalone — and keeps reading
                // after the meeting row is deleted, which is the point of a log.
                { id: 'fld_dctit01', key: 'meeting_title', type: 'text', required: false, unique: false },
                { id: 'fld_dcdat01', key: 'meeting_date', type: 'date', required: false, unique: false },
                { id: 'fld_dcstm01', key: 'statement', type: 'text', required: true, unique: false },
                { id: 'fld_dcrat01', key: 'rationale', type: 'text', required: false, unique: false },
                // THE MODEL'S READING, not the record. Written by ai_extract,
                // shown to the reviewer, and never read by the log.
                { id: 'fld_dchnt01', key: 'decided_by_hint', type: 'text', required: false, unique: false },
                // Only a human ever writes these two, on the Review screen.
                { id: 'fld_dcby001', key: 'decided_by', type: 'text', required: false, unique: false },
                { id: 'fld_dcon001', key: 'decided_on', type: 'date', required: false, unique: false },
                {
                    id: 'fld_dccnf01', key: 'confirmation', type: 'select', required: true, unique: false,
                    options: CONFIRMATION_OPTIONS, default: 'suggested',
                },
                {
                    id: 'fld_dcsta01', key: 'state', type: 'select', required: true, unique: false,
                    options: DECISION_STATE_OPTIONS, default: 'active',
                },
                {
                    id: 'fld_dcorg01', key: 'origin', type: 'select', required: false, unique: false,
                    options: ORIGIN_OPTIONS, default: 'manual',
                },
                // A decision log's real shape is a chain, not a list. Self-relation
                // plus a denormalised copy of what it replaced, so a reader sees
                // the previous wording without a join.
                { id: 'fld_dcsup01', key: 'supersedes_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_mddec' } },
                { id: 'fld_dcsps01', key: 'supersedes_statement', type: 'text', required: false, unique: false },
                // PROVENANCE. These survive the purge of the recording they came
                // from, which is what makes "keep the outcome, drop the tape"
                // defensible rather than merely convenient.
                { id: 'fld_dcqot01', key: 'source_quote', type: 'text', required: false, unique: false },
                { id: 'fld_dctcd01', key: 'source_timecode', type: 'text', required: false, unique: false },
                { id: 'fld_dccby01', key: 'confirmed_by', type: 'text', required: false, unique: false },
                { id: 'fld_dccat01', key: 'confirmed_at', type: 'datetime', required: false, unique: false },
                { id: 'fld_dcext01', key: 'extracted_at', type: 'datetime', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_mdact',
            key: 'action_items',
            name: 'Actions',
            icon: 'ListChecks',
            access: ACCESS_ACTIONS,
            fields: [
                { id: 'fld_acmet01', key: 'meeting_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_mdmeet' } },
                { id: 'fld_actit01', key: 'meeting_title', type: 'text', required: false, unique: false },
                { id: 'fld_acdat01', key: 'meeting_date', type: 'date', required: false, unique: false },
                { id: 'fld_acttl01', key: 'title', type: 'text', required: true, unique: false },
                { id: 'fld_acdet01', key: 'detail', type: 'text', required: false, unique: false },
                // THE HINTS. `due_hint` is deliberately TEXT, not a date: a model
                // turning "before the next board" into 2026-09-12 is precisely the
                // silent guess this app refuses to make. A person reads the words
                // and picks the date.
                { id: 'fld_acohn01', key: 'owner_hint', type: 'text', required: false, unique: false },
                { id: 'fld_acdhn01', key: 'due_hint', type: 'text', required: false, unique: false },
                // Only a human ever writes these three.
                { id: 'fld_acown01', key: 'owner_name', type: 'text', required: false, unique: false },
                { id: 'fld_acmal01', key: 'owner_email', type: 'text', required: false, unique: false },
                { id: 'fld_acdue01', key: 'due_date', type: 'date', required: false, unique: false },
                // A key into action_statuses — the board's columns are that table.
                { id: 'fld_acsta01', key: 'status', type: 'text', required: false, unique: false, default: 'open' },
                {
                    id: 'fld_accnf01', key: 'confirmation', type: 'select', required: true, unique: false,
                    options: CONFIRMATION_OPTIONS, default: 'suggested',
                },
                {
                    id: 'fld_acorg01', key: 'origin', type: 'select', required: false, unique: false,
                    options: ORIGIN_OPTIONS, default: 'manual',
                },
                { id: 'fld_acqot01', key: 'source_quote', type: 'text', required: false, unique: false },
                { id: 'fld_actcd01', key: 'source_timecode', type: 'text', required: false, unique: false },
                { id: 'fld_accby01', key: 'confirmed_by', type: 'text', required: false, unique: false },
                { id: 'fld_accat01', key: 'confirmed_at', type: 'datetime', required: false, unique: false },
                { id: 'fld_accom01', key: 'completed_at', type: 'datetime', required: false, unique: false },
                { id: 'fld_acext01', key: 'extracted_at', type: 'datetime', required: false, unique: false },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Shared vocabularies for the SCREENS.
//
// `filter_bar.options`, `data_grid.columns` and `input_select.options` are
// author-time lists rather than bindings. So a status added on Setup grows a
// column on the board (whose columns ARE bound) but does not appear in the
// status dropdown on the confirm form until an editor adds it there. That is a
// platform limit, not a modelling choice, and Setup says so out loud.
// ---------------------------------------------------------------------------

const STATUS_FILTER_OPTIONS = [
    { value: 'open', label: 'Not started' },
    { value: 'doing', label: 'In progress' },
    { value: 'waiting', label: 'Waiting on someone' },
    { value: 'done', label: 'Done' },
];


const CLASSIFICATION_TONES = [
    { value: 'internal', label: 'Internal', tone: 'neutral' },
    { value: 'confidential', label: 'Confidential', tone: 'warning' },
    { value: 'restricted', label: 'Restricted', tone: 'danger' },
];

const KIND_FILTER_OPTIONS = [
    { value: 'board', label: 'Board' },
    { value: 'standup', label: 'Stand-up' },
    { value: 'client', label: 'Client' },
    { value: 'one_to_one', label: 'One-to-one' },
];

/**
 * The terminal status key. The kanban drag stamps `completed_at` when a card
 * lands here, which is the one place the app special-cases a configured value —
 * there is no join to read the column's `category` from a server step. Setup
 * says which key is terminal, and the test suite asserts it exists.
 */

/**
 * Cards carry the two facts a stand-up asks about, plus the meeting the action
 * came out of — read off the DENORMALISED copy, since there is nothing to join.
 */
const ACTION_CARD_FIELDS = [
    { key: 'owner_name', label: 'Owner', slot: 'meta', format: 'text' },
    { key: 'due_date', label: 'Due', slot: 'chip', format: 'date' },
    { key: 'meeting_title', label: 'From', slot: 'meta', format: 'text' },
];

// ==================================================================
// MEETINGS — the way in. Everything on this screen works with nothing
// selected, because that is what a viewer sees on first open.
// ==================================================================
const SCREEN_MEETINGS = {
    id: 'scr_meetings',
    name: 'Meetings',
    icon: 'CalendarClock',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Every meeting, its classification and its retention date.',
    sections: [
        {
            id: 'sec_mmtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_mmhdr',
                    type: 'page_header',
                    props: {
                        title: 'Meetings',
                        subtitle: 'Pick a meeting to open its dossier. The Review queue, the Actions board and the Decision log narrow to it — clear the selection to see everything again.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'CalendarClock',
                        showDivider: false,
                        // The tall centered opening — the dossier's title page.
                        look: 'hero',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_mmnew',
                            type: 'button',
                            props: { label: 'New meeting', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_mmopen',
                        },
                        {
                            id: 'cmp_mmgo',
                            type: 'button',
                            props: { label: 'Open dossier', variant: 'secondary', iconLeft: 'ArrowRight', role: 'button' },
                            style: { span: 3 },
                            visible: { kind: 'formula', expr: 'vars.meeting.id' },
                            onClick: 'act_mmgo',
                        },
                        {
                            id: 'cmp_mmclr',
                            type: 'button',
                            props: { label: 'Show all meetings', variant: 'ghost', iconLeft: 'X', role: 'button' },
                            style: { span: 3 },
                            visible: { kind: 'formula', expr: 'vars.meeting.id' },
                            onClick: 'act_mmclear',
                        },
                    ],
                },
                {
                    id: 'cmp_mmfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search', type: 'search', options: [] },
                            { name: 'kind', label: 'Kind', type: 'select', options: KIND_FILTER_OPTIONS },
                            { name: 'classification', label: 'Classification', type: 'select', options: CLASSIFICATION_OPTIONS },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
                {
                    id: 'cmp_mmst1',
                    type: 'stat',
                    props: {
                        label: 'Meetings',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_mdmeet',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            limit: 1,
                            // An aggregate resolves to the ROWS ARRAY; `pick` is
                            // the read-side lens that narrows it to the one
                            // number a tile is for. Without it the tile renders
                            // the array and every KPI reads "1".
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'in the dossier',
                        look: 'tile',
                        icon: 'CalendarClock',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_mmst2',
                    type: 'stat',
                    props: {
                        label: 'Waiting for a person',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_mdact',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'confirmation', op: 'eq', value: 'suggested' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'suggested actions nobody owns yet',
                        look: 'tile',
                        icon: 'UserCheck',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_mmst3',
                    type: 'stat',
                    props: {
                        label: 'Past retention',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_mdrec',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                // `today` is one of the few roots a binding
                                // filter may read, which is what lets this tile
                                // be true on the day it is looked at rather than
                                // on the day it was authored.
                                { field: 'retention_until', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                                { field: 'purged', op: 'eq', value: false },
                            ],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'recordings that should be gone',
                        look: 'tile',
                        icon: 'AlertTriangle',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4 },
                    visible: true,
                },
            ],
        },
        {
            // ONE row of children — a fill section stretches its first row only.
            id: 'sec_mmmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_mmlist',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_mdmeet',
                            filter: [
                                { field: 'title', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                { field: 'kind', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.kind' }, required: false },
                                { field: 'classification', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.classification' }, required: false },
                            ],
                            sort: [{ field: 'meeting_date', dir: 'desc' }],
                            limit: 200,
                        },
                        titleKey: 'title',
                        subtitleKey: 'attendees',
                        metaKey: 'meeting_date',
                        timestampKey: null,
                        badgeKey: 'classification',
                        badgeToneMap: CLASSIFICATION_TONES,
                        unreadKey: null,
                        // A `selectedWhen` formula is a BARE STRING, not a
                        // binding object.
                        selectedWhen: 'item.id == vars.meeting.id',
                        icon: 'CalendarClock',
                        emptyText: 'No meetings yet — create the first one above.',
                        // Each meeting on its own card — a shelf of dossiers,
                        // not a table of rows.
                        look: 'cards',
                    },
                    style: { span: 5, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_mmpick',
                },
                {
                    id: 'cmp_mmdet',
                    type: 'record_detail',
                    props: {
                        source: { kind: 'formula', expr: 'vars.meeting' },
                        columns: 2,
                        fields: [
                            { key: 'title', label: 'Title', format: 'text' },
                            { key: 'meeting_date', label: 'Date', format: 'date' },
                            { key: 'kind', label: 'Kind', format: 'badge' },
                            { key: 'chair_name', label: 'Chair', format: 'text' },
                            { key: 'classification', label: 'Classification', format: 'badge' },
                            { key: 'retention_until', label: 'Media retained until', format: 'date' },
                            { key: 'location', label: 'Location', format: 'text' },
                            { key: 'attendees', label: 'Attendees', format: 'text' },
                            { key: 'summary', label: 'Summary', format: 'markdown' },
                        ],
                        emptyText: 'Pick a meeting on the left to see it in full.',
                    },
                    style: { span: 7, height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_mmdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_mmmod',
                    // modal accepts gap + padding ONLY — a `span` here is
                    // dropped as a structural repair.
                    type: 'modal',
                    props: { title: 'New meeting', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_mmfrm',
                            type: 'form',
                            props: { name: 'newmeeting', submitLabel: 'Create meeting', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_mmcreate',
                            children: [
                                { id: 'cmp_mmf1', type: 'input_text', props: { name: 'title', label: 'Title', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_mmf2', type: 'input_date', props: { name: 'meeting_date', label: 'Date', required: true, defaultValue: 'today' }, style: { span: 4 }, visible: true },
                                { id: 'cmp_mmf3', type: 'input_select', props: { name: 'kind', label: 'Kind', required: false, options: KIND_FILTER_OPTIONS, defaultValue: 'standup', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                                { id: 'cmp_mmf4', type: 'input_select', props: { name: 'classification', label: 'Classification', required: true, options: CLASSIFICATION_OPTIONS, defaultValue: 'internal', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                                // Asked for at creation, not at upload: the
                                // clock on a recording is a property of the
                                // meeting, and by upload time nobody is thinking
                                // about it any more.
                                { id: 'cmp_mmf5', type: 'input_date', props: { name: 'retention_until', label: 'Delete media after', required: false, defaultValue: null }, style: { span: 4 }, visible: true },
                                { id: 'cmp_mmf6', type: 'input_text', props: { name: 'chair_name', label: 'Chair', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_mmf7', type: 'input_text', props: { name: 'location', label: 'Location', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_mmf8', type: 'input_textarea', props: { name: 'attendees', label: 'Attendees', required: false, rows: 2 }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// DOSSIER — one meeting: its media, its transcript, and the two buttons
// that turn a transcript into a minute.
// ==================================================================
const SCREEN_DOSSIER = {
    id: 'scr_dossier',
    name: 'Dossier',
    icon: 'MessageSquareQuote',
    showInNav: true,
    maxWidth: 'full',
    description: 'The recording, the transcript and what came out of it.',
    sections: [
        {
            id: 'sec_mdtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_mdhdr',
                    type: 'page_header',
                    props: {
                        title: 'Dossier',
                        subtitle: 'Everything on this screen belongs to one meeting.',
                        titleFrom: { kind: 'formula', expr: 'vars.meeting.title' },
                        subtitleFrom: { kind: 'formula', expr: 'vars.meeting.attendees' },
                        icon: 'MessageSquareQuote',
                        showDivider: true,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_mdback',
                            type: 'button',
                            props: { label: 'Meetings', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_mdback',
                        },
                    ],
                },
                {
                    // The seam, said plainly. A button that quietly does nothing
                    // is worse than no button at all.
                    id: 'cmp_mdnote',
                    type: 'callout',
                    props: {
                        title: 'How transcription works here',
                        text: 'Reading decisions and actions out of a transcript needs nothing configured — it runs in the app. **Send for transcription** is different: it marks the recording `queued` and asks a routine to pick it up, so someone has to wire one first (Automations → a routine that takes queued recordings, runs WhisperX, writes the text back and sets the status to Transcribed). Until then, paste or upload the transcript yourself — or skip it entirely and write the decisions and actions in by hand. Nothing below depends on the AI.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_mdmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_mdrecs',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_mdrec',
                            // REQUIRED: with no meeting picked this shows
                            // nothing rather than every recording in the
                            // workspace mixed together.
                            filter: [{ field: 'meeting_id', op: 'eq', value: { kind: 'formula', expr: 'vars.meeting.id' }, required: true }],
                            sort: [{ field: 'created_at', dir: 'asc' }],
                            limit: 50,
                        },
                        titleKey: 'label',
                        subtitleKey: 'source',
                        metaKey: 'duration_minutes',
                        timestampKey: null,
                        badgeKey: 'transcription_status',
                        badgeToneMap: [
                            { value: 'none', label: 'Not requested', tone: 'neutral' },
                            { value: 'queued', label: 'Queued', tone: 'info' },
                            { value: 'done', label: 'Transcribed', tone: 'success' },
                            { value: 'failed', label: 'Failed', tone: 'danger' },
                        ],
                        unreadKey: null,
                        selectedWhen: 'item.id == vars.rec.id',
                        icon: 'Paperclip',
                        emptyText: 'Pick a meeting on the Meetings screen, then add its recording or transcript here.',
                        look: 'cards',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_mdrecpick',
                },
                {
                    // markdown has no `height` knob, so it is wrapped in a pane
                    // that does — otherwise a long transcript would push the
                    // whole page down instead of scrolling inside its panel.
                    id: 'cmp_mdpane',
                    type: 'pane',
                    props: { direction: 'vertical', scroll: 'auto' },
                    style: { span: 8, height: 'fill', padding: 4, gap: 3, background: 'surface', radius: 'md', border: 'subtle' },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_mdtxt',
                            type: 'markdown',
                            props: {
                                content: '### Transcript\n\nPick a recording on the left. When it has been transcribed — by the routine, or by pasting the text in yourself — it appears here, speaker by speaker.',
                                contentFrom: { kind: 'formula', expr: 'vars.rec.transcript_text' },
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_mdops',
            style: { padding: 4, gap: 3, background: 'surface' },
            children: [
                {
                    id: 'cmp_mdstep',
                    type: 'stepper',
                    props: {
                        value: { kind: 'formula', expr: 'vars.rec.transcription_status' },
                        steps: [
                            { value: 'none', label: 'Uploaded', icon: 'Paperclip' },
                            { value: 'queued', label: 'Queued for WhisperX', icon: 'Loader' },
                            { value: 'done', label: 'Transcribed', icon: 'CheckCircle2' },
                        ],
                        orientation: 'horizontal',
                        tone: 'primary',
                        showLabels: true,
                    },
                    style: { span: 12 },
                    visible: { kind: 'formula', expr: 'vars.rec.id' },
                },
                {
                    id: 'cmp_mdbrec',
                    type: 'button',
                    props: { label: 'Add recording or transcript', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                    style: { span: 3 },
                    visible: true,
                    onClick: 'act_mdrecopen',
                },
                {
                    id: 'cmp_mdbtra',
                    type: 'button',
                    props: { label: 'Send for transcription', variant: 'secondary', iconLeft: 'Loader', role: 'button' },
                    style: { span: 3 },
                    // Nothing to send once the media is gone.
                    visible: { kind: 'formula', expr: 'vars.rec.id && vars.rec.purged != true' },
                    onClick: 'act_mdtrans',
                },
                {
                    id: 'cmp_mdbext',
                    type: 'button',
                    props: { label: 'Read decisions and actions out of it', variant: 'secondary', iconLeft: 'Sparkles', role: 'button' },
                    style: { span: 3 },
                    visible: { kind: 'formula', expr: 'vars.rec.id && vars.rec.purged != true' },
                    onClick: 'act_mdextract',
                },
                {
                    id: 'cmp_mdbpur',
                    type: 'button',
                    props: { label: 'Purge media now', variant: 'danger', iconLeft: 'Scissors', role: 'button' },
                    style: { span: 3 },
                    visible: { kind: 'formula', expr: 'vars.rec.id && vars.rec.purged != true' },
                    onClick: 'act_mdpurge',
                },
                {
                    id: 'cmp_mdbspk',
                    type: 'button',
                    props: { label: 'Add speaker', variant: 'ghost', iconLeft: 'Users', role: 'button' },
                    style: { span: 4 },
                    visible: true,
                    onClick: 'act_mdspkopen',
                },
                {
                    id: 'cmp_mdbdec',
                    type: 'button',
                    props: { label: 'Record a decision', variant: 'ghost', iconLeft: 'FileCheck', role: 'button' },
                    style: { span: 4 },
                    visible: true,
                    onClick: 'act_mddecopen',
                },
                {
                    id: 'cmp_mdbact',
                    type: 'button',
                    props: { label: 'Record an action', variant: 'ghost', iconLeft: 'ListChecks', role: 'button' },
                    style: { span: 4 },
                    visible: true,
                    onClick: 'act_mdactopen',
                },
            ],
        },
        {
            id: 'sec_mdspk',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_mdspkg',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_mdspk',
                            filter: [{ field: 'meeting_id', op: 'eq', value: { kind: 'formula', expr: 'vars.meeting.id' }, required: true }],
                            sort: [{ field: 'position', dir: 'asc' }],
                            limit: 40,
                        },
                        columns: [
                            { key: 'position', label: '#', format: 'number', width: 70, sortable: true, filterable: false, editable: true },
                            { key: 'speaker_label', label: 'Diarisation label', format: 'text', width: 180, sortable: true, filterable: false, editable: true },
                            { key: 'person_name', label: 'Who that is', format: 'text', width: 240, sortable: false, filterable: false, editable: true },
                            { key: 'person_email', label: 'E-mail', format: 'text', width: 240, sortable: false, filterable: false, editable: true },
                        ],
                        pageSize: 10,
                        // Inline editing REQUIRES selectable:'none' — with a
                        // selection mode set, onRowSelect fires with
                        // { selected: rows } instead of the edited row.
                        selectable: 'none',
                        searchable: false,
                        rowActions: [{ label: 'Remove', actionId: 'act_mdspkdel' }],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'WhisperX labels speakers SPEAKER_00, SPEAKER_01 and so on. Say who those are here and the extraction will use their names instead of the labels.',
                    },
                    style: { span: 12 },
                    visible: true,
                    onRowSelect: 'act_mdspksave',
                },
            ],
        },
        {
            id: 'sec_mddlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_mdrmod',
                    type: 'modal',
                    props: { title: 'Add a recording or transcript', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_mdrfrm',
                            type: 'form',
                            props: { name: 'newrec', submitLabel: 'Add to the dossier', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_mdrecadd',
                            children: [
                                { id: 'cmp_mdrf1', type: 'input_text', props: { name: 'label', label: 'What this is', required: true, inputType: 'text', placeholder: 'Board recording, 8 July' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_mdrf2', type: 'input_select', props: { name: 'source', label: 'Kind', required: false, options: SOURCE_OPTIONS, defaultValue: 'recording', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                                // Audio, video or a plain .txt/.md transcript —
                                // the extraction step reads any of them.
                                { id: 'cmp_mdrf3', type: 'input_file', props: { name: 'media', label: 'File (audio, video, or a transcript)', accept: null, multiple: false, required: false }, style: { span: 8 }, visible: true },
                                { id: 'cmp_mdrf4', type: 'input_number', props: { name: 'duration_minutes', label: 'Minutes', required: false, min: 0, max: 999, step: 1, defaultValue: null }, style: { span: 4 }, visible: true },
                                { id: 'cmp_mdrf5', type: 'input_richtext', props: { name: 'transcript_text', label: 'Transcript (paste it here if you already have one)', required: false, defaultValue: null, valueFrom: { kind: 'static', value: null } }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_mdsmod',
                    type: 'modal',
                    props: { title: 'Add a speaker', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_mdsfrm',
                            type: 'form',
                            props: { name: 'newspeaker', submitLabel: 'Add speaker', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_mdspkadd',
                            children: [
                                { id: 'cmp_mdsf1', type: 'input_text', props: { name: 'speaker_label', label: 'Diarisation label', required: true, inputType: 'text', placeholder: 'SPEAKER_00' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_mdsf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 6 }, visible: true },
                                { id: 'cmp_mdsf3', type: 'input_text', props: { name: 'person_name', label: 'Who that is', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_mdsf4', type: 'input_text', props: { name: 'person_email', label: 'E-mail', required: false, inputType: 'email' }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_mddmod',
                    type: 'modal',
                    props: { title: 'Record a decision', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_mddfrm',
                            type: 'form',
                            props: { name: 'newdecision', submitLabel: 'Add to the log', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_mddecadd',
                            children: [
                                { id: 'cmp_mddf1', type: 'input_textarea', props: { name: 'statement', label: 'The decision, in one sentence', required: true, rows: 2 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_mddf2', type: 'input_textarea', props: { name: 'rationale', label: 'Why', required: false, rows: 3 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_mddf3', type: 'input_text', props: { name: 'decided_by', label: 'Taken by', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_mddf4', type: 'input_date', props: { name: 'decided_on', label: 'Taken on', required: false, defaultValue: 'today' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_mddf5', type: 'input_text', props: { name: 'source_quote', label: 'Quote from the transcript (optional)', required: false, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_mddf6', type: 'input_text', props: { name: 'source_timecode', label: 'Timecode', required: false, inputType: 'text', placeholder: '00:14:22' }, style: { span: 4 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_mdamod',
                    type: 'modal',
                    props: { title: 'Record an action', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_mdafrm',
                            type: 'form',
                            props: { name: 'newaction', submitLabel: 'Add to the board', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_mdactadd',
                            children: [
                                { id: 'cmp_mdaf1', type: 'input_text', props: { name: 'title', label: 'What was agreed', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_mdaf2', type: 'input_textarea', props: { name: 'detail', label: 'Detail', required: false, rows: 3 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_mdaf3', type: 'input_text', props: { name: 'owner_name', label: 'Owner', required: true, inputType: 'text' }, style: { span: 5 }, visible: true },
                                { id: 'cmp_mdaf4', type: 'input_text', props: { name: 'owner_email', label: 'Owner e-mail', required: false, inputType: 'email' }, style: { span: 4 }, visible: true },
                                { id: 'cmp_mdaf5', type: 'input_date', props: { name: 'due_date', label: 'Due', required: false, defaultValue: null }, style: { span: 3 }, visible: true },
                                { id: 'cmp_mdaf6', type: 'input_text', props: { name: 'source_quote', label: 'Quote from the transcript (optional)', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// REVIEW — the heart of the app. Everything the model proposed, and the
// two forms that turn a proposal into someone's work.
//
// The meeting scope here is OPTIONAL on purpose: with no meeting selected this
// is the whole backlog of unowned suggestions, which is what a secretary opens
// on a Monday. Pick a meeting and it narrows to that one.
// ==================================================================
const SCREEN_REVIEW = {
    id: 'scr_review',
    name: 'Review',
    icon: 'UserCheck',
    showInNav: true,
    maxWidth: 'full',
    description: 'Suggested decisions and actions, waiting for a person.',
    sections: [
        {
            id: 'sec_rvtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rvhdr',
                    type: 'page_header',
                    props: {
                        title: 'Review',
                        subtitle: 'Showing every meeting. Pick one on the Meetings screen to narrow this queue.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'formula', expr: 'vars.meeting.title' },
                        icon: 'UserCheck',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_rvnote',
                    type: 'callout',
                    props: {
                        title: 'Nothing here is owned yet',
                        text: 'These rows were read out of a transcript, so they are suggestions. The **Suggested owner** and **Deadline said out loud** columns are the words the transcript used — the app has not assigned anything to anyone. Confirming is where a person takes it on: the form pre-fills with the suggestion so agreeing is one click, and disagreeing is just as easy. Discard keeps the row, marked discarded, so you can see what was proposed and rejected.',
                        tone: 'warning',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_rvmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_rvdecs',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_mddec',
                            filter: [
                                { field: 'confirmation', op: 'eq', value: 'suggested' },
                                // OPTIONAL — omitted entirely when no meeting is
                                // selected, so this is the whole queue by default.
                                { field: 'meeting_id', op: 'eq', value: { kind: 'formula', expr: 'vars.meeting.id' }, required: false },
                            ],
                            sort: [{ field: 'meeting_date', dir: 'desc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'statement', label: 'Proposed decision', format: 'text', width: 340, sortable: false, filterable: false, editable: false },
                            { key: 'decided_by_hint', label: 'Transcript says', format: 'text', width: 160, sortable: false, filterable: false, editable: false },
                            { key: 'meeting_title', label: 'Meeting', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                            { key: 'source_timecode', label: 'At', format: 'text', width: 90, sortable: false, filterable: false, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [
                            { label: 'Confirm', actionId: 'act_rvdecopen' },
                            { label: 'Discard', actionId: 'act_rvdecno' },
                        ],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No decisions waiting. Run an extraction on the Dossier screen, or write one in by hand.',
                    },
                    style: { span: 6, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_rvacts',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_mdact',
                            filter: [
                                { field: 'confirmation', op: 'eq', value: 'suggested' },
                                { field: 'meeting_id', op: 'eq', value: { kind: 'formula', expr: 'vars.meeting.id' }, required: false },
                            ],
                            sort: [{ field: 'meeting_date', dir: 'desc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'title', label: 'Proposed action', format: 'text', width: 300, sortable: false, filterable: false, editable: false },
                            { key: 'owner_hint', label: 'Suggested owner', format: 'text', width: 150, sortable: false, filterable: false, editable: false },
                            { key: 'due_hint', label: 'Deadline said out loud', format: 'text', width: 180, sortable: false, filterable: false, editable: false },
                            { key: 'meeting_title', label: 'Meeting', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [
                            { label: 'Confirm', actionId: 'act_rvactopen' },
                            { label: 'Discard', actionId: 'act_rvactno' },
                        ],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No actions waiting for an owner.',
                    },
                    style: { span: 6, height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_rvdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rvdmod',
                    type: 'modal',
                    props: { title: 'Confirm this decision', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            // The evidence, above the form. A reviewer who cannot
                            // see the quote is not reviewing anything.
                            id: 'cmp_rvddet',
                            type: 'record_detail',
                            props: {
                                source: { kind: 'formula', expr: 'vars.decision' },
                                columns: 2,
                                fields: [
                                    { key: 'statement', label: 'Proposed decision', format: 'text' },
                                    { key: 'rationale', label: 'Rationale', format: 'text' },
                                    { key: 'source_quote', label: 'From the transcript', format: 'text' },
                                    { key: 'source_timecode', label: 'At', format: 'text' },
                                    { key: 'meeting_title', label: 'Meeting', format: 'text' },
                                    { key: 'decided_by_hint', label: 'Transcript suggests', format: 'text' },
                                ],
                                emptyText: 'Pick a suggestion to review.',
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rvdfrm',
                            type: 'form',
                            props: { name: 'confirmdec', submitLabel: 'Confirm — add to the log', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_rvdecok',
                            children: [
                                // valueFrom pre-fills with the HINT. A person
                                // still has to look at it and press the button,
                                // and can type over it — which is the whole
                                // difference between a suggestion and an
                                // assignment.
                                { id: 'cmp_rvdf1', type: 'input_text', props: { name: 'decided_by', label: 'Taken by', required: true, inputType: 'text', valueFrom: { kind: 'formula', expr: 'vars.decision.decided_by_hint' } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_rvdf2', type: 'input_date', props: { name: 'decided_on', label: 'Taken on', required: true, defaultValue: null, valueFrom: { kind: 'formula', expr: 'vars.decision.meeting_date' } }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_rvamod',
                    type: 'modal',
                    props: { title: 'Confirm this action', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_rvadet',
                            type: 'record_detail',
                            props: {
                                source: { kind: 'formula', expr: 'vars.action' },
                                columns: 2,
                                fields: [
                                    { key: 'title', label: 'Proposed action', format: 'text' },
                                    { key: 'detail', label: 'Detail', format: 'text' },
                                    { key: 'source_quote', label: 'From the transcript', format: 'text' },
                                    { key: 'source_timecode', label: 'At', format: 'text' },
                                    { key: 'owner_hint', label: 'Transcript suggests', format: 'text' },
                                    { key: 'due_hint', label: 'Deadline said out loud', format: 'text' },
                                ],
                                emptyText: 'Pick a suggestion to review.',
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rvafrm',
                            type: 'form',
                            props: { name: 'confirmact', submitLabel: 'Confirm — put it on the board', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_rvactok',
                            children: [
                                { id: 'cmp_rvaf1', type: 'input_text', props: { name: 'owner_name', label: 'Owner', required: true, inputType: 'text', valueFrom: { kind: 'formula', expr: 'vars.action.owner_hint' } }, style: { span: 4 }, visible: true },
                                { id: 'cmp_rvaf2', type: 'input_text', props: { name: 'owner_email', label: 'Owner e-mail', required: false, inputType: 'email', valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                                // NOT pre-filled from due_hint: the hint is prose
                                // ("before the next board") and turning prose into
                                // a date is the judgement being asked for.
                                { id: 'cmp_rvaf3', type: 'input_date', props: { name: 'due_date', label: 'Due', required: true, defaultValue: null }, style: { span: 4 }, visible: true },
                                { id: 'cmp_rvaf4', type: 'input_select', props: { name: 'status', label: 'Starting status', required: false, options: STATUS_FILTER_OPTIONS, defaultValue: 'open', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// ACTIONS — what was agreed, tracked to completion. The board's columns
// ARE the action_statuses table, so a secretary adds a column on Setup.
// ==================================================================
const SCREEN_ACTIONS = {
    id: 'scr_actions',
    name: 'Actions',
    icon: 'ListChecks',
    showInNav: true,
    maxWidth: 'full',
    description: 'Confirmed actions, owned and tracked until done.',
    sections: [
        {
            id: 'sec_actop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_achdr',
                    type: 'page_header',
                    props: {
                        title: 'Actions',
                        subtitle: 'Only confirmed actions appear here — a suggestion lives on the Review screen until someone owns it. Drag a card to change its status.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'ListChecks',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_acfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search', type: 'search', options: [] },
                            { name: 'mine', label: 'Only mine', type: 'toggle', options: [] },
                            { name: 'overdue', label: 'Overdue only', type: 'toggle', options: [] },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_acmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_ackb',
                    type: 'kanban',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_mdact',
                            filter: [
                                // The board is the CONFIRMED half of the app.
                                { field: 'confirmation', op: 'eq', value: 'confirmed' },
                                // Optional, so the board is the whole programme
                                // of work by default and one meeting's follow-up
                                // when a meeting is selected.
                                { field: 'meeting_id', op: 'eq', value: { kind: 'formula', expr: 'vars.meeting.id' }, required: false },
                                { field: 'title', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                // A toggle that is OFF must not mean "owned by
                                // nobody", so it resolves to null and the clause
                                // drops out entirely.
                                { field: 'owner_email', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.mine ? currentUser.email : null' }, required: false },
                                { field: 'due_date', op: 'lt', value: { kind: 'formula', expr: 'vars.filters.overdue ? today : null' }, required: false },
                            ],
                            sort: [{ field: 'due_date', dir: 'asc' }],
                            limit: 300,
                        },
                        groupByField: 'status',
                        // THE BOARD IS ITS CONFIG TABLE. normalizeAxisRows reads
                        // the column value from value|state|key and the label
                        // from label|name — action_statuses carries `key` and
                        // `name`, which is also what an action stores.
                        columnsSource: {
                            kind: 'records',
                            tableId: 'tbl_mdstat',
                            sort: [{ field: 'position', dir: 'asc' }],
                            limit: 12,
                        },
                        columns: [],
                        swimlaneField: null,
                        swimlanes: [],
                        swimlanesSource: { kind: 'static', value: null },
                        titleKey: 'title',
                        subtitleKey: 'detail',
                        badgeKey: 'origin',
                        badgeToneMap: [
                            { value: 'manual', label: 'By hand', tone: 'neutral' },
                            { value: 'extracted', label: 'From transcript', tone: 'info' },
                        ],
                        cardFields: ACTION_CARD_FIELDS,
                        rankKey: null,
                        colorKey: null,
                        cardColorMap: [],
                        collapsible: true,
                        emptyText: 'Nothing confirmed yet. Anything waiting is on the Review screen.',
                        allowDrag: true,
                    },
                    style: { span: 12, height: 'fill' },
                    visible: true,
                    onCardMove: 'act_acmove',
                    onRowClick: 'act_acopen',
                },
            ],
        },
        {
            id: 'sec_acdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_acmod',
                    type: 'modal',
                    props: { title: 'Action', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_acdet',
                            type: 'record_detail',
                            props: {
                                source: { kind: 'formula', expr: 'vars.action' },
                                columns: 2,
                                fields: [
                                    { key: 'title', label: 'Action', format: 'text' },
                                    { key: 'status', label: 'Status', format: 'badge' },
                                    { key: 'meeting_title', label: 'Agreed in', format: 'text' },
                                    { key: 'meeting_date', label: 'On', format: 'date' },
                                    { key: 'source_quote', label: 'From the transcript', format: 'text' },
                                    { key: 'confirmed_by', label: 'Confirmed by', format: 'text' },
                                    { key: 'confirmed_at', label: 'Confirmed at', format: 'datetime' },
                                    { key: 'completed_at', label: 'Completed', format: 'datetime' },
                                    { key: 'detail', label: 'Detail', format: 'markdown' },
                                ],
                                emptyText: 'Open a card to see it here.',
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                        {
                            id: 'cmp_acfrm',
                            type: 'form',
                            props: { name: 'reassign', submitLabel: 'Save', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_acsave',
                            children: [
                                { id: 'cmp_acf1', type: 'input_text', props: { name: 'owner_name', label: 'Owner', required: true, inputType: 'text', valueFrom: { kind: 'formula', expr: 'vars.action.owner_name' } }, style: { span: 4 }, visible: true },
                                { id: 'cmp_acf2', type: 'input_text', props: { name: 'owner_email', label: 'Owner e-mail', required: false, inputType: 'email', valueFrom: { kind: 'formula', expr: 'vars.action.owner_email' } }, style: { span: 4 }, visible: true },
                                { id: 'cmp_acf3', type: 'input_date', props: { name: 'due_date', label: 'Due', required: false, defaultValue: null, valueFrom: { kind: 'formula', expr: 'vars.action.due_date' } }, style: { span: 4 }, visible: true },
                                { id: 'cmp_acf4', type: 'input_textarea', props: { name: 'detail', label: 'Detail', required: false, rows: 3, valueFrom: { kind: 'formula', expr: 'vars.action.detail' } }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// DECISION LOG — the durable record. It reads its own denormalised copies
// of the meeting, so it keeps working after the meeting row is gone.
// ==================================================================
const SCREEN_DECISIONS = {
    id: 'scr_decisions',
    name: 'Decision log',
    icon: 'FileCheck',
    showInNav: true,
    maxWidth: 'wide',
    description: 'What was decided, by whom, and what it replaced.',
    sections: [
        {
            id: 'sec_dctop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_dchdr',
                    type: 'page_header',
                    props: {
                        title: 'Decision log',
                        subtitle: 'Confirmed decisions only. A decision is never deleted — it is superseded, and the log keeps both.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'FileCheck',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_dcfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search', type: 'search', options: [] },
                            { name: 'history', label: 'Include superseded', type: 'toggle', options: [] },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_dcmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_dcgrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_mddec',
                            filter: [
                                { field: 'confirmation', op: 'eq', value: 'confirmed' },
                                // The toggle turns the clause OFF rather than
                                // inverting it: an optional filter resolving to
                                // null is omitted, so "include superseded" is
                                // literally "stop filtering by state".
                                { field: 'state', op: 'eq', value: { kind: 'formula', expr: "vars.filters.history ? null : 'active'" }, required: false },
                                { field: 'statement', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                { field: 'meeting_id', op: 'eq', value: { kind: 'formula', expr: 'vars.meeting.id' }, required: false },
                            ],
                            sort: [{ field: 'meeting_date', dir: 'desc' }],
                            limit: 300,
                        },
                        columns: [
                            { key: 'statement', label: 'Decision', format: 'text', width: 360, sortable: false, filterable: false, editable: false },
                            { key: 'meeting_title', label: 'Meeting', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                            { key: 'meeting_date', label: 'Date', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                            { key: 'decided_by', label: 'Taken by', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'state', label: 'State', format: 'badge', width: 120, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [
                            { label: 'Open', actionId: 'act_dcpick' },
                            { label: 'Supersede', actionId: 'act_dcsupopen' },
                        ],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'Nothing confirmed yet. Suggestions live on the Review screen.',
                    },
                    style: { span: 7, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_dcdet',
                    type: 'record_detail',
                    props: {
                        source: { kind: 'formula', expr: 'vars.decision' },
                        columns: 1,
                        fields: [
                            { key: 'statement', label: 'Decision', format: 'text' },
                            { key: 'rationale', label: 'Why', format: 'markdown' },
                            { key: 'decided_by', label: 'Taken by', format: 'text' },
                            { key: 'decided_on', label: 'Taken on', format: 'date' },
                            { key: 'meeting_title', label: 'Meeting', format: 'text' },
                            { key: 'supersedes_statement', label: 'Replaces', format: 'text' },
                            { key: 'source_quote', label: 'From the transcript', format: 'text' },
                            { key: 'source_timecode', label: 'At', format: 'text' },
                            { key: 'confirmed_by', label: 'Confirmed by', format: 'text' },
                            { key: 'confirmed_at', label: 'Confirmed at', format: 'datetime' },
                        ],
                        emptyText: 'Open a decision to read it in full — including the sentence from the transcript it came from.',
                    },
                    style: { span: 5, height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_dcdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_dcmod',
                    type: 'modal',
                    props: { title: 'Supersede this decision', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_dcold',
                            type: 'record_detail',
                            props: {
                                source: { kind: 'formula', expr: 'vars.decision' },
                                columns: 1,
                                fields: [
                                    { key: 'statement', label: 'Being replaced', format: 'text' },
                                    { key: 'meeting_title', label: 'Originally taken in', format: 'text' },
                                    { key: 'decided_on', label: 'On', format: 'date' },
                                ],
                                emptyText: 'Pick a decision first.',
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                        {
                            id: 'cmp_dcfrm',
                            type: 'form',
                            props: { name: 'supersede', submitLabel: 'Record the new decision', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_dcsupsave',
                            children: [
                                { id: 'cmp_dcf1', type: 'input_textarea', props: { name: 'statement', label: 'The new decision', required: true, rows: 2 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_dcf2', type: 'input_textarea', props: { name: 'rationale', label: 'Why it changed', required: false, rows: 3 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_dcf3', type: 'input_text', props: { name: 'decided_by', label: 'Taken by', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_dcf4', type: 'input_date', props: { name: 'decided_on', label: 'Taken on', required: true, defaultValue: 'today' }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// SETUP — the vocabularies, the people, and the two paragraphs that keep
// the app honest about what it does and does not do on its own.
// ==================================================================
const SCREEN_SETUP = {
    id: 'scr_setup',
    name: 'Setup',
    icon: 'TableProperties',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Meeting kinds, action statuses, people — and what needs wiring.',
    sections: [
        {
            id: 'sec_sttop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_sthdr',
                    type: 'page_header',
                    props: {
                        title: 'Setup',
                        subtitle: 'These vocabularies are data, not code — add an action status and the board grows a column.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'TableProperties',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_stnote',
                    type: 'callout',
                    props: {
                        title: 'The one thing that needs wiring',
                        text: 'Everything in this app works out of the box except **Send for transcription**. That button sets a recording to `queued` and asks a routine to run; without one, nothing happens. Build a routine that reads recordings with status `queued`, sends the file to the self-hosted WhisperX service, writes the diarised text back into `transcript_text` and sets the status to `done`. Reading decisions and actions out of a transcript needs no routine at all.',
                        tone: 'warning',
                    },
                    style: { span: 12 },
                    visible: true,
                },
                {
                    id: 'cmp_stnote2',
                    type: 'callout',
                    props: {
                        title: 'Retention, and who may read what',
                        text: 'A recording is usually the most sensitive thing an organisation holds — it contains everything that was said, not just what was minuted. So the media and the transcript are readable by the Secretary role only; Team members and Auditors see the meeting, the decisions and the actions, but never the tape. **Purge media now** on the Dossier screen clears the file and the transcript in one write and leaves a tombstone (purged, purged_on). The decisions and actions keep the quote they came from, so the record of *why* survives the deletion of the recording (GDPR Art. 5(1)(e), storage limitation). Two lists here are fixed in the app design rather than read from these tables: the Kind dropdown on a new meeting, and the Starting status dropdown on the confirm form. A new row here shows up everywhere else immediately.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_stmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_sttabs',
                    // tabs takes span+gap+padding and NO height; tab takes
                    // gap+padding only.
                    type: 'tabs',
                    props: {},
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sttab0',
                            type: 'tab',
                            props: { label: 'Action statuses', icon: 'ListChecks' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_ststg',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_mdstat', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 140, sortable: true, filterable: false, editable: false },
                                            { key: 'name', label: 'Column heading', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'category', label: 'Counts as', format: 'badge', width: 140, sortable: true, filterable: true, editable: true },
                                            { key: 'color', label: 'Colour', format: 'badge', width: 120, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Delete', actionId: 'act_ststdel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No statuses — the Actions board has no columns until there is at least one.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_ststsave',
                                },
                                {
                                    id: 'cmp_ststadd',
                                    type: 'button',
                                    props: { label: 'Add status', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_ststopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sttab1',
                            type: 'tab',
                            props: { label: 'Meeting kinds', icon: 'Tags' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_stkig',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_mdkind', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 140, sortable: true, filterable: false, editable: false },
                                            { key: 'name', label: 'Name', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'default_classification', label: 'Starts as', format: 'badge', width: 180, sortable: false, filterable: false, editable: true },
                                            { key: 'default_retention_days', label: 'Keep media (days)', format: 'number', width: 150, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Delete', actionId: 'act_stkidel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No meeting kinds configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_stkisave',
                                },
                                {
                                    id: 'cmp_stkiadd',
                                    type: 'button',
                                    props: { label: 'Add kind', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_stkiopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sttab2',
                            type: 'tab',
                            props: { label: 'People', icon: 'IdCard' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_stppg',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_mdppl', sort: [{ field: 'name', dir: 'asc' }], limit: 100 },
                                        columns: [
                                            { key: 'name', label: 'Name', format: 'text', width: 220, sortable: true, filterable: true, editable: true },
                                            { key: 'email', label: 'E-mail', format: 'text', width: 260, sortable: true, filterable: true, editable: true },
                                            { key: 'team', label: 'Team', format: 'text', width: 180, sortable: true, filterable: true, editable: true },
                                            { key: 'is_active', label: 'Active', format: 'boolean', width: 90, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: true,
                                        rowActions: [{ label: 'Delete', actionId: 'act_stppdel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'Nobody listed yet.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_stppsave',
                                },
                                {
                                    id: 'cmp_stppadd',
                                    type: 'button',
                                    props: { label: 'Add person', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_stppopen',
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            // The add dialogs are hoisted OUT of the tabs. Nested, the path would
            // read section → tabs → tab → modal → form → input, which is exactly
            // the depth ceiling. A modal is positioned by the runtime, not by its
            // slot, so hoisting costs nothing.
            id: 'sec_stdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_ststmod',
                    type: 'modal',
                    props: { title: 'Add an action status', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_ststfrm',
                            type: 'form',
                            props: { name: 'newstatus', submitLabel: 'Add status', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_ststadd',
                            children: [
                                { id: 'cmp_ststf1', type: 'input_text', props: { name: 'key', label: 'Key (what an action stores, e.g. waiting)', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_ststf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_ststf3', type: 'input_text', props: { name: 'name', label: 'Column heading', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_ststf4', type: 'input_select', props: { name: 'category', label: 'Counts as', required: true, options: STATUS_CATEGORY_OPTIONS, defaultValue: 'open', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_ststf5', type: 'input_select', props: { name: 'color', label: 'Colour', required: false, options: COLOR_OPTIONS, defaultValue: 'neutral', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_stkimod',
                    type: 'modal',
                    props: { title: 'Add a meeting kind', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_stkifrm',
                            type: 'form',
                            props: { name: 'newkind', submitLabel: 'Add kind', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_stkiadd',
                            children: [
                                { id: 'cmp_stkif1', type: 'input_text', props: { name: 'key', label: 'Key (e.g. works_council)', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_stkif2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_stkif3', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_stkif4', type: 'input_select', props: { name: 'default_classification', label: 'Starts as', required: false, options: CLASSIFICATION_OPTIONS, defaultValue: 'internal', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_stkif5', type: 'input_number', props: { name: 'default_retention_days', label: 'Keep media for (days)', required: false, min: 1, max: 3650, step: 1, defaultValue: 90 }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_stppmod',
                    type: 'modal',
                    props: { title: 'Add a person', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_stppfrm',
                            type: 'form',
                            props: { name: 'newperson', submitLabel: 'Add person', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_stppadd',
                            children: [
                                { id: 'cmp_stppf1', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                // The identity "Only mine" on the Actions board
                                // matches, and the same string embedded in
                                // Nextcloud as standalone.
                                { id: 'cmp_stppf2', type: 'input_text', props: { name: 'email', label: 'E-mail', required: false, inputType: 'email' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_stppf3', type: 'input_text', props: { name: 'team', label: 'Team', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

/**
 * ── THE LOGIC BEHIND THE CONTROLS ──────────────────────────────────────────
 *
 * Three rules run through all of it.
 *
 * WHERE CONTEXT COMES FROM. A server step (create/update/delete_record and the
 * AI steps) sees form, vars, item, value, currentUser, now and today — and NOT
 * screen, forms, actions, records or datasets. So a write reads the event
 * payload (form.*, item.*) or a variable an earlier client step set. Nothing
 * here reads screen.params: that resolves in preview and writes NULL in
 * production, which is the worst kind of wrong.
 *
 * WHY EVERY MUTATION ENDS IN `refresh`. Nothing invalidates a bound query after
 * a write, so without it a confirmed action stays in the review queue until
 * something else happens to refetch. `refresh` names the table it dirtied.
 *
 * WHY A GUARD BEFORE MOST WRITES. Every screen but Meetings depends on a
 * selection, and a create with a null parent writes an orphan nobody can find.
 * A toast that says which screen to go to is a better outcome than a row that
 * exists but is invisible.
 */
const actions = {
    // ── Meetings ───────────────────────────────────────────────────────────

    /** Pick the meeting the whole app is scoped to. `item` is the clicked row. */
    act_mmpick: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'meeting', value: { kind: 'formula', expr: 'item' } },
            // A recording belongs to ONE meeting, so a stale selection would
            // leave the Dossier showing the previous meeting's transcript under
            // the new meeting's title.
            { kind: 'set_variable', name: 'rec', value: { kind: 'static', value: null } },
        ],
    },

    /**
     * Clearing the meeting is a first-class control, not an oversight: the
     * Review queue, the Actions board and the Decision log all widen to
     * everything when nothing is selected, and that is their most useful state.
     */
    act_mmclear: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'meeting', value: { kind: 'static', value: null } },
            { kind: 'set_variable', name: 'rec', value: { kind: 'static', value: null } },
        ],
    },

    act_mmgo: { kind: 'navigate', screenId: 'scr_dossier' },

    act_mmopen: { kind: 'open_modal', modalId: 'cmp_mmmod' },

    act_mmcreate: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_mdmeet',
                resultVar: 'createdMeeting',
                values: {
                    title: { kind: 'formula', expr: 'form.title' },
                    meeting_date: { kind: 'formula', expr: 'form.meeting_date' },
                    kind: { kind: 'formula', expr: 'form.kind' },
                    chair_name: { kind: 'formula', expr: 'form.chair_name' },
                    attendees: { kind: 'formula', expr: 'form.attendees' },
                    location: { kind: 'formula', expr: 'form.location' },
                    classification: { kind: 'formula', expr: 'form.classification' },
                    retention_until: { kind: 'formula', expr: 'form.retention_until' },
                    is_closed: { kind: 'static', value: false },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_mmmod' },
            { kind: 'reset_form', form: 'newmeeting' },
            { kind: 'refresh', tableId: 'tbl_mdmeet' },
            { kind: 'toast', message: 'Meeting created. Pick it in the list to open its dossier.', tone: 'success' },
        ],
    },

    // ── Dossier ────────────────────────────────────────────────────────────

    act_mdback: { kind: 'navigate', screenId: 'scr_meetings' },

    act_mdrecpick: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'rec', value: { kind: 'formula', expr: 'item' } }],
    },

    act_mdrecopen: { kind: 'open_modal', modalId: 'cmp_mdrmod' },

    act_mdrecadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.meeting.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_mdrec',
                        values: {
                            meeting_id: { kind: 'formula', expr: 'vars.meeting.id' },
                            // Display copies, written here and nowhere else.
                            meeting_title: { kind: 'formula', expr: 'vars.meeting.title' },
                            retention_until: { kind: 'formula', expr: 'vars.meeting.retention_until' },
                            label: { kind: 'formula', expr: 'form.label' },
                            source: { kind: 'formula', expr: 'form.source' },
                            media: { kind: 'formula', expr: 'form.media' },
                            transcript_text: { kind: 'formula', expr: 'form.transcript_text' },
                            duration_minutes: { kind: 'formula', expr: 'form.duration_minutes' },
                            transcription_status: { kind: 'static', value: 'none' },
                            purged: { kind: 'static', value: false },
                        },
                    },
                    { kind: 'close_modal', modalId: 'cmp_mdrmod' },
                    { kind: 'reset_form', form: 'newrec' },
                    { kind: 'refresh', tableId: 'tbl_mdrec' },
                    { kind: 'toast', message: 'Added. Select it on the left to work with it.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Pick a meeting on the Meetings screen first — a recording belongs to one.', tone: 'info' },
                ],
            },
        ],
    },

    /**
     * THE ROUTINE HOP. There is no transcribe step, so this is deliberately two
     * halves: the app sets the queue flag it owns, then asks a routine to run.
     * The routine takes no arguments — its contract is the QUEUE (status
     * 'queued'), which is also the only contract that survives it being run on
     * a schedule instead of by this button.
     */
    act_mdtrans: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.rec.id',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_mdrec',
                        recordId: { kind: 'formula', expr: 'vars.rec.id' },
                        values: { transcription_status: { kind: 'static', value: 'queued' } },
                    },
                    { kind: 'refresh', tableId: 'tbl_mdrec' },
                    // automationId:null is the honest state of an unwired hop —
                    // it installs cleanly and warns rather than pretending.
                    { kind: 'run_automation', automationId: null },
                    { kind: 'toast', message: 'Queued for transcription. This needs a routine wired in Automations — see Setup.', tone: 'info' },
                ],
                else: [
                    { kind: 'toast', message: 'Select a recording on the left first.', tone: 'info' },
                ],
            },
        ],
    },

    /**
     * THE EXTRACTION. Two passes over the same document, because a decision and
     * an action are different shapes and one schema returning both would make
     * every row half-empty.
     *
     * What the model may write is bounded by the MAPPING: statement, rationale,
     * quotes, timecodes, and the *_hint columns. `owner_name`, `owner_email`,
     * `due_date`, `decided_by` and `decided_on` are not in it — those are the
     * columns a person fills in on Review. `confirmation: 'suggested'` is a
     * writeTo CONSTANT, resolved once and applied AFTER the mapped values, so
     * nothing the model returns can reach it.
     *
     * promptContext is the speaker map for this meeting: it is what turns
     * "SPEAKER_02 said they would do it" into an owner hint with a name on it.
     */
    act_mdextract: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.rec.media',
                then: [
                    {
                        kind: 'ai_extract',
                        source: { kind: 'formula', expr: 'vars.rec.media' },
                        schema: [
                            { name: 'statement', type: 'string', description: 'The decision as taken, in one sentence, in the past tense. Only include something that was actually settled — not an option that was merely discussed.', required: true },
                            { name: 'rationale', type: 'string', description: 'Why it was decided, if the transcript says. Leave empty rather than inventing a reason.' },
                            { name: 'decided_by_hint', type: 'string', description: 'The name of the person the transcript indicates took or announced the decision, exactly as it appears. Leave empty if it is not clear. Do NOT guess from who spoke most.' },
                            { name: 'source_quote', type: 'string', description: 'The sentence from the transcript this decision is based on, verbatim.', required: true },
                            { name: 'source_timecode', type: 'string', description: 'The timecode of that sentence as it appears in the transcript, e.g. 00:14:22. Empty if the transcript has no timecodes.' },
                        ],
                        promptContext: {
                            kind: 'records',
                            tableId: 'tbl_mdspk',
                            filter: [{ field: 'meeting_id', op: 'eq', value: { kind: 'formula', expr: 'vars.meeting.id' }, required: true }],
                            sort: [{ field: 'position', dir: 'asc' }],
                            limit: 40,
                        },
                        documentMode: 'auto',
                        modelTier: 'thinking',
                        knowledgeBaseIds: [],
                        writeTo: {
                            tableId: 'tbl_mddec',
                            mapping: {
                                statement: 'statement',
                                rationale: 'rationale',
                                decided_by_hint: 'decided_by_hint',
                                source_quote: 'source_quote',
                                source_timecode: 'source_timecode',
                            },
                            constants: {
                                meeting_id: { kind: 'formula', expr: 'vars.meeting.id' },
                                meeting_title: { kind: 'formula', expr: 'vars.meeting.title' },
                                meeting_date: { kind: 'formula', expr: 'vars.meeting.meeting_date' },
                                confirmation: { kind: 'static', value: 'suggested' },
                                state: { kind: 'static', value: 'active' },
                                origin: { kind: 'static', value: 'extracted' },
                                extracted_at: { kind: 'formula', expr: 'now' },
                            },
                        },
                        resultVar: 'extractedDecisions',
                    },
                    { kind: 'refresh', tableId: 'tbl_mddec' },
                    {
                        kind: 'ai_extract',
                        source: { kind: 'formula', expr: 'vars.rec.media' },
                        schema: [
                            { name: 'title', type: 'string', description: 'What was agreed would be done, as a short imperative sentence.', required: true },
                            { name: 'detail', type: 'string', description: 'Any extra detail from the transcript about what is expected.' },
                            { name: 'owner_hint', type: 'string', description: 'The name of the person the transcript says will do this, exactly as it appears. Leave empty if nobody was named. Never infer an owner from who was speaking.' },
                            { name: 'due_hint', type: 'string', description: 'Any deadline said out loud, in the words used, e.g. "before the next board" or "end of the month". Do NOT convert it to a date.' },
                            { name: 'source_quote', type: 'string', description: 'The sentence from the transcript this action is based on, verbatim.', required: true },
                            { name: 'source_timecode', type: 'string', description: 'The timecode of that sentence as it appears in the transcript. Empty if there are none.' },
                        ],
                        promptContext: {
                            kind: 'records',
                            tableId: 'tbl_mdspk',
                            filter: [{ field: 'meeting_id', op: 'eq', value: { kind: 'formula', expr: 'vars.meeting.id' }, required: true }],
                            sort: [{ field: 'position', dir: 'asc' }],
                            limit: 40,
                        },
                        documentMode: 'auto',
                        modelTier: 'thinking',
                        knowledgeBaseIds: [],
                        writeTo: {
                            tableId: 'tbl_mdact',
                            mapping: {
                                title: 'title',
                                detail: 'detail',
                                owner_hint: 'owner_hint',
                                due_hint: 'due_hint',
                                source_quote: 'source_quote',
                                source_timecode: 'source_timecode',
                            },
                            constants: {
                                meeting_id: { kind: 'formula', expr: 'vars.meeting.id' },
                                meeting_title: { kind: 'formula', expr: 'vars.meeting.title' },
                                meeting_date: { kind: 'formula', expr: 'vars.meeting.meeting_date' },
                                confirmation: { kind: 'static', value: 'suggested' },
                                status: { kind: 'static', value: 'open' },
                                origin: { kind: 'static', value: 'extracted' },
                                extracted_at: { kind: 'formula', expr: 'now' },
                            },
                        },
                        resultVar: 'extractedActions',
                    },
                    { kind: 'refresh', tableId: 'tbl_mdact' },
                    { kind: 'navigate', screenId: 'scr_review' },
                    { kind: 'toast', message: 'Read out of the transcript. Nothing is owned until you confirm it.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'This entry has no file to read. Upload the recording or a transcript file — or write the decisions and actions in by hand on the Dossier screen.', tone: 'info' },
                ],
            },
        ],
    },

    /**
     * RETENTION, in one write. The media and the transcript go; the row stays as
     * a tombstone so "there was a recording and it was deleted on the 2nd" is
     * still answerable. `transcription_status` is deliberately NOT reset — that
     * it was once transcribed is a fact, not a state.
     */
    act_mdpurge: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.rec.id',
                then: [
                    { kind: 'confirm', message: 'Delete the file and the transcript for this entry? The decisions and actions taken from it stay, including the sentence each one quotes. This cannot be undone.', title: 'Purge media' },
                    {
                        kind: 'update_record',
                        tableId: 'tbl_mdrec',
                        recordId: { kind: 'formula', expr: 'vars.rec.id' },
                        values: {
                            // A bare null in a binding prop gets wrapped by
                            // canonicalize, so both are explicit statics.
                            media: { kind: 'static', value: null },
                            transcript_text: { kind: 'static', value: null },
                            purged: { kind: 'static', value: true },
                            purged_on: { kind: 'formula', expr: 'today' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_mdrec' },
                    // `refresh` refetches the TABLE; it cannot reach into a
                    // record variable, and vars.rec still holds the row as it
                    // was before the write. Leaving it there would keep the
                    // just-deleted transcript on screen under a toast saying it
                    // is gone, and — worse — leave "Send for transcription"
                    // visible over a row with no media, which would queue a
                    // recording the routine can only fail on. Clearing the
                    // selection is the honest end of a purge: the media buttons
                    // are all gated on vars.rec.id, and re-picking the row shows
                    // the tombstone as it now actually is.
                    { kind: 'set_variable', name: 'rec', value: { kind: 'static', value: null } },
                    { kind: 'toast', message: 'Media deleted. The minute survives it.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Select a recording on the left first.', tone: 'info' },
                ],
            },
        ],
    },

    /**
     * Inline edits on the speaker map. The grid is selectable:'none', so
     * onRowSelect only ever fires for a committed cell edit and carries the
     * whole edited row.
     */
    act_mdspksave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_mdspk',
                recordId: { kind: 'formula', expr: 'form.id' },
                // Compare-and-set: refuse the write rather than silently
                // overwriting someone who changed the row first.
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    speaker_label: { kind: 'formula', expr: 'form.speaker_label' },
                    person_name: { kind: 'formula', expr: 'form.person_name' },
                    person_email: { kind: 'formula', expr: 'form.person_email' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_mdspk' },
        ],
    },

    act_mdspkopen: { kind: 'open_modal', modalId: 'cmp_mdsmod' },

    act_mdspkadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.meeting.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_mdspk',
                        values: {
                            meeting_id: { kind: 'formula', expr: 'vars.meeting.id' },
                            speaker_label: { kind: 'formula', expr: 'form.speaker_label' },
                            person_name: { kind: 'formula', expr: 'form.person_name' },
                            person_email: { kind: 'formula', expr: 'form.person_email' },
                            position: { kind: 'formula', expr: 'form.position' },
                        },
                    },
                    { kind: 'close_modal', modalId: 'cmp_mdsmod' },
                    { kind: 'reset_form', form: 'newspeaker' },
                    { kind: 'refresh', tableId: 'tbl_mdspk' },
                ],
                else: [
                    { kind: 'toast', message: 'Pick a meeting first — a speaker map belongs to one.', tone: 'info' },
                ],
            },
        ],
    },

    act_mdspkdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Remove this speaker from the map? Anything already extracted keeps the hint it was given.', title: 'Remove speaker' },
            { kind: 'delete_record', tableId: 'tbl_mdspk', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_mdspk' },
        ],
    },

    act_mddecopen: { kind: 'open_modal', modalId: 'cmp_mddmod' },

    /**
     * The by-hand path, and the reason the app needs no AI at all. A decision a
     * person typed is CONFIRMED on arrival — it never went through a model, so
     * there is nothing to review. That is exactly why `origin` is stored: the
     * two routes leave rows that look identical otherwise.
     */
    act_mddecadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.meeting.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_mddec',
                        values: {
                            meeting_id: { kind: 'formula', expr: 'vars.meeting.id' },
                            meeting_title: { kind: 'formula', expr: 'vars.meeting.title' },
                            meeting_date: { kind: 'formula', expr: 'vars.meeting.meeting_date' },
                            statement: { kind: 'formula', expr: 'form.statement' },
                            rationale: { kind: 'formula', expr: 'form.rationale' },
                            decided_by: { kind: 'formula', expr: 'form.decided_by' },
                            decided_on: { kind: 'formula', expr: 'form.decided_on' },
                            source_quote: { kind: 'formula', expr: 'form.source_quote' },
                            source_timecode: { kind: 'formula', expr: 'form.source_timecode' },
                            confirmation: { kind: 'static', value: 'confirmed' },
                            state: { kind: 'static', value: 'active' },
                            origin: { kind: 'static', value: 'manual' },
                            confirmed_by: { kind: 'formula', expr: 'currentUser.name' },
                            confirmed_at: { kind: 'formula', expr: 'now' },
                        },
                    },
                    { kind: 'close_modal', modalId: 'cmp_mddmod' },
                    { kind: 'reset_form', form: 'newdecision' },
                    { kind: 'refresh', tableId: 'tbl_mddec' },
                    { kind: 'toast', message: 'Added to the decision log.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Pick a meeting first — a decision is taken in one.', tone: 'info' },
                ],
            },
        ],
    },

    act_mdactopen: { kind: 'open_modal', modalId: 'cmp_mdamod' },

    act_mdactadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.meeting.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_mdact',
                        values: {
                            meeting_id: { kind: 'formula', expr: 'vars.meeting.id' },
                            meeting_title: { kind: 'formula', expr: 'vars.meeting.title' },
                            meeting_date: { kind: 'formula', expr: 'vars.meeting.meeting_date' },
                            title: { kind: 'formula', expr: 'form.title' },
                            detail: { kind: 'formula', expr: 'form.detail' },
                            owner_name: { kind: 'formula', expr: 'form.owner_name' },
                            owner_email: { kind: 'formula', expr: 'form.owner_email' },
                            due_date: { kind: 'formula', expr: 'form.due_date' },
                            source_quote: { kind: 'formula', expr: 'form.source_quote' },
                            status: { kind: 'static', value: 'open' },
                            confirmation: { kind: 'static', value: 'confirmed' },
                            origin: { kind: 'static', value: 'manual' },
                            confirmed_by: { kind: 'formula', expr: 'currentUser.name' },
                            confirmed_at: { kind: 'formula', expr: 'now' },
                        },
                    },
                    { kind: 'close_modal', modalId: 'cmp_mdamod' },
                    { kind: 'reset_form', form: 'newaction' },
                    { kind: 'refresh', tableId: 'tbl_mdact' },
                    { kind: 'toast', message: 'On the board, owned.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Pick a meeting first — an action comes out of one.', tone: 'info' },
                ],
            },
        ],
    },

    // ── Review — where a suggestion becomes someone's work ──────────────────

    act_rvdecopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'decision', value: { kind: 'formula', expr: 'item' } },
            { kind: 'open_modal', modalId: 'cmp_rvdmod' },
        ],
    },

    /**
     * `decided_by` and `decided_on` come from the FORM, never from the hint. The
     * hint pre-fills the field (valueFrom) so agreeing costs one click, but the
     * value written is whatever a person left in the box.
     */
    act_rvdecok: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_mddec',
                recordId: { kind: 'formula', expr: 'vars.decision.id' },
                values: {
                    confirmation: { kind: 'static', value: 'confirmed' },
                    state: { kind: 'static', value: 'active' },
                    decided_by: { kind: 'formula', expr: 'form.decided_by' },
                    decided_on: { kind: 'formula', expr: 'form.decided_on' },
                    confirmed_by: { kind: 'formula', expr: 'currentUser.name' },
                    confirmed_at: { kind: 'formula', expr: 'now' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_rvdmod' },
            { kind: 'reset_form', form: 'confirmdec' },
            { kind: 'refresh', tableId: 'tbl_mddec' },
            { kind: 'toast', message: 'In the decision log.', tone: 'success' },
        ],
    },

    /** Discarded, not deleted: what a model proposed and a person rejected is itself worth keeping. */
    act_rvdecno: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Discard this suggestion? It stays in the data marked discarded, so you can see what was proposed.', title: 'Discard suggestion' },
            {
                kind: 'update_record',
                tableId: 'tbl_mddec',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: { confirmation: { kind: 'static', value: 'discarded' } },
            },
            { kind: 'refresh', tableId: 'tbl_mddec' },
        ],
    },

    act_rvactopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'action', value: { kind: 'formula', expr: 'item' } },
            { kind: 'open_modal', modalId: 'cmp_rvamod' },
        ],
    },

    act_rvactok: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_mdact',
                recordId: { kind: 'formula', expr: 'vars.action.id' },
                values: {
                    confirmation: { kind: 'static', value: 'confirmed' },
                    owner_name: { kind: 'formula', expr: 'form.owner_name' },
                    owner_email: { kind: 'formula', expr: 'form.owner_email' },
                    due_date: { kind: 'formula', expr: 'form.due_date' },
                    status: { kind: 'formula', expr: 'form.status' },
                    confirmed_by: { kind: 'formula', expr: 'currentUser.name' },
                    confirmed_at: { kind: 'formula', expr: 'now' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_rvamod' },
            { kind: 'reset_form', form: 'confirmact' },
            { kind: 'refresh', tableId: 'tbl_mdact' },
            { kind: 'toast', message: 'Owned, and on the board.', tone: 'success' },
        ],
    },

    act_rvactno: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Discard this suggestion? It stays in the data marked discarded.', title: 'Discard suggestion' },
            {
                kind: 'update_record',
                tableId: 'tbl_mdact',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: { confirmation: { kind: 'static', value: 'discarded' } },
            },
            { kind: 'refresh', tableId: 'tbl_mdact' },
        ],
    },

    // ── Actions board ──────────────────────────────────────────────────────

    /**
     * The drag. `form.value` is the column the card landed in, which for this
     * board IS the status key. `completed_at` is stamped only for the terminal
     * column and cleared on the way back out, so re-opening an action does not
     * leave it claiming a completion date it no longer has.
     *
     * The terminal key is hardcoded because a server step cannot read the
     * column's `category` from action_statuses — there is no join. Setup names
     * the key, and the test suite asserts the seeded vocabulary contains it.
     */
    act_acmove: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: "form.value == 'done'",
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_mdact',
                        recordId: { kind: 'formula', expr: 'form.item.id' },
                        values: {
                            status: { kind: 'formula', expr: 'form.value' },
                            completed_at: { kind: 'formula', expr: 'now' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_mdact' },
                ],
                else: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_mdact',
                        recordId: { kind: 'formula', expr: 'form.item.id' },
                        values: {
                            status: { kind: 'formula', expr: 'form.value' },
                            completed_at: { kind: 'static', value: null },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_mdact' },
                ],
            },
        ],
    },

    act_acopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'action', value: { kind: 'formula', expr: 'item' } },
            { kind: 'open_modal', modalId: 'cmp_acmod' },
        ],
    },

    /** Reassigning is an ordinary edit — and it is recorded by updated_at, which nothing here overwrites. */
    act_acsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_mdact',
                recordId: { kind: 'formula', expr: 'vars.action.id' },
                values: {
                    owner_name: { kind: 'formula', expr: 'form.owner_name' },
                    owner_email: { kind: 'formula', expr: 'form.owner_email' },
                    due_date: { kind: 'formula', expr: 'form.due_date' },
                    detail: { kind: 'formula', expr: 'form.detail' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_acmod' },
            { kind: 'reset_form', form: 'reassign' },
            { kind: 'refresh', tableId: 'tbl_mdact' },
        ],
    },

    // ── Decision log ───────────────────────────────────────────────────────

    act_dcpick: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'decision', value: { kind: 'formula', expr: 'item' } }],
    },

    act_dcsupopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'decision', value: { kind: 'formula', expr: 'item' } },
            { kind: 'open_modal', modalId: 'cmp_dcmod' },
        ],
    },

    /**
     * Superseding writes TWO rows' worth of change: a new decision that points
     * back at the old one (and carries a copy of its wording, since there is no
     * join to follow), and the old one moved to 'superseded'. Both touch
     * tbl_mddec, so one refresh covers them.
     *
     * `meeting_id` comes from the SELECTED meeting, which may be null — a
     * decision taken outside any minuted meeting is a real thing, and recording
     * it as such beats attaching it to whichever meeting happened to be open.
     */
    act_dcsupsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_mddec',
                values: {
                    statement: { kind: 'formula', expr: 'form.statement' },
                    rationale: { kind: 'formula', expr: 'form.rationale' },
                    decided_by: { kind: 'formula', expr: 'form.decided_by' },
                    decided_on: { kind: 'formula', expr: 'form.decided_on' },
                    meeting_id: { kind: 'formula', expr: 'vars.meeting.id' },
                    meeting_title: { kind: 'formula', expr: 'vars.meeting.title' },
                    meeting_date: { kind: 'formula', expr: 'form.decided_on' },
                    supersedes_id: { kind: 'formula', expr: 'vars.decision.id' },
                    supersedes_statement: { kind: 'formula', expr: 'vars.decision.statement' },
                    confirmation: { kind: 'static', value: 'confirmed' },
                    state: { kind: 'static', value: 'active' },
                    origin: { kind: 'static', value: 'manual' },
                    confirmed_by: { kind: 'formula', expr: 'currentUser.name' },
                    confirmed_at: { kind: 'formula', expr: 'now' },
                },
            },
            {
                kind: 'update_record',
                tableId: 'tbl_mddec',
                recordId: { kind: 'formula', expr: 'vars.decision.id' },
                values: { state: { kind: 'static', value: 'superseded' } },
            },
            { kind: 'close_modal', modalId: 'cmp_dcmod' },
            { kind: 'reset_form', form: 'supersede' },
            { kind: 'refresh', tableId: 'tbl_mddec' },
            { kind: 'toast', message: 'Recorded. The old decision is kept, marked superseded.', tone: 'success' },
        ],
    },

    // ── Setup — every vocabulary can be read, added to and removed from ────

    act_ststopen: { kind: 'open_modal', modalId: 'cmp_ststmod' },
    act_ststadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_mdstat',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    category: { kind: 'formula', expr: 'form.category' },
                    color: { kind: 'formula', expr: 'form.color' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_ststmod' },
            { kind: 'reset_form', form: 'newstatus' },
            { kind: 'refresh', tableId: 'tbl_mdstat' },
            { kind: 'toast', message: 'Added — the Actions board has the column now.', tone: 'success' },
        ],
    },
    act_ststsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_mdstat',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    category: { kind: 'formula', expr: 'form.category' },
                    color: { kind: 'formula', expr: 'form.color' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_mdstat' },
        ],
    },
    act_ststdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this status? Actions already in it keep the key and will sit in a trailing column until another one collects them.', title: 'Delete status' },
            { kind: 'delete_record', tableId: 'tbl_mdstat', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_mdstat' },
        ],
    },

    act_stkiopen: { kind: 'open_modal', modalId: 'cmp_stkimod' },
    act_stkiadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_mdkind',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    default_classification: { kind: 'formula', expr: 'form.default_classification' },
                    default_retention_days: { kind: 'formula', expr: 'form.default_retention_days' },
                    position: { kind: 'formula', expr: 'form.position' },
                    color: { kind: 'static', value: 'neutral' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_stkimod' },
            { kind: 'reset_form', form: 'newkind' },
            { kind: 'refresh', tableId: 'tbl_mdkind' },
        ],
    },
    act_stkisave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_mdkind',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    default_classification: { kind: 'formula', expr: 'form.default_classification' },
                    default_retention_days: { kind: 'formula', expr: 'form.default_retention_days' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_mdkind' },
        ],
    },
    act_stkidel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this meeting kind? Meetings already using it keep the key.', title: 'Delete kind' },
            { kind: 'delete_record', tableId: 'tbl_mdkind', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_mdkind' },
        ],
    },

    act_stppopen: { kind: 'open_modal', modalId: 'cmp_stppmod' },
    act_stppadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_mdppl',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    email: { kind: 'formula', expr: 'form.email' },
                    team: { kind: 'formula', expr: 'form.team' },
                    is_active: { kind: 'static', value: true },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_stppmod' },
            { kind: 'reset_form', form: 'newperson' },
            { kind: 'refresh', tableId: 'tbl_mdppl' },
        ],
    },
    act_stppsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_mdppl',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    email: { kind: 'formula', expr: 'form.email' },
                    team: { kind: 'formula', expr: 'form.team' },
                    is_active: { kind: 'formula', expr: 'form.is_active' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_mdppl' },
        ],
    },
    act_stppdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Remove this person? Actions they own keep their name.', title: 'Remove person' },
            { kind: 'delete_record', tableId: 'tbl_mdppl', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_mdppl' },
        ],
    },
};

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'Meeting dossier',
        description: 'Recording to decisions and actions, with a person in between.',
        icon: 'MessageSquareQuote',
    },
    theme: { ...THEME_DEFAULTS, primary: '#334155', radius: 'sm', density: 'compact' },
    // The mono identity in the cabinet face: a dense, businesslike minute-book
    // in slate — flat surfaces, no motion, and a plain top tab row. The one
    // flourish it allows itself is the hero opening on the Meetings screen.
    design: { preset: 'mono', font: 'cabinet', surface: 'flat', motion: 'none', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
    nav: { style: 'tabs' },
    roles: [
        { id: 'secretary', name: 'Secretary' },
        { id: 'member', name: 'Team member' },
        { id: 'auditor', name: 'Auditor' },
    ],
    /**
     * `filters` is NOT declared — it is a reserved name owned by filter_bar,
     * which publishes into it directly. Declaring it is an error.
     */
    variables: [
        { name: 'meeting', label: 'Selected meeting', type: 'record', default: null, description: 'The meeting the Dossier is about. Optional everywhere else: when it is null the Review queue, the Actions board and the Decision log show every meeting.' },
        { name: 'rec', label: 'Selected recording', type: 'record', default: null, description: 'The recording or transcript being worked on. Cleared whenever the meeting changes.' },
        { name: 'decision', label: 'Open decision', type: 'record', default: null, description: 'The decision being reviewed, read or superseded.' },
        { name: 'action', label: 'Open action', type: 'record', default: null, description: 'The action being confirmed or edited.' },
    ],
    homeScreenId: 'scr_meetings',
    screens: [
        SCREEN_MEETINGS,
        SCREEN_DOSSIER,
        SCREEN_REVIEW,
        SCREEN_ACTIONS,
        SCREEN_DECISIONS,
        SCREEN_SETUP,
    ],
    actions,
};

// ---------------------------------------------------------------------------
// Seed
//
// Four meetings that between them show every state the app has: a board meeting
// transcribed and fully reviewed, a client kick-off whose recording has already
// been PURGED (its decisions and actions survive, each still quoting the
// sentence it came from), a stand-up sitting in the transcription queue, and a
// restricted one-to-one whose recording is PAST its retention date — so the
// "Past retention" tile reads 1 on install and there is something to do about it.
//
// The Review screen is not empty on first open: two decisions and three actions
// arrive as suggestions, with hints and no owners, which is the one thing a
// reader has to see to understand the app.
//
// `$id` is a LOCAL alias, never a column; { $ref } points at a row seeded
// EARLIER. templateInstall seeds parent tables first and rewrites the refs to
// real ids — and within one table a later row may reference an earlier one,
// which is what makes the superseded-decision chain seedable.
//
// Every person and organisation here is invented; every address is example.com.
// ---------------------------------------------------------------------------

const seed = {
    tbl_mdkind: [
        { key: 'board', name: 'Board meeting', color: 'primary', default_classification: 'confidential', default_retention_days: 90, position: 1 },
        { key: 'standup', name: 'Stand-up', color: 'info', default_classification: 'internal', default_retention_days: 30, position: 2 },
        { key: 'client', name: 'Client meeting', color: 'success', default_classification: 'internal', default_retention_days: 90, position: 3 },
        // The shortest clock in the app, and deliberately so: a one-to-one is
        // the recording an employee is least comfortable existing.
        { key: 'one_to_one', name: 'One-to-one', color: 'warning', default_classification: 'restricted', default_retention_days: 14, position: 4 },
    ],

    tbl_mdstat: [
        { key: 'open', name: 'Not started', category: 'open', color: 'neutral', position: 1 },
        { key: 'doing', name: 'In progress', category: 'doing', color: 'primary', position: 2 },
        { key: 'waiting', name: 'Waiting on someone', category: 'doing', color: 'warning', position: 3 },
        // The terminal key the drag stamps completed_at for. Renaming it means
        // changing DONE_STATUS_KEY too — which is why the test asserts it.
        { key: 'done', name: 'Done', category: 'done', color: 'success', position: 4 },
    ],

    tbl_mdppl: [
        { name: 'Anke Bergsma', email: 'anke@example.com', team: 'Directie', is_active: true },
        { name: 'Marcel Okonkwo', email: 'marcel@example.com', team: 'Delivery', is_active: true },
        { name: 'Sanne Rietveld', email: 'sanne@example.com', team: 'Finance', is_active: true },
        { name: 'Tomas Havel', email: 'tomas@example.com', team: 'Platform', is_active: true },
        { name: 'Iris Bouwman', email: 'iris@example.com', team: 'Delivery', is_active: true },
    ],

    tbl_mdmeet: [
        {
            $id: 'mt_board', title: 'Board meeting — Q3 review', meeting_date: '2026-07-08', kind: 'board',
            chair_name: 'Anke Bergsma', attendees: 'Anke Bergsma, Sanne Rietveld, Marcel Okonkwo',
            location: 'Head office, room Kelder', classification: 'confidential', retention_until: '2026-10-06',
            summary: 'Quarterly numbers, the hosting decision and the hiring freeze.', is_closed: true,
        },
        {
            $id: 'mt_client', title: 'Kick-off — Vlinder Zorggroep migration', meeting_date: '2026-07-15', kind: 'client',
            chair_name: 'Marcel Okonkwo', attendees: 'Marcel Okonkwo, Iris Bouwman, two colleagues from Vlinder Zorggroep',
            location: 'Online', classification: 'internal', retention_until: '2026-10-13',
            summary: 'Scope, the data-processing agreement and a go-live date.', is_closed: true,
        },
        {
            $id: 'mt_stand', title: 'Platform stand-up', meeting_date: '2026-08-11', kind: 'standup',
            chair_name: 'Tomas Havel', attendees: 'Tomas Havel, Iris Bouwman',
            location: 'Online', classification: 'internal', retention_until: '2026-09-10',
            summary: null, is_closed: false,
        },
        {
            // Restricted, and its recording is already past the date it should
            // have been deleted — the reason the Past retention tile is not zero.
            // 14 days after the meeting, per the one-to-one kind's default —
            // and the meeting is old enough that the date has already passed.
            $id: 'mt_one', title: 'One-to-one — probation review', meeting_date: '2026-07-21', kind: 'one_to_one',
            chair_name: 'Marcel Okonkwo', attendees: 'Marcel Okonkwo and one team member',
            location: 'Head office, room Zolder', classification: 'restricted', retention_until: '2026-08-04',
            summary: null, is_closed: true,
        },
    ],

    tbl_mdrec: [
        {
            $id: 'rc_board', meeting_id: { $ref: 'mt_board' }, meeting_title: 'Board meeting — Q3 review',
            label: 'Board recording, 8 July', source: 'recording', transcription_status: 'done',
            duration_minutes: 47, retention_until: '2026-10-06', purged: false,
            transcript_text: '### Transcript — Board meeting, 8 July 2026\n\n**[00:02:10] Anke Bergsma:** Right, the numbers first. Q3 came in four percent under plan, which is annoying but not alarming.\n\n**[00:11:48] Sanne Rietveld:** The bigger question is hosting. If we stay on the current provider we are signing another twelve months next month.\n\n**[00:14:22] Anke Bergsma:** Then let us settle it now. We move the production workload to the Scaleway cluster before the end of Q4. That is decided.\n\n**[00:16:05] Marcel Okonkwo:** I will put together the migration plan and cost comparison. Before the next board, so you have it in writing.\n\n**[00:24:31] Sanne Rietveld:** And we are not backfilling the two open Delivery roles this quarter.\n\n**[00:24:58] Anke Bergsma:** Agreed. Hiring freeze on Delivery until the January board reviews it.\n\n**[00:31:12] Marcel Okonkwo:** Sanne, can you get the updated forecast to me by the end of the month? I need it for the plan.\n\n**[00:31:30] Sanne Rietveld:** End of the month, yes.',
        },
        {
            // PURGED. Everything it produced is still in the app; the recording
            // itself is not. This is the retention story, seeded.
            $id: 'rc_client', meeting_id: { $ref: 'mt_client' }, meeting_title: 'Kick-off — Vlinder Zorggroep migration',
            label: 'Kick-off recording, 15 July', source: 'recording', transcription_status: 'done',
            duration_minutes: 62, retention_until: '2026-10-13', purged: true, purged_on: '2026-08-02',
        },
        {
            $id: 'rc_stand', meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up',
            label: 'Stand-up voice memo', source: 'recording', transcription_status: 'queued',
            duration_minutes: 11, retention_until: '2026-09-10', purged: false,
        },
        {
            // Typed by hand, no audio, no AI — the path that proves the app does
            // not need either.
            $id: 'rc_notes', meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up',
            label: 'Notes typed during the call', source: 'notes', transcription_status: 'none',
            retention_until: '2026-09-10', purged: false,
            transcript_text: '### Notes — stand-up, 11 August\n\nTomas: search reranker is deployed on the dev cluster, latency looks fine.\n\nIris: still blocked on the Vlinder test data, chasing their side.\n\nAgreed: Iris writes the migration runbook this week.',
        },
        {
            $id: 'rc_one', meeting_id: { $ref: 'mt_one' }, meeting_title: 'One-to-one — probation review',
            label: 'One-to-one recording', source: 'recording', transcription_status: 'done',
            duration_minutes: 34, retention_until: '2026-08-04', purged: false,
        },
    ],

    tbl_mdspk: [
        { meeting_id: { $ref: 'mt_board' }, speaker_label: 'SPEAKER_00', person_name: 'Anke Bergsma', person_email: 'anke@example.com', position: 1 },
        { meeting_id: { $ref: 'mt_board' }, speaker_label: 'SPEAKER_01', person_name: 'Sanne Rietveld', person_email: 'sanne@example.com', position: 2 },
        { meeting_id: { $ref: 'mt_board' }, speaker_label: 'SPEAKER_02', person_name: 'Marcel Okonkwo', person_email: 'marcel@example.com', position: 3 },
        { meeting_id: { $ref: 'mt_client' }, speaker_label: 'SPEAKER_00', person_name: 'Marcel Okonkwo', person_email: 'marcel@example.com', position: 1 },
        { meeting_id: { $ref: 'mt_client' }, speaker_label: 'SPEAKER_01', person_name: 'Iris Bouwman', person_email: 'iris@example.com', position: 2 },
        // Deliberately unmapped: a label nobody has identified yet is the normal
        // state of a fresh diarisation, and the extraction leaves the hint empty
        // rather than guessing a name for it.
        { meeting_id: { $ref: 'mt_client' }, speaker_label: 'SPEAKER_02', person_name: null, person_email: null, position: 3 },
        { meeting_id: { $ref: 'mt_stand' }, speaker_label: 'SPEAKER_00', person_name: 'Tomas Havel', person_email: 'tomas@example.com', position: 1 },
        { meeting_id: { $ref: 'mt_stand' }, speaker_label: 'SPEAKER_01', person_name: 'Iris Bouwman', person_email: 'iris@example.com', position: 2 },
    ],

    tbl_mddec: [
        // ── Confirmed, from the board transcript ───────────────────────────
        {
            $id: 'dc_host', meeting_id: { $ref: 'mt_board' }, meeting_title: 'Board meeting — Q3 review', meeting_date: '2026-07-08',
            statement: 'Production moves to the Scaleway Kubernetes cluster before the end of Q4.',
            rationale: 'The current hosting contract renews for another twelve months next month; moving now avoids committing to it.',
            decided_by_hint: 'Anke Bergsma', decided_by: 'Anke Bergsma', decided_on: '2026-07-08',
            confirmation: 'confirmed', state: 'active', origin: 'extracted',
            source_quote: 'Then let us settle it now. We move the production workload to the Scaleway cluster before the end of Q4. That is decided.',
            source_timecode: '00:14:22',
            confirmed_by: 'Anke Bergsma', confirmed_at: '2026-07-09T08:12:00.000Z', extracted_at: '2026-07-08T16:40:00.000Z',
        },
        {
            // The one that gets superseded below — seeded first so the later row
            // can $ref it. This is why a self-relation is worth having.
            $id: 'dc_freeze', meeting_id: { $ref: 'mt_board' }, meeting_title: 'Board meeting — Q3 review', meeting_date: '2026-07-08',
            statement: 'No backfill for the two open Delivery roles until the January board.',
            rationale: 'Q3 came in under plan; the board wants the January numbers before committing to headcount.',
            decided_by_hint: 'Anke Bergsma', decided_by: 'Anke Bergsma', decided_on: '2026-07-08',
            confirmation: 'confirmed', state: 'superseded', origin: 'extracted',
            source_quote: 'Agreed. Hiring freeze on Delivery until the January board reviews it.',
            source_timecode: '00:24:58',
            confirmed_by: 'Anke Bergsma', confirmed_at: '2026-07-09T08:14:00.000Z', extracted_at: '2026-07-08T16:40:00.000Z',
        },
        {
            // Written by hand in a later meeting, and it REPLACES the freeze. The
            // wording of the old decision is copied onto this row because there
            // is no join to read it back through.
            meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up', meeting_date: '2026-08-11',
            statement: 'One Delivery role is released for hiring immediately; the second stays frozen until January.',
            rationale: 'The Vlinder migration needs a second pair of hands before go-live, which the January board would be too late for.',
            decided_by: 'Anke Bergsma', decided_on: '2026-08-11',
            confirmation: 'confirmed', state: 'active', origin: 'manual',
            supersedes_id: { $ref: 'dc_freeze' },
            supersedes_statement: 'No backfill for the two open Delivery roles until the January board.',
            confirmed_by: 'Anke Bergsma', confirmed_at: '2026-08-11T10:05:00.000Z',
        },
        {
            // From the client meeting whose recording has been purged. It still
            // quotes the sentence it came from — that is the point.
            meeting_id: { $ref: 'mt_client' }, meeting_title: 'Kick-off — Vlinder Zorggroep migration', meeting_date: '2026-07-15',
            statement: 'Go-live for the Vlinder Zorggroep migration is set for 1 October 2026.',
            rationale: 'Their financial year closes on 30 September, so a cut-over before that would collide with the year-end run.',
            decided_by_hint: 'Marcel Okonkwo', decided_by: 'Marcel Okonkwo', decided_on: '2026-07-15',
            confirmation: 'confirmed', state: 'active', origin: 'extracted',
            source_quote: 'Then we are agreed — first of October for go-live, after their year end.',
            source_timecode: '00:41:07',
            confirmed_by: 'Marcel Okonkwo', confirmed_at: '2026-07-16T09:30:00.000Z', extracted_at: '2026-07-15T18:02:00.000Z',
        },

        // ── Waiting for a person. No decided_by, no decided_on — only a hint. ──
        {
            meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up', meeting_date: '2026-08-11',
            statement: 'The search reranker stays on the dev cluster until latency has been measured under load.',
            rationale: null,
            decided_by_hint: 'Tomas Havel',
            confirmation: 'suggested', state: 'active', origin: 'extracted',
            source_quote: 'Search reranker is deployed on the dev cluster, latency looks fine — but let us not push it further until we have numbers under load.',
            source_timecode: '00:03:41',
            extracted_at: '2026-08-11T09:20:00.000Z',
        },
        {
            // The hint is EMPTY on purpose: the transcript named nobody, and the
            // extraction is instructed to leave it empty rather than guess.
            meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up', meeting_date: '2026-08-11',
            statement: 'The Vlinder test data is requested again in writing rather than chased by phone.',
            rationale: null,
            confirmation: 'suggested', state: 'active', origin: 'extracted',
            source_quote: 'Still blocked on the Vlinder test data — we should just put the request in writing this time.',
            source_timecode: '00:05:12',
            extracted_at: '2026-08-11T09:20:00.000Z',
        },
    ],

    tbl_mdact: [
        // ── Confirmed and owned ────────────────────────────────────────────
        {
            meeting_id: { $ref: 'mt_board' }, meeting_title: 'Board meeting — Q3 review', meeting_date: '2026-07-08',
            title: 'Write the migration plan and cost comparison',
            detail: 'Both providers, three years, including egress and the cost of the cut-over weekend.',
            owner_hint: 'Marcel Okonkwo', due_hint: 'before the next board',
            owner_name: 'Marcel Okonkwo', owner_email: 'marcel@example.com', due_date: '2026-09-04',
            status: 'doing', confirmation: 'confirmed', origin: 'extracted',
            source_quote: 'I will put together the migration plan and cost comparison. Before the next board, so you have it in writing.',
            source_timecode: '00:16:05',
            confirmed_by: 'Anke Bergsma', confirmed_at: '2026-07-09T08:16:00.000Z', extracted_at: '2026-07-08T16:40:00.000Z',
        },
        {
            meeting_id: { $ref: 'mt_board' }, meeting_title: 'Board meeting — Q3 review', meeting_date: '2026-07-08',
            title: 'Send the updated forecast to Marcel',
            detail: null,
            owner_hint: 'Sanne Rietveld', due_hint: 'end of the month',
            owner_name: 'Sanne Rietveld', owner_email: 'sanne@example.com', due_date: '2026-07-31',
            status: 'done', confirmation: 'confirmed', origin: 'extracted',
            source_quote: 'Sanne, can you get the updated forecast to me by the end of the month? I need it for the plan.',
            source_timecode: '00:31:12',
            confirmed_by: 'Anke Bergsma', confirmed_at: '2026-07-09T08:17:00.000Z',
            completed_at: '2026-07-30T15:22:00.000Z', extracted_at: '2026-07-08T16:40:00.000Z',
        },
        {
            meeting_id: { $ref: 'mt_client' }, meeting_title: 'Kick-off — Vlinder Zorggroep migration', meeting_date: '2026-07-15',
            title: 'Get the data-processing agreement countersigned',
            detail: 'Their legal team has the draft; the annex listing sub-processors is the open point.',
            owner_hint: 'Marcel Okonkwo', due_hint: 'before we touch any real data',
            owner_name: 'Marcel Okonkwo', owner_email: 'marcel@example.com', due_date: '2026-08-29',
            status: 'waiting', confirmation: 'confirmed', origin: 'extracted',
            source_quote: 'Nothing real goes near our systems until the processing agreement is signed on both sides.',
            source_timecode: '00:27:53',
            confirmed_by: 'Marcel Okonkwo', confirmed_at: '2026-07-16T09:32:00.000Z', extracted_at: '2026-07-15T18:02:00.000Z',
        },
        {
            // Written in by hand from the typed notes — no model involved, which
            // is why it has no hints and no extracted_at.
            meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up', meeting_date: '2026-08-11',
            title: 'Write the Vlinder migration runbook',
            detail: 'Step by step, including the rollback, so somebody else could run it.',
            owner_name: 'Iris Bouwman', owner_email: 'iris@example.com', due_date: '2026-08-21',
            status: 'doing', confirmation: 'confirmed', origin: 'manual',
            confirmed_by: 'Tomas Havel', confirmed_at: '2026-08-11T09:35:00.000Z',
        },
        {
            meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up', meeting_date: '2026-08-11',
            title: 'Measure reranker latency under load on dev',
            detail: null,
            owner_name: 'Tomas Havel', owner_email: 'tomas@example.com', due_date: '2026-08-18',
            status: 'open', confirmation: 'confirmed', origin: 'manual',
            confirmed_by: 'Tomas Havel', confirmed_at: '2026-08-11T09:36:00.000Z',
        },

        // ── Suggested. No owner, no due date, no confirmed_by — a hint only. ──
        {
            meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up', meeting_date: '2026-08-11',
            title: 'Put the Vlinder test-data request in writing',
            detail: 'Chasing it by phone has not worked twice now.',
            owner_hint: 'Iris Bouwman', due_hint: 'this week',
            status: 'open', confirmation: 'suggested', origin: 'extracted',
            source_quote: 'Still blocked on the Vlinder test data, chasing their side.',
            source_timecode: '00:05:12',
            extracted_at: '2026-08-11T09:20:00.000Z',
        },
        {
            // The dangerous one, and exactly why the app exists: the transcript
            // names nobody, so the model leaves the hint empty and a person has
            // to decide. Left to itself a model would have picked whoever spoke.
            meeting_id: { $ref: 'mt_stand' }, meeting_title: 'Platform stand-up', meeting_date: '2026-08-11',
            title: 'Book a slot with Vlinder for the cut-over weekend',
            detail: null,
            due_hint: 'before the end of September',
            status: 'open', confirmation: 'suggested', origin: 'extracted',
            source_quote: 'Somebody needs to get a weekend in their calendar for the cut-over, well before the end of September.',
            source_timecode: '00:07:48',
            extracted_at: '2026-08-11T09:20:00.000Z',
        },
        {
            meeting_id: { $ref: 'mt_board' }, meeting_title: 'Board meeting — Q3 review', meeting_date: '2026-07-08',
            title: 'Circulate the Q3 numbers to the wider management team',
            detail: null,
            owner_hint: 'Sanne Rietveld', due_hint: 'next week',
            status: 'open', confirmation: 'suggested', origin: 'extracted',
            source_quote: 'The rest of the management team should see these numbers too, not just us.',
            source_timecode: '00:08:19',
            extracted_at: '2026-07-08T16:40:00.000Z',
        },

        // ── Proposed and rejected. Kept, because that is a record too. ──────
        {
            meeting_id: { $ref: 'mt_board' }, meeting_title: 'Board meeting — Q3 review', meeting_date: '2026-07-08',
            title: 'Cancel the annual offsite',
            detail: null,
            owner_hint: 'Anke Bergsma', due_hint: 'immediately',
            status: 'open', confirmation: 'discarded', origin: 'extracted',
            source_quote: 'We could always cancel the offsite, though I would rather not.',
            source_timecode: '00:26:40',
            extracted_at: '2026-07-08T16:40:00.000Z',
        },
    ],
};

module.exports = {
    id: 'app-meeting-dossier',
    version: 1,
    title: 'Meeting dossier',
    description: 'Recording to decisions and actions, with a person in between. Self-hosted transcription with speaker separation, AI that reads a transcript into suggestions, and a review step where a human owns them — plus a decision log that outlives the meeting and a retention date on every recording.',
    category: 'Data',
    icon: 'MessageSquareQuote',
    tags: ['meetings', 'minutes', 'decisions', 'actions', 'transcription', 'whisperx', 'retention', 'gdpr'],
    definition,
    dataModel,
    seed,
};
