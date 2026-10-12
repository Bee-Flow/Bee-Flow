/**
 * App Studio template — Data subject requests (GDPR Articles 15 to 22).
 *
 * Somebody asks what you hold about them, or asks for it corrected, deleted,
 * restricted, ported, or objects to what you do with it. You have ONE MONTH to
 * answer (Art. 12(3)), extendable by two more months but only if you tell them
 * why, in time. This app is the register, the clock and the evidence trail:
 * what was asked, how you proved it was really them, where you looked, what you
 * sent, and what you withheld on what ground.
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS ────────────────────────────────
 *
 * THE DEADLINE IS A STORED COLUMN, NOT A CALCULATION.
 *
 * A binding filter may read only currentUser / vars / forms / screen / today —
 * it cannot subtract two columns, so "days remaining" is not expressible where
 * it would need to be: in the query that decides which requests are shown, and
 * in the sort that decides which one you see first. So `due_date` is a real
 * date column, written once at intake (received + 30 days) and rewritten when an
 * extension is taken. Every urgency question then becomes a plain comparison
 * against `today`, which a filter CAN do:
 *
 *     overdue   due_date <  today
 *     due soon  due_date <= today + 7 days   (formatDate(dateAdd(today, 7, 'day')))
 *
 * and `sort: due_date asc` puts the request you are closest to failing at the
 * top of the first screen. Nothing else in the app has to know what day it is.
 *
 * The honest caveat, and it is in the UI too: the statute says one calendar
 * MONTH, and the expression language has no month unit (day/week only). The app
 * writes received + 30 days as the safe default — never later than a calendar
 * month — and `due_date` stays editable inline on the register so a handler can
 * set the exact statutory date. Erring early is a choice; erring late is a
 * breach.
 *
 * ── CONSTRAINTS THAT SHAPED THIS FILE (none of them obvious) ────────────────
 *
 *  • NO JOINS. Every read compiles to `FROM <one table>`; a filter or sort may
 *    only name that table's own columns. So every child row (an identity check,
 *    a search, a disclosure, a withholding) carries a DENORMALISED
 *    `request_reference` text copy alongside its `request_id` relation. The
 *    relation is the truth; the copy is what makes the org-wide search log
 *    readable without following it.
 *
 *  • A SERVER STEP sees form, vars, item, value, currentUser, now, today — and
 *    NOT screen, forms, actions, records or datasets. Nothing here reads
 *    `screen.params`: it resolves in preview and writes NULL in production.
 *    Context reaches a write through `form` (the submitted payload) or `vars`
 *    (set by an earlier client step).
 *
 *  • AN OPTIONAL FILTER whose formula resolves to null is OMITTED ENTIRELY.
 *    That single rule is what makes the register work on first open: with no
 *    filter chosen, every clause drops out and you see the whole register. The
 *    case file uses the opposite half — required:true — so with no request
 *    selected it shows NOTHING rather than every identity check in the
 *    organisation.
 *
 *  • A height:'fill' SECTION stretches its FIRST grid row only, so every screen
 *    here is one auto-height header section plus one fill section whose
 *    children add up to a single 12-column row.
 *
 *  • `filter_bar` publishes to one hardcoded variable, `vars.filters`, which is
 *    reserved and must not be declared.
 *
 *  • An aggregate binding with no explicit `limit` is silently capped at 50.
 *
 *  • AN AGGREGATE BINDING RESOLVES TO THE ROWS ARRAY, never to a number:
 *    `count(*) as n` comes back as `[{ n: 7 }]`, which a stat tile renders as
 *    "1 item". Every scalar tile therefore carries `pick: { row, column }`
 *    naming its own aggregate alias. The charts do not: they want the rows.
 *
 * ── WHY THE KNOWLEDGE-BASE SEARCH DEGRADES INSTEAD OF FAILING ───────────────
 *
 * The part organisations actually fail is not the answer, it is proving they
 * looked. So the Searches tab carries a `kb_query` step: give it the requester's
 * identifiers and it searches the organisation's knowledge bases and writes what
 * came back into the search log, attributed and timestamped, flagged
 * `is_automated` so a reader can tell machine diligence from human diligence.
 *
 * A fresh install has NO knowledge bases, and `knowledgeBaseIds` is an
 * author-time list, not a binding — it cannot be filled in from inside the
 * running app. It therefore ships EMPTY, and the whole app is built to be
 * complete without it: every search can be logged by hand, and the button is
 * guarded so it explains itself instead of throwing. The Searches tab says in
 * plain words what wiring it up buys you and where to do it.
 *
 * ── WHAT THIS TEMPLATE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * No automatic status machine. A request does not become "searching" because a
 * search was logged — a handler moving it is a decision someone made, and an
 * accountability record whose transitions were inferred is worth less than one
 * whose transitions were chosen.
 *
 * No automation (`run_automation`) for deadline reminders. It would install
 * unwired, and a button that cannot succeed until someone configures it is
 * worse than no button: the clock is on the first screen instead, where it is
 * true without anyone wiring anything.
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
// This app holds, by construction, the personal data of people who asked what
// you hold about them — plus the reasoning behind every refusal. So the access
// matrix is the deliberate part, not boilerplate.
//
// `default:'role'` inverts the default to deny, so each grant below is a
// decision rather than an oversight, and `roleMapping.default` is NULL: opening
// the app grants nothing at all until the privacy officer gives someone a role.
// The owner is never listed — resolveScope short-circuits them to full access.
// ---------------------------------------------------------------------------

/**
 * Types, statuses and exemption grounds: the vocabulary the register is kept
 * in. The privacy officer's to change; a handler reads it and works within it.
 */
const ACCESS_VOCAB = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'all', delete: 'all' },
        handler: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * The requests themselves. Handlers create and update ALL of them — a register
 * where you cannot pick up a colleague's case while they are on leave is a
 * register that misses deadlines. NOBODY deletes: a logged request is the proof
 * that it was answered, and erasing it is exactly what an auditor asks about.
 * Not even the DPO, who can close and annotate instead.
 */
const ACCESS_REQUESTS = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'all', delete: false },
        handler: { read: 'all', create: true, update: 'all', delete: false },
    },
};

/**
 * The evidence trail — identity checks, searches, disclosures, withholdings.
 * Append-only in spirit: you may correct your own entry (a typo in a system
 * name), never anyone else's, and nobody removes one. An evidence trail with a
 * delete button is a story, not evidence.
 */
const ACCESS_EVIDENCE = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'own', delete: false },
        handler: { read: 'all', create: true, update: 'own', delete: false },
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

/** Where the stage sits in the life of a request — used for colour and rollup. */
const STAGE_OPTIONS = [
    { value: 'open', label: 'Open' },
    { value: 'waiting', label: 'Waiting on the requester' },
    { value: 'closed', label: 'Closed' },
];

const CHANNEL_OPTIONS = [
    { value: 'email', label: 'E-mail' },
    { value: 'webform', label: 'Web form' },
    { value: 'post', label: 'Letter' },
    { value: 'phone', label: 'Telephone' },
    { value: 'in_person', label: 'In person' },
];

/**
 * The outcome is a `select`, not a config table: these five are the complete
 * set of ways a request under Articles 15–22 can end, and they come from the
 * Regulation rather than from how one organisation likes to work. A refusal is
 * a legitimate outcome and sits here as a first-class value — not as "closed
 * without doing anything".
 */
const OUTCOME_OPTIONS = [
    { value: 'pending', label: 'Not decided yet' },
    { value: 'fulfilled', label: 'Fulfilled' },
    { value: 'partial', label: 'Partially fulfilled' },
    { value: 'refused', label: 'Refused' },
    { value: 'withdrawn', label: 'Withdrawn by the requester' },
];

const ID_METHOD_OPTIONS = [
    { value: 'account_login', label: 'Signed in to the known account' },
    { value: 'id_document', label: 'Identity document (redacted copy)' },
    { value: 'known_address', label: 'Reply to the address already on file' },
    { value: 'in_person', label: 'In person, with identification' },
    { value: 'employer', label: 'Confirmed by the employer (staff request)' },
    { value: 'other', label: 'Other — see the notes' },
];

const ID_OUTCOME_OPTIONS = [
    { value: 'verified', label: 'Verified' },
    { value: 'more_info', label: 'More information requested' },
    { value: 'failed', label: 'Could not be verified' },
];

/** Where personal data actually lives. Deliberately broader than "systems". */
const SOURCE_OPTIONS = [
    { value: 'knowledge_base', label: 'Knowledge base' },
    { value: 'application', label: 'Business application' },
    { value: 'mailbox', label: 'Mailbox / archive' },
    { value: 'file_share', label: 'File share' },
    { value: 'paper', label: 'Paper file' },
    { value: 'backup', label: 'Backup' },
];

const DELIVERY_OPTIONS = [
    { value: 'secure_download', label: 'Secure download link' },
    { value: 'encrypted_email', label: 'Encrypted e-mail' },
    { value: 'registered_post', label: 'Registered post' },
    { value: 'in_person', label: 'Handed over in person' },
];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const dataModel = {
    modelVersion: 1,
    roles: [
        { key: 'dpo', label: 'Privacy officer (DPO)' },
        { key: 'handler', label: 'Request handler' },
    ],
    // NULL, not 'handler'. Opening the app must grant nothing: this register
    // holds other people's personal data, and an accidental viewer is a
    // notifiable incident, not an inconvenience.
    roleMapping: { default: null, byGroup: {} },
    tables: [
        // ── Vocabulary the privacy officer owns ────────────────────────────
        {
            id: 'tbl_types01',
            key: 'request_types',
            name: 'Request types',
            icon: 'Tags',
            access: ACCESS_VOCAB,
            fields: [
                // The KEY is what a request stores. Unique, because two types
                // sharing a key would merge two different rights in every
                // report the DPO ever runs.
                { id: 'fld_tykey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_tyname1', key: 'name', type: 'text', required: true, unique: false },
                // The Article, spelled out. It is what the requester cited and
                // what a supervisory authority will ask about.
                { id: 'fld_tyart01', key: 'article', type: 'text', required: false, unique: false },
                { id: 'fld_tydesc1', key: 'description', type: 'text', required: false, unique: false },
                { id: 'fld_typos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_stat001',
            key: 'request_statuses',
            name: 'Statuses',
            icon: 'ListChecks',
            access: ACCESS_VOCAB,
            fields: [
                { id: 'fld_stkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_stname1', key: 'name', type: 'text', required: true, unique: false },
                {
                    id: 'fld_ststg01', key: 'stage', type: 'select', required: true, unique: false,
                    options: STAGE_OPTIONS, default: 'open',
                },
                {
                    id: 'fld_stcol01', key: 'color', type: 'select', required: false, unique: false,
                    options: COLOR_OPTIONS, default: 'neutral',
                },
                { id: 'fld_stpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_grnd001',
            key: 'exemption_grounds',
            name: 'Exemption grounds',
            icon: 'ShieldCheck',
            access: ACCESS_VOCAB,
            fields: [
                { id: 'fld_grkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_grname1', key: 'name', type: 'text', required: true, unique: false },
                // Refusing without naming the provision is refusing without a
                // reason, so this is a column and not a sentence in a note.
                { id: 'fld_grart01', key: 'legal_basis', type: 'text', required: true, unique: false },
                { id: 'fld_grdesc1', key: 'description', type: 'text', required: false, unique: false },
                { id: 'fld_grpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },

        // ── The register ───────────────────────────────────────────────────
        {
            id: 'tbl_reqs001',
            key: 'requests',
            name: 'Requests',
            icon: 'ClipboardList',
            access: ACCESS_REQUESTS,
            fields: [
                { id: 'fld_rqref001', key: 'reference', type: 'text', required: true, unique: true },
                // Keys into request_types / request_statuses. Text, not select,
                // so the vocabulary is data the privacy officer edits on Setup
                // rather than schema a developer edits in the builder.
                { id: 'fld_rqtype01', key: 'request_type', type: 'text', required: true, unique: false, default: 'access' },
                { id: 'fld_rqstat01', key: 'status', type: 'text', required: true, unique: false, default: 'received' },
                { id: 'fld_rqname01', key: 'requester_name', type: 'text', required: true, unique: false },
                { id: 'fld_rqmail01', key: 'requester_email', type: 'text', required: false, unique: false },
                // The values you actually have to search on: an account name, a
                // customer number, an old address. This is what the knowledge
                // base search is handed, and what a handler pastes into every
                // other system.
                { id: 'fld_rqidn001', key: 'identifiers', type: 'text', required: false, unique: false },
                {
                    id: 'fld_rqchan01', key: 'channel', type: 'select', required: false, unique: false,
                    options: CHANNEL_OPTIONS, default: 'email',
                },
                { id: 'fld_rqsumm01', key: 'summary', type: 'richtext', required: false, unique: false },
                // THE CLOCK. received_date is the day it arrived — the day the
                // month starts running, whatever day you noticed it.
                { id: 'fld_rqrecd01', key: 'received_date', type: 'date', required: true, unique: false },
                // …and the day it is due, stored rather than derived. See the
                // module header: this column is the entire deadline design.
                { id: 'fld_rqdue001', key: 'due_date', type: 'date', required: true, unique: false },
                // An extension is only lawful if the requester was TOLD, with
                // reasons, inside the first month — so the date you told them is
                // a column of its own, not a sentence in the reason.
                { id: 'fld_rqext001', key: 'extension_taken', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_rqextr01', key: 'extension_reason', type: 'text', required: false, unique: false },
                { id: 'fld_rqextn01', key: 'extension_notified_on', type: 'date', required: false, unique: false },
                // A denormalised roll-up of the identity checks below: the
                // register and its counters must be able to show "not yet
                // verified" without following a relation they cannot follow.
                { id: 'fld_rqidok01', key: 'identity_verified', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_rqidon01', key: 'verified_on', type: 'date', required: false, unique: false },
                {
                    id: 'fld_rqout001', key: 'outcome', type: 'select', required: false, unique: false,
                    options: OUTCOME_OPTIONS, default: 'pending',
                },
                // A refusal without a recorded ground is the failure mode this
                // whole app exists to prevent, so the ground and the words the
                // requester was given both live on the request itself.
                { id: 'fld_rqrgnd01', key: 'refusal_ground', type: 'text', required: false, unique: false },
                { id: 'fld_rqrexp01', key: 'refusal_explanation', type: 'text', required: false, unique: false },
                { id: 'fld_rqclos01', key: 'closed_on', type: 'date', required: false, unique: false },
                { id: 'fld_rqhand01', key: 'handler_name', type: 'text', required: false, unique: false },
            ],
        },

        // ── The evidence trail ─────────────────────────────────────────────
        {
            id: 'tbl_ident01',
            key: 'identity_checks',
            name: 'Identity checks',
            icon: 'UserCheck',
            access: ACCESS_EVIDENCE,
            fields: [
                { id: 'fld_idreq001', key: 'request_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_reqs001' } },
                // Display copy of the parent's reference — there are no joins,
                // so without it an org-wide list of checks cannot say which
                // request each one belongs to.
                { id: 'fld_idref001', key: 'request_reference', type: 'text', required: false, unique: false },
                {
                    id: 'fld_idmeth01', key: 'method', type: 'select', required: true, unique: false,
                    options: ID_METHOD_OPTIONS, default: 'account_login',
                },
                {
                    id: 'fld_idout001', key: 'outcome', type: 'select', required: true, unique: false,
                    options: ID_OUTCOME_OPTIONS, default: 'verified',
                },
                { id: 'fld_idon0001', key: 'checked_on', type: 'date', required: true, unique: false },
                { id: 'fld_idwho001', key: 'checked_by', type: 'text', required: false, unique: false },
                // A failed check has to say WHY, because the refusal that
                // follows it stands or falls on this sentence.
                { id: 'fld_idnote01', key: 'notes', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_srch001',
            key: 'search_log',
            name: 'Search log',
            icon: 'Search',
            access: ACCESS_EVIDENCE,
            fields: [
                { id: 'fld_slreq001', key: 'request_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_reqs001' } },
                { id: 'fld_slref001', key: 'request_reference', type: 'text', required: false, unique: false },
                { id: 'fld_slsys001', key: 'system_name', type: 'text', required: true, unique: false },
                {
                    id: 'fld_slsrc001', key: 'source_type', type: 'select', required: true, unique: false,
                    options: SOURCE_OPTIONS, default: 'application',
                },
                { id: 'fld_slon0001', key: 'searched_on', type: 'date', required: true, unique: false },
                { id: 'fld_slwho001', key: 'searched_by', type: 'text', required: false, unique: false },
                // The exact terms. "We searched the CRM" proves nothing; "we
                // searched the CRM for k.voorbeeld@example.com and 88214" is
                // something an auditor can repeat.
                { id: 'fld_slqry001', key: 'query_used', type: 'text', required: false, unique: false },
                { id: 'fld_slhits01', key: 'hits_found', type: 'number', subtype: 'integer', required: false, unique: false, default: 0 },
                { id: 'fld_slfind01', key: 'findings', type: 'text', required: false, unique: false },
                // Written by the knowledge-base search step, so a reader can
                // tell machine diligence from human diligence at a glance.
                { id: 'fld_slauto01', key: 'is_automated', type: 'bool', required: false, unique: false, default: false },
            ],
        },
        {
            id: 'tbl_disc001',
            key: 'disclosures',
            name: 'Disclosures',
            icon: 'Mail',
            access: ACCESS_EVIDENCE,
            fields: [
                { id: 'fld_dsreq001', key: 'request_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_reqs001' } },
                { id: 'fld_dsref001', key: 'request_reference', type: 'text', required: false, unique: false },
                { id: 'fld_dson0001', key: 'sent_on', type: 'date', required: true, unique: false },
                {
                    id: 'fld_dschan01', key: 'delivery', type: 'select', required: true, unique: false,
                    options: DELIVERY_OPTIONS, default: 'secure_download',
                },
                { id: 'fld_dscont01', key: 'contents', type: 'text', required: true, unique: false },
                // Article 20 wants a structured, commonly used, machine-readable
                // format. Whether you actually gave one is a fact about the
                // disclosure, so it is a column and not a hope.
                { id: 'fld_dsmach01', key: 'machine_readable', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_dswho001', key: 'sent_by', type: 'text', required: false, unique: false },
                { id: 'fld_dsconf01', key: 'receipt_confirmed', type: 'bool', required: false, unique: false, default: false },
            ],
        },
        {
            id: 'tbl_exem001',
            key: 'exemptions',
            name: 'Withheld',
            icon: 'Scissors',
            access: ACCESS_EVIDENCE,
            fields: [
                { id: 'fld_exreq001', key: 'request_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_reqs001' } },
                { id: 'fld_exref001', key: 'request_reference', type: 'text', required: false, unique: false },
                // Key into exemption_grounds — the same config-as-data story as
                // types and statuses.
                { id: 'fld_exgrnd01', key: 'ground', type: 'text', required: true, unique: false },
                { id: 'fld_exwhat01', key: 'what_withheld', type: 'text', required: true, unique: false },
                { id: 'fld_exon0001', key: 'decided_on', type: 'date', required: true, unique: false },
                { id: 'fld_exwho001', key: 'decided_by', type: 'text', required: false, unique: false },
                { id: 'fld_exnote01', key: 'notes', type: 'text', required: false, unique: false },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Shared vocabularies for the SCREENS.
//
// The seam in the config-as-data story: `filter_bar.options`, `input_select.
// options` and `stepper.steps` are author-time lists, not bindings. A type or a
// status added on Setup is stored, filtered, sorted and reported on correctly —
// but it will not appear in these dropdowns until an editor adds it. That is a
// platform limit rather than a modelling choice, and the Setup screen says so
// out loud so nobody discovers it by surprise.
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = [
    { value: 'access', label: 'Access (Art. 15)' },
    { value: 'rectification', label: 'Rectification (Art. 16)' },
    { value: 'erasure', label: 'Erasure (Art. 17)' },
    { value: 'restriction', label: 'Restriction (Art. 18)' },
    { value: 'portability', label: 'Portability (Art. 20)' },
    { value: 'objection', label: 'Objection (Art. 21)' },
];

const STATUS_OPTIONS = [
    { value: 'received', label: 'Received' },
    { value: 'verifying', label: 'Verifying identity' },
    { value: 'searching', label: 'Searching systems' },
    { value: 'preparing', label: 'Preparing the answer' },
    { value: 'closed', label: 'Closed' },
];

const GROUND_OPTIONS = [
    { value: 'third_party', label: 'Rights of others (Art. 15(4))' },
    { value: 'legal_privilege', label: 'Legal professional privilege' },
    { value: 'legal_retention', label: 'Retention required by law (Art. 17(3)(b))' },
    { value: 'excessive', label: 'Manifestly unfounded or excessive (Art. 12(5))' },
    { value: 'identity_unproven', label: 'Identity not established (Art. 12(6))' },
    { value: 'trade_secret', label: 'Trade secret / intellectual property' },
];

const STATUS_TONES = [
    { value: 'received', label: 'Received', tone: 'info' },
    { value: 'verifying', label: 'Verifying identity', tone: 'warning' },
    { value: 'searching', label: 'Searching systems', tone: 'primary' },
    { value: 'preparing', label: 'Preparing the answer', tone: 'primary' },
    { value: 'closed', label: 'Closed', tone: 'neutral' },
];

/**
 * The stages, in order, for the case file's stepper. Same keys as the status
 * table — the stepper says WHERE a request is, which a dropdown never does.
 */
const STATUS_STEPS = [
    { value: 'received', label: 'Received', icon: 'Inbox' },
    { value: 'verifying', label: 'Identity', icon: 'ShieldCheck' },
    { value: 'searching', label: 'Searching', icon: 'Search' },
    { value: 'preparing', label: 'Preparing', icon: 'FileText' },
    { value: 'closed', label: 'Closed', icon: 'CheckCircle2' },
];

/** Today + n days, as a plain ISO date a date column can be compared against. */
const inDays = (n) => ({ kind: 'formula', expr: `formatDate(dateAdd(today, ${n}, 'day'), 'YYYY-MM-DD')` });

/** Every child row of the open request. required:true — see the header. */
const forOpenRequest = (tableId, sort, limit) => ({
    kind: 'records',
    tableId,
    filter: [{ field: 'request_id', op: 'eq', value: { kind: 'formula', expr: 'vars.request.id' }, required: true }],
    sort,
    limit,
});

// ==================================================================
// REGISTER — the clock. What a handler opens in the morning.
// ==================================================================
const SCREEN_REGISTER = {
    id: 'scr_register',
    name: 'Register',
    icon: 'CalendarClock',
    showInNav: true,
    maxWidth: 'full',
    description: 'Every request, most urgent first.',
    sections: [
        {
            id: 'sec_rgtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rghdr',
                    type: 'page_header',
                    props: {
                        title: 'Data subject requests',
                        subtitle: 'One month from the day it arrived (Art. 12(3)). Sorted by the day you run out of time.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'CalendarClock',
                        showDivider: false,
                        // The register opens on a soft primary band — the one
                        // screen the DPO lives in gets the app's face.
                        look: 'banner',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_rgnew',
                            type: 'button',
                            props: { label: 'Log a request', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_rgnew',
                        },
                    ],
                },
                {
                    id: 'cmp_rgs1',
                    type: 'stat',
                    props: {
                        label: 'Open',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'status', op: 'neq', value: 'closed' }],
                            limit: 1,
                            // A scalar tile: an aggregate binding resolves to the ROWS array, so
                            // `pick` is what narrows it to the one number this stat shows.
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'requests still running',
                        look: 'tinted',
                        icon: 'Inbox',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_rgs2',
                    type: 'stat',
                    props: {
                        label: 'Overdue',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            // The whole deadline design in one clause: a stored
                            // date compared against `today`, which is the only
                            // clock a filter formula may read.
                            filter: [
                                { field: 'status', op: 'neq', value: 'closed' },
                                { field: 'due_date', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                            ],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'past the statutory deadline',
                        look: 'tinted',
                        icon: 'AlertTriangle',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_rgs3',
                    type: 'stat',
                    props: {
                        label: 'Due within 7 days',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'status', op: 'neq', value: 'closed' },
                                { field: 'due_date', op: 'gte', value: { kind: 'formula', expr: 'today' } },
                                { field: 'due_date', op: 'lte', value: inDays(7) },
                            ],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'answer or extend now',
                        look: 'tinted',
                        icon: 'Timer',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3, color: 'warning' },
                    visible: true,
                },
                {
                    id: 'cmp_rgs4',
                    type: 'stat',
                    props: {
                        label: 'Identity unverified',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'status', op: 'neq', value: 'closed' },
                                { field: 'identity_verified', op: 'eq', value: false },
                            ],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'nothing may be disclosed yet',
                        look: 'tinted',
                        icon: 'ShieldCheck',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_rgnote',
                    type: 'callout',
                    props: {
                        title: 'How the clock works here',
                        text: 'The due date is stored on each request, not calculated when you look at it. Logging a request sets it to the day it arrived plus 30 days — never later than the statutory month. Taking an extension adds two months and records the reason and the day you told the requester, which is what makes the extension lawful. The due date stays editable in the grid, so you can set the exact calendar date.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
                {
                    id: 'cmp_rgfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Requester', type: 'search', options: [] },
                            { name: 'request_type', label: 'Right', type: 'select', options: TYPE_OPTIONS },
                            { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
                            { name: 'overdue', label: 'Overdue only', type: 'toggle', options: [] },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            // ONE row of children: a fill section stretches its first row only.
            id: 'sec_rgmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_rgurgent',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_reqs001',
                            filter: [
                                { field: 'status', op: 'neq', value: 'closed' },
                                // Overdue AND due-soon in one clause: everything
                                // at or before today+7. Ascending, so the top of
                                // the list is the one you are closest to failing.
                                { field: 'due_date', op: 'lte', value: inDays(7), required: true },
                            ],
                            sort: [{ field: 'due_date', dir: 'asc' }],
                            limit: 50,
                        },
                        titleKey: 'requester_name',
                        subtitleKey: 'reference',
                        metaKey: 'due_date',
                        timestampKey: null,
                        badgeKey: 'status',
                        badgeToneMap: STATUS_TONES,
                        unreadKey: null,
                        selectedWhen: 'item.id == vars.request.id',
                        icon: 'AlertTriangle',
                        emptyText: 'Nothing is due in the next week. That is the goal.',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_rgpick',
                },
                {
                    id: 'cmp_rggrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_reqs001',
                            // Every clause here is OPTIONAL, so on first open —
                            // nothing typed, nothing picked — they all drop out
                            // and this is simply the whole register.
                            filter: [
                                { field: 'requester_name', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                { field: 'request_type', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.request_type' }, required: false },
                                { field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.status' }, required: false },
                                // A toggle that is off must not filter to "due
                                // before nothing", so it resolves to null and
                                // the clause disappears entirely.
                                { field: 'due_date', op: 'lt', value: { kind: 'formula', expr: 'vars.filters.overdue ? today : null' }, required: false },
                            ],
                            sort: [{ field: 'due_date', dir: 'asc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'reference', label: 'Reference', format: 'text', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'request_type', label: 'Right', format: 'badge', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'requester_name', label: 'Requester', format: 'text', width: 180, sortable: true, filterable: true, editable: false },
                            { key: 'received_date', label: 'Received', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                            // Editable on purpose: the statute says one calendar
                            // month and the app writes 30 days, so a handler
                            // must be able to correct it in place.
                            { key: 'due_date', label: 'Due', format: 'date', width: 110, sortable: true, filterable: false, editable: true },
                            { key: 'status', label: 'Status', format: 'badge', width: 150, sortable: true, filterable: true, editable: true },
                            { key: 'identity_verified', label: 'ID checked', format: 'boolean', width: 100, sortable: true, filterable: true, editable: false },
                            { key: 'outcome', label: 'Outcome', format: 'badge', width: 140, sortable: true, filterable: true, editable: true },
                            { key: 'handler_name', label: 'Handler', format: 'text', width: 150, sortable: true, filterable: true, editable: true },
                        ],
                        pageSize: 25,
                        // 'none' is what makes an inline cell edit arrive on
                        // onRowSelect as the EDITED ROW; with selection on it
                        // would arrive as { selected: rows } instead.
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Open the case file', actionId: 'act_rgpick' }],
                        density: 'compact',
                        zebra: true,
                        look: 'striped',
                        emptyText: 'No requests yet. Log the first one.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_rgsave',
                },
            ],
        },
    ],
};

// ==================================================================
// INTAKE — the clock starts here, so this screen is deliberately short.
// ==================================================================
const SCREEN_INTAKE = {
    id: 'scr_intake',
    name: 'Log a request',
    icon: 'Inbox',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Register a request the day it arrives.',
    sections: [
        {
            id: 'sec_intop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_inhdr',
                    type: 'page_header',
                    props: {
                        title: 'Log a request',
                        subtitle: 'Six fields and a date. Everything else can be filled in on the case file.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'Inbox',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_innote',
                    type: 'callout',
                    props: {
                        title: 'Received, not noticed',
                        text: 'Use the day the request ARRIVED, including one that came in by phone or reached the wrong inbox first. The month runs from then, and the due date is set from it. A request does not have to cite an Article, or the word "GDPR", to be one.',
                        tone: 'warning',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_inform',
            style: { padding: 4, gap: 3, background: 'panel' },
            children: [
                {
                    id: 'cmp_inform',
                    type: 'form',
                    props: { name: 'newrequest', submitLabel: 'Log it and start the clock', showReset: false, showSubmit: true },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_incre',
                    children: [
                        { id: 'cmp_inf1', type: 'input_text', props: { name: 'reference', label: 'Reference', placeholder: 'DSR-2026-022', required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 3 }, visible: true },
                        {
                            id: 'cmp_inf2',
                            type: 'input_select',
                            props: { name: 'request_type', label: 'Which right', required: true, options: TYPE_OPTIONS, defaultValue: 'access', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 3 },
                            visible: true,
                        },
                        {
                            id: 'cmp_inf3',
                            type: 'input_select',
                            props: { name: 'channel', label: 'How it arrived', required: false, options: CHANNEL_OPTIONS, defaultValue: 'email', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 3 },
                            visible: true,
                        },
                        // Defaults to today, which is right far more often than
                        // it is wrong — and wrong only when someone is logging a
                        // backlog, where they will notice the date staring at
                        // them.
                        { id: 'cmp_inf4', type: 'input_date', props: { name: 'received_date', label: 'Received on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 3 }, visible: true },
                        { id: 'cmp_inf5', type: 'input_text', props: { name: 'requester_name', label: 'Who asked', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                        { id: 'cmp_inf6', type: 'input_text', props: { name: 'requester_email', label: 'Reply address', placeholder: null, required: false, defaultValue: null, inputType: 'email', valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                        { id: 'cmp_inf7', type: 'input_textarea', props: { name: 'identifiers', label: 'Identifiers to search on', placeholder: 'Account name, customer number, old e-mail address, order references…', required: false, rows: 2, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                        { id: 'cmp_inf8', type: 'input_textarea', props: { name: 'summary', label: 'What exactly was asked', placeholder: 'In the requester’s own words where possible.', required: false, rows: 4, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// CASE FILE — one request, and everything that proves how it was handled.
// ==================================================================
const SCREEN_CASE = {
    id: 'scr_case',
    name: 'Case file',
    icon: 'IdCard',
    showInNav: false,
    maxWidth: 'full',
    description: 'One request: identity, searches, what was sent, what was withheld.',
    sections: [
        {
            id: 'sec_cstop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_cshdr',
                    type: 'page_header',
                    props: {
                        title: 'Case file',
                        subtitle: null,
                        titleFrom: { kind: 'formula', expr: 'vars.request.reference' },
                        subtitleFrom: { kind: 'formula', expr: 'vars.request.requester_name' },
                        icon: 'IdCard',
                        showDivider: true,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_csback',
                            type: 'button',
                            props: { label: 'Register', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' },
                            style: { span: 2 },
                            visible: true,
                            onClick: 'act_csback',
                        },
                        {
                            id: 'cmp_csext',
                            type: 'button',
                            props: { label: 'Take an extension', variant: 'secondary', iconLeft: 'CalendarClock', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_csext',
                        },
                        {
                            id: 'cmp_csref',
                            type: 'button',
                            props: { label: 'Refuse, with a ground', variant: 'danger', iconLeft: 'Scissors', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_csref',
                        },
                        {
                            id: 'cmp_csdone',
                            type: 'button',
                            props: { label: 'Close as fulfilled', variant: 'primary', iconLeft: 'CheckCircle2', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_csdone',
                        },
                    ],
                },
                {
                    // `vars.verified` mirrors the request's identity_verified
                    // column for the length of the session: picking a row seeds
                    // it from that row, and the action that writes an identity
                    // check updates it in the same breath. The column stays the
                    // persisted truth; this is what keeps the warning honest
                    // between the check and the next refetch.
                    id: 'cmp_cswarn',
                    type: 'callout',
                    props: {
                        title: 'Do not disclose anything yet',
                        text: 'This requester has not been verified. Answering the wrong person is itself a personal data breach. Record the check on the Identity tab — and if identity cannot be established, refuse under Art. 12(6) and record that as the ground, rather than letting the request go quiet.',
                        tone: 'danger',
                    },
                    style: { span: 12 },
                    visible: { kind: 'formula', expr: '!vars.verified' },
                },
                {
                    id: 'cmp_csstep',
                    type: 'stepper',
                    props: {
                        value: { kind: 'formula', expr: 'vars.request.status' },
                        steps: STATUS_STEPS,
                        orientation: 'horizontal',
                        tone: 'primary',
                        showLabels: true,
                    },
                    style: { span: 12 },
                    visible: true,
                },
                {
                    // A `record` binding rather than {kind:'formula', expr:
                    // 'vars.request'}: the picked row is a snapshot, and this
                    // one refetches after every write, so the due date shown
                    // here is the due date an extension just moved.
                    id: 'cmp_csdet',
                    type: 'record_detail',
                    props: {
                        source: {
                            kind: 'record',
                            tableId: 'tbl_reqs001',
                            filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.request.id' }, required: true }],
                            limit: 1,
                        },
                        columns: 3,
                        fields: [
                            { key: 'request_type', label: 'Right invoked', format: 'badge' },
                            { key: 'status', label: 'Status', format: 'badge' },
                            { key: 'outcome', label: 'Outcome', format: 'badge' },
                            { key: 'received_date', label: 'Received', format: 'date' },
                            { key: 'due_date', label: 'Due', format: 'date' },
                            { key: 'verified_on', label: 'Identity verified on', format: 'date' },
                            { key: 'requester_email', label: 'Reply address', format: 'text' },
                            { key: 'channel', label: 'Arrived by', format: 'badge' },
                            { key: 'handler_name', label: 'Handler', format: 'text' },
                            { key: 'identifiers', label: 'Identifiers to search on', format: 'text' },
                            { key: 'extension_reason', label: 'Extension reason', format: 'text' },
                            { key: 'extension_notified_on', label: 'Requester told of the extension', format: 'date' },
                            { key: 'refusal_ground', label: 'Refusal ground', format: 'badge' },
                            { key: 'refusal_explanation', label: 'What the requester was told', format: 'text' },
                            { key: 'summary', label: 'What was asked', format: 'markdown' },
                        ],
                        emptyText: 'Open a request from the register.',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_cstabs',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_cstabs',
                    type: 'tabs',
                    // Folder-style tabs: a case FILE gets file-drawer chrome.
                    props: { look: 'boxed' },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        // ── Identity ───────────────────────────────────────
                        {
                            id: 'cmp_cstab1',
                            type: 'tab',
                            props: { label: 'Identity', icon: 'ShieldCheck' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_idgrid',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenRequest('tbl_ident01', [{ field: 'checked_on', dir: 'desc' }], 50),
                                        columns: [
                                            { key: 'checked_on', label: 'Checked', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                                            { key: 'method', label: 'How', format: 'badge', width: 220, sortable: true, filterable: true, editable: false },
                                            { key: 'outcome', label: 'Result', format: 'badge', width: 160, sortable: true, filterable: true, editable: false },
                                            { key: 'checked_by', label: 'By', format: 'text', width: 150, sortable: true, filterable: false, editable: false },
                                            { key: 'notes', label: 'Notes', format: 'text', width: 320, sortable: false, filterable: false, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        look: 'striped',
                                        emptyText: 'No identity check recorded — nothing may be disclosed until there is one. Open a request from the register first.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_idform',
                                    type: 'form',
                                    props: { name: 'idcheck', submitLabel: 'Record the check', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_idadd',
                                    children: [
                                        {
                                            id: 'cmp_idf1',
                                            type: 'input_select',
                                            props: { name: 'method', label: 'How was identity checked', required: true, options: ID_METHOD_OPTIONS, defaultValue: 'account_login', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        {
                                            // A failed check is a first-class
                                            // outcome, not the absence of a
                                            // successful one — it is what makes
                                            // a later refusal defensible.
                                            id: 'cmp_idf2',
                                            type: 'input_select',
                                            props: { name: 'outcome', label: 'Result', required: true, options: ID_OUTCOME_OPTIONS, defaultValue: 'verified', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        { id: 'cmp_idf3', type: 'input_date', props: { name: 'checked_on', label: 'Checked on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_idf4', type: 'input_textarea', props: { name: 'notes', label: 'What was seen, and what was not kept', placeholder: 'Data minimisation: say what you looked at, and confirm the copy was destroyed.', required: false, rows: 2, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },

                        // ── Searches ───────────────────────────────────────
                        {
                            id: 'cmp_cstab2',
                            type: 'tab',
                            props: { label: 'Where we looked', icon: 'Search' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_srnote',
                                    type: 'callout',
                                    props: {
                                        title: 'Searching the knowledge bases',
                                        text: 'The button below searches this workspace’s knowledge bases for the identifiers on this request and writes what came back straight into the log — dated, attributed and marked as automated. It does nothing until an editor picks the knowledge bases in App Studio (open this app, select the "Search the knowledge bases" action, add them to its knowledge base list). Everything else works without it: log each system you searched by hand. The log is the evidence either way.',
                                        tone: 'info',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_srkb',
                                    type: 'button',
                                    props: { label: 'Search the knowledge bases', variant: 'secondary', iconLeft: 'Sparkles', role: 'button' },
                                    style: { span: 4 },
                                    visible: true,
                                    onClick: 'act_srkb',
                                },
                                {
                                    id: 'cmp_srgrid',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenRequest('tbl_srch001', [{ field: 'searched_on', dir: 'desc' }], 100),
                                        columns: [
                                            { key: 'searched_on', label: 'Date', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                                            { key: 'system_name', label: 'System', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                                            { key: 'source_type', label: 'Kind', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'query_used', label: 'Searched for', format: 'text', width: 220, sortable: false, filterable: false, editable: false },
                                            { key: 'hits_found', label: 'Hits', format: 'number', width: 80, sortable: true, filterable: false, editable: false },
                                            { key: 'findings', label: 'What was found', format: 'text', width: 320, sortable: false, filterable: false, editable: false },
                                            { key: 'is_automated', label: 'Automated', format: 'boolean', width: 100, sortable: false, filterable: true, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        look: 'striped',
                                        emptyText: 'Nothing searched yet. A request answered without a search log cannot be shown to have been answered properly.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_srform',
                                    type: 'form',
                                    props: { name: 'searchlog', submitLabel: 'Log this search', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_sradd',
                                    children: [
                                        { id: 'cmp_srf1', type: 'input_text', props: { name: 'system_name', label: 'System searched', placeholder: 'CRM, payroll, the shared mailbox…', required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                                        {
                                            id: 'cmp_srf2',
                                            type: 'input_select',
                                            props: { name: 'source_type', label: 'Kind of source', required: true, options: SOURCE_OPTIONS, defaultValue: 'application', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        { id: 'cmp_srf3', type: 'input_date', props: { name: 'searched_on', label: 'Searched on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_srf4', type: 'input_text', props: { name: 'query_used', label: 'Exactly what you searched for', placeholder: null, required: false, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 8 }, visible: true },
                                        { id: 'cmp_srf5', type: 'input_number', props: { name: 'hits_found', label: 'Hits', required: false, min: 0, max: 100000, step: 1, defaultValue: null }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_srf6', type: 'input_textarea', props: { name: 'findings', label: 'What was found (or that nothing was)', placeholder: '"Nothing" is a finding, and worth recording.', required: false, rows: 2, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },

                        // ── Disclosures ────────────────────────────────────
                        {
                            id: 'cmp_cstab3',
                            type: 'tab',
                            props: { label: 'What we sent', icon: 'Mail' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_dsgrid',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenRequest('tbl_disc001', [{ field: 'sent_on', dir: 'desc' }], 50),
                                        columns: [
                                            { key: 'sent_on', label: 'Sent', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                                            { key: 'delivery', label: 'By', format: 'badge', width: 180, sortable: true, filterable: true, editable: false },
                                            { key: 'contents', label: 'What was sent', format: 'text', width: 360, sortable: false, filterable: false, editable: false },
                                            { key: 'machine_readable', label: 'Machine-readable', format: 'boolean', width: 140, sortable: false, filterable: true, editable: false },
                                            { key: 'sent_by', label: 'By whom', format: 'text', width: 150, sortable: true, filterable: false, editable: false },
                                            { key: 'receipt_confirmed', label: 'Receipt', format: 'boolean', width: 90, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        look: 'striped',
                                        emptyText: 'Nothing disclosed yet.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_dssave',
                                },
                                {
                                    id: 'cmp_dsform',
                                    type: 'form',
                                    props: { name: 'disclosure', submitLabel: 'Record what was sent', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_dsadd',
                                    children: [
                                        {
                                            id: 'cmp_dsf1',
                                            type: 'input_select',
                                            props: { name: 'delivery', label: 'How it was delivered', required: true, options: DELIVERY_OPTIONS, defaultValue: 'secure_download', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        { id: 'cmp_dsf2', type: 'input_date', props: { name: 'sent_on', label: 'Sent on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                                        // Article 20 asks for a structured,
                                        // commonly used, machine-readable
                                        // format. A checkbox because it is a
                                        // yes/no fact someone will be asked to
                                        // stand behind.
                                        { id: 'cmp_dsf3', type: 'input_checkbox', props: { name: 'machine_readable', label: 'Structured, machine-readable format (Art. 20)', defaultChecked: false }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_dsf4', type: 'input_textarea', props: { name: 'contents', label: 'What exactly was sent', placeholder: 'The categories of data, the files, the covering letter.', required: true, rows: 3, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },

                        // ── Withheld ───────────────────────────────────────
                        {
                            id: 'cmp_cstab4',
                            type: 'tab',
                            props: { label: 'What we withheld', icon: 'Scissors' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_exnote',
                                    type: 'callout',
                                    props: {
                                        title: 'Withholding is allowed. Withholding quietly is not.',
                                        text: 'Redacting a colleague’s name out of an e-mail is an exemption like any other: name the ground, say what you took out, and be ready to explain it. A request can be fulfilled and still have withholdings against it — record them here rather than only in a refusal.',
                                        tone: 'info',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_exgrid',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenRequest('tbl_exem001', [{ field: 'decided_on', dir: 'desc' }], 50),
                                        columns: [
                                            { key: 'decided_on', label: 'Decided', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                                            { key: 'ground', label: 'Ground', format: 'badge', width: 200, sortable: true, filterable: true, editable: false },
                                            { key: 'what_withheld', label: 'What was withheld', format: 'text', width: 340, sortable: false, filterable: false, editable: false },
                                            { key: 'decided_by', label: 'By', format: 'text', width: 150, sortable: true, filterable: false, editable: false },
                                            { key: 'notes', label: 'Reasoning', format: 'text', width: 320, sortable: false, filterable: false, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        look: 'striped',
                                        emptyText: 'Nothing withheld — which is also worth being able to say.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_exform',
                                    type: 'form',
                                    props: { name: 'withheld', submitLabel: 'Record the withholding', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_exadd',
                                    children: [
                                        {
                                            id: 'cmp_exf1',
                                            type: 'input_select',
                                            props: { name: 'ground', label: 'Ground relied on', required: true, options: GROUND_OPTIONS, defaultValue: 'third_party', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                            style: { span: 6 },
                                            visible: true,
                                        },
                                        { id: 'cmp_exf2', type: 'input_date', props: { name: 'decided_on', label: 'Decided on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_exf3', type: 'input_text', props: { name: 'what_withheld', label: 'What was withheld', placeholder: 'Third-party names in the complaint thread', required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 12 }, visible: true },
                                        { id: 'cmp_exf4', type: 'input_textarea', props: { name: 'notes', label: 'Why this ground applies here', placeholder: 'The reasoning you would give a supervisory authority.', required: false, rows: 2, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_csdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_csextm',
                    type: 'modal',
                    props: { title: 'Take a two-month extension', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_extnote',
                            type: 'callout',
                            props: {
                                title: 'Only lawful if you tell them, in time',
                                text: 'Art. 12(3) allows two further months where the request is complex or you have several from the same person — but only if the requester is informed within the first month, with the reasons. The date below is the date you told them; the due date moves by two months.',
                                tone: 'warning',
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                        {
                            id: 'cmp_extform',
                            type: 'form',
                            props: { name: 'extension', submitLabel: 'Extend by two months', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_csextdo',
                            children: [
                                { id: 'cmp_extf1', type: 'input_date', props: { name: 'notified_on', label: 'Requester told on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 12 }, visible: true },
                                { id: 'cmp_extf2', type: 'input_textarea', props: { name: 'reason', label: 'Reason given to the requester', placeholder: 'Complexity, volume, several requests from the same person…', required: true, rows: 3, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_csrefm',
                    type: 'modal',
                    props: { title: 'Refuse this request', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_refnote',
                            type: 'callout',
                            props: {
                                title: 'A refusal is an answer, and it has a deadline too',
                                text: 'You must tell the requester without delay and at the latest within the month why you are not acting, and that they may complain to a supervisory authority and seek a judicial remedy (Art. 12(4)). Recording the refusal here also files it under What we withheld, so the reasoning survives the person who wrote it.',
                                tone: 'warning',
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                        {
                            id: 'cmp_refform',
                            type: 'form',
                            props: { name: 'refusal', submitLabel: 'Record the refusal', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_csrefdo',
                            children: [
                                {
                                    id: 'cmp_reff1',
                                    type: 'input_select',
                                    props: { name: 'ground', label: 'Ground for refusing', required: true, options: GROUND_OPTIONS, defaultValue: 'excessive', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                    style: { span: 6 },
                                    visible: true,
                                },
                                { id: 'cmp_reff2', type: 'input_date', props: { name: 'decided_on', label: 'Refused on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_reff3', type: 'input_textarea', props: { name: 'explanation', label: 'What the requester is being told', placeholder: 'In the words they will actually read, including their right to complain.', required: true, rows: 4, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// SEARCH LOG — the org-wide evidence of diligence.
// ==================================================================
const SCREEN_EVIDENCE = {
    id: 'scr_evidence',
    name: 'Search log',
    icon: 'Search',
    showInNav: true,
    maxWidth: 'full',
    description: 'Every system searched, for every request.',
    sections: [
        {
            id: 'sec_evtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_evhdr',
                    type: 'page_header',
                    props: {
                        title: 'Search log',
                        subtitle: 'The part organisations fail, and the part that proves they did not.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'Search',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_evs1',
                    type: 'stat',
                    props: {
                        label: 'Searches logged',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_srch001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'across every request',
                        look: 'tinted',
                        icon: 'Search',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_evs2',
                    type: 'stat',
                    props: {
                        label: 'Records found',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_srch001',
                            aggregates: [{ fn: 'sum', field: 'hits_found', as: 'hits' }],
                            limit: 1,
                            pick: { row: 'first', column: 'hits' },
                        },
                        caption: 'hits recorded in total',
                        look: 'tinted',
                        icon: 'Hash',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_evs3',
                    type: 'stat',
                    props: {
                        label: 'Searched nothing found',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_srch001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'hits_found', op: 'eq', value: 0 }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'a nil result is still evidence',
                        look: 'tinted',
                        icon: 'FileCheck',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_evs4',
                    type: 'stat',
                    props: {
                        label: 'Automated',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_srch001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'is_automated', op: 'eq', value: true }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'written by the knowledge base search',
                        look: 'tinted',
                        icon: 'Sparkles',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_evmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_evchart',
                    type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_srch001',
                            groupBy: [{ field: 'source_type', as: 'kind' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'searches' }],
                            limit: 20,
                        },
                        title: 'Where we look',
                        xKey: 'kind',
                        series: [{ key: 'searches', label: 'Searches', color: 'primary' }],
                        stacked: false,
                        showLegend: false,
                        showGrid: true,
                        valueFormat: 'number',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_evgrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_srch001',
                            sort: [{ field: 'searched_on', dir: 'desc' }],
                            limit: 300,
                        },
                        columns: [
                            // The DENORMALISED reference, not the relation:
                            // there is no join, so this column is the only way
                            // this list can say which request a search belongs
                            // to.
                            { key: 'request_reference', label: 'Request', format: 'text', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'searched_on', label: 'Date', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                            { key: 'system_name', label: 'System', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                            { key: 'source_type', label: 'Kind', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'query_used', label: 'Searched for', format: 'text', width: 220, sortable: false, filterable: false, editable: false },
                            { key: 'hits_found', label: 'Hits', format: 'number', width: 80, sortable: true, filterable: false, editable: false },
                            { key: 'searched_by', label: 'By', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'is_automated', label: 'Automated', format: 'boolean', width: 100, sortable: false, filterable: true, editable: false },
                        ],
                        pageSize: 50,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [],
                        density: 'compact',
                        zebra: true,
                        look: 'striped',
                        emptyText: 'No searches logged yet.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// REPORT — what the DPO takes to the board, or to the regulator.
// ==================================================================
const SCREEN_REPORT = {
    id: 'scr_report',
    name: 'Report',
    icon: 'BarChart3',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Volumes, outcomes and how often the deadline was met.',
    sections: [
        {
            id: 'sec_rptop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rphdr',
                    type: 'page_header',
                    props: {
                        title: 'Report',
                        subtitle: 'Accountability (Art. 5(2)) is a thing you can show, or it is not a thing.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'BarChart3',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_rps1',
                    type: 'stat',
                    props: {
                        label: 'Requests logged',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'since this register opened',
                        look: 'tinted',
                        icon: 'ClipboardList',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_rps2',
                    type: 'stat',
                    props: {
                        label: 'Refused',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'outcome', op: 'eq', value: 'refused' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'each with a recorded ground',
                        look: 'tinted',
                        icon: 'Scissors',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_rps3',
                    type: 'stat',
                    props: {
                        label: 'Extensions taken',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'extension_taken', op: 'eq', value: true }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'requester informed in each case',
                        look: 'tinted',
                        icon: 'CalendarClock',
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
            id: 'sec_rpmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_rpc1',
                    type: 'chart',
                    props: {
                        chartType: 'donut',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            groupBy: [{ field: 'outcome', as: 'outcome' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'requests' }],
                            limit: 10,
                        },
                        title: 'How requests ended',
                        xKey: 'outcome',
                        series: [{ key: 'requests', label: 'Requests', color: 'primary' }],
                        stacked: false,
                        showLegend: true,
                        showGrid: false,
                        valueFormat: 'number',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_rpc2',
                    type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            groupBy: [{ field: 'request_type', as: 'right' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'requests' }],
                            limit: 20,
                        },
                        title: 'Which right was invoked',
                        xKey: 'right',
                        series: [{ key: 'requests', label: 'Requests', color: 'info' }],
                        stacked: false,
                        showLegend: false,
                        showGrid: true,
                        valueFormat: 'number',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_rpc3',
                    type: 'chart',
                    props: {
                        chartType: 'line',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_reqs001',
                            // Bucketing by month is the one thing an aggregate
                            // can do that a filter cannot: a volume trend the
                            // DPO can put in front of a board.
                            groupBy: [{ field: 'received_date', bucket: 'month', as: 'month' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'requests' }],
                            sort: [{ field: 'month', dir: 'asc' }],
                            limit: 24,
                        },
                        title: 'Requests received per month',
                        xKey: 'month',
                        series: [{ key: 'requests', label: 'Requests', color: 'success' }],
                        stacked: false,
                        showLegend: false,
                        showGrid: true,
                        valueFormat: 'number',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// SETUP — the vocabulary the privacy officer owns.
// ==================================================================
const SCREEN_SETUP = {
    id: 'scr_setup',
    name: 'Setup',
    icon: 'TableProperties',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Request types, statuses and exemption grounds.',
    sections: [
        {
            id: 'sec_sutop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_suhdr',
                    type: 'page_header',
                    props: {
                        title: 'Setup',
                        subtitle: 'The vocabulary this register is kept in. Data, not code.',
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
                    id: 'cmp_sunote',
                    type: 'callout',
                    props: {
                        title: 'One thing to know',
                        text: 'Types, statuses and grounds are stored as keys, so adding a row here is enough for the register, the filters, the reports and the case file to use it. The dropdowns on the forms and the filter bar are fixed lists, so a value you add here is stored and reported on correctly but will not appear in those dropdowns until an editor adds it in App Studio.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_sumain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_sutabs',
                    type: 'tabs',
                    props: {},
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sutab1',
                            type: 'tab',
                            props: { label: 'Request types', icon: 'Tags' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sutypes',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_types01', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Name', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'article', label: 'Article', format: 'text', width: 120, sortable: false, filterable: false, editable: true },
                                            { key: 'description', label: 'What it means', format: 'text', width: 420, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No request types configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sutysave',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab2',
                            type: 'tab',
                            props: { label: 'Statuses', icon: 'ListChecks' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sustats',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_stat001', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Name', format: 'text', width: 220, sortable: false, filterable: false, editable: true },
                                            { key: 'stage', label: 'Counts as', format: 'badge', width: 200, sortable: true, filterable: true, editable: true },
                                            { key: 'color', label: 'Colour', format: 'badge', width: 120, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No statuses configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sustsave',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab3',
                            type: 'tab',
                            props: { label: 'Exemption grounds', icon: 'ShieldCheck' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sugrnds',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_grnd001', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 170, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Name', format: 'text', width: 260, sortable: false, filterable: false, editable: true },
                                            { key: 'legal_basis', label: 'Provision', format: 'text', width: 160, sortable: false, filterable: false, editable: true },
                                            { key: 'description', label: 'When it applies', format: 'text', width: 420, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No exemption grounds configured — a refusal would have nothing to cite.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sugrsave',
                                },
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
 * WHERE CONTEXT COMES FROM. A server step (create/update/delete_record,
 * kb_query) sees `form`, `vars`, `item`, `value`, `currentUser`, `now` and
 * `today` — and NOT `screen`, `forms`, `actions` or `records`. So every write
 * reads the submitted payload (`form.*`) or a variable an earlier client step
 * put there (`vars.request.*`). Nothing reads `screen.params`: that resolves in
 * preview and writes NULL in production.
 *
 * WHY EVERY MUTATION ENDS IN `refresh`. Nothing invalidates a bound query after
 * a write, so without it the grid keeps showing the row as it was. Each
 * `refresh` names the table it dirtied — including the SECOND table, where an
 * action writes two (recording an identity check also rolls the flag up onto
 * the request).
 *
 * WHY THE GUARDS ARE `condition` STEPS AND NOT DISABLED BUTTONS. "You may not
 * answer someone you have not identified" is a rule about the data, not about
 * the pixels. A disabled button can be worked around by another screen; a step
 * that refuses to write, and says why, cannot.
 */
const actions = {
    // ── Register ───────────────────────────────────────────────────────────

    /**
     * Open a case file. `item` is the clicked row — from the urgent list's
     * onRowClick and from the grid's row action alike, which is why one action
     * serves both.
     */
    act_rgpick: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'request', value: { kind: 'formula', expr: 'item' } },
            // Seeded from the row we just picked; kept in step by act_idadd.
            { kind: 'set_variable', name: 'verified', value: { kind: 'formula', expr: 'item.identity_verified' } },
            { kind: 'navigate', screenId: 'scr_case' },
        ],
    },

    act_rgnew: { kind: 'navigate', screenId: 'scr_intake' },

    /**
     * An inline grid edit. The grid is selectable:'none', so onRowSelect only
     * ever fires for a committed cell edit and carries the whole edited row.
     */
    act_rgsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_reqs001',
                recordId: { kind: 'formula', expr: 'form.id' },
                // Compare-and-set: refuse the write if someone else moved the
                // deadline since this grid loaded, rather than overwriting them
                // without a word. On a statutory clock that matters.
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    due_date: { kind: 'formula', expr: 'form.due_date' },
                    status: { kind: 'formula', expr: 'form.status' },
                    outcome: { kind: 'formula', expr: 'form.outcome' },
                    handler_name: { kind: 'formula', expr: 'form.handler_name' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_reqs001' },
        ],
    },

    // ── Intake ─────────────────────────────────────────────────────────────

    /**
     * Log a request and start the clock.
     *
     * `due_date` is computed HERE, once, from the date the handler typed —
     * received + 30 days, formatted back to a plain ISO date because dateAdd
     * returns a full timestamp and the column is a date. It is never recomputed
     * on read, which is the whole point: the deadline is a fact about the
     * request, not a function of when you happen to look at it.
     *
     * create_record returns only { id }, not the row, so this does NOT navigate
     * into the case file — it sends the handler back to the register, where the
     * new request is already at its right place in the queue.
     */
    act_incre: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_reqs001',
                values: {
                    reference: { kind: 'formula', expr: 'form.reference' },
                    request_type: { kind: 'formula', expr: 'form.request_type' },
                    channel: { kind: 'formula', expr: 'form.channel' },
                    requester_name: { kind: 'formula', expr: 'form.requester_name' },
                    requester_email: { kind: 'formula', expr: 'form.requester_email' },
                    identifiers: { kind: 'formula', expr: 'form.identifiers' },
                    summary: { kind: 'formula', expr: 'form.summary' },
                    received_date: { kind: 'formula', expr: 'form.received_date' },
                    due_date: { kind: 'formula', expr: "formatDate(dateAdd(form.received_date, 30, 'day'), 'YYYY-MM-DD')" },
                    status: { kind: 'static', value: 'received' },
                    outcome: { kind: 'static', value: 'pending' },
                    identity_verified: { kind: 'static', value: false },
                    // currentUser IS populated server-side, so the register
                    // records who picked it up — a Nextcloud user included.
                    handler_name: { kind: 'formula', expr: 'currentUser.name' },
                },
            },
            { kind: 'reset_form', form: 'newrequest' },
            { kind: 'refresh', tableId: 'tbl_reqs001' },
            { kind: 'toast', message: 'Logged. The month runs from the date you entered — verify identity before anything is disclosed.', tone: 'success' },
            { kind: 'navigate', screenId: 'scr_register' },
        ],
    },

    // ── Case file: identity ────────────────────────────────────────────────

    /**
     * Record an identity check — the step nobody sees until it is missing.
     *
     * Two tables move: the check itself, and the roll-up flag on the request
     * that the register and its counters read. Both are refreshed. The session
     * mirror `vars.verified` is set in the same action so the red warning at the
     * top of this screen stops lying the moment the check is recorded.
     */
    act_idadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_ident01',
                values: {
                    request_id: { kind: 'formula', expr: 'vars.request.id' },
                    // Denormalised copy — no joins, so the reference travels
                    // with the row.
                    request_reference: { kind: 'formula', expr: 'vars.request.reference' },
                    method: { kind: 'formula', expr: 'form.method' },
                    outcome: { kind: 'formula', expr: 'form.outcome' },
                    checked_on: { kind: 'formula', expr: 'form.checked_on' },
                    checked_by: { kind: 'formula', expr: 'currentUser.name' },
                    notes: { kind: 'formula', expr: 'form.notes' },
                },
            },
            {
                kind: 'condition',
                expr: "form.outcome == 'verified'",
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_reqs001',
                        recordId: { kind: 'formula', expr: 'vars.request.id' },
                        values: {
                            identity_verified: { kind: 'static', value: true },
                            verified_on: { kind: 'formula', expr: 'form.checked_on' },
                        },
                    },
                    { kind: 'set_variable', name: 'verified', value: { kind: 'static', value: true } },
                    { kind: 'toast', message: 'Identity verified. You may now disclose.', tone: 'success' },
                ],
                else: [
                    // A failed or inconclusive check UNSETS the flag. Someone
                    // whose identity has been called into question must not stay
                    // verified because an earlier check said so.
                    {
                        kind: 'update_record',
                        tableId: 'tbl_reqs001',
                        recordId: { kind: 'formula', expr: 'vars.request.id' },
                        values: {
                            identity_verified: { kind: 'static', value: false },
                            verified_on: { kind: 'static', value: null },
                        },
                    },
                    { kind: 'set_variable', name: 'verified', value: { kind: 'static', value: false } },
                    { kind: 'toast', message: 'Recorded. Do not disclose — ask for what you still need, or refuse under Art. 12(6).', tone: 'warning' },
                ],
            },
            { kind: 'reset_form', form: 'idcheck' },
            { kind: 'refresh', tableId: 'tbl_ident01' },
            { kind: 'refresh', tableId: 'tbl_reqs001' },
        ],
    },

    // ── Case file: searches ────────────────────────────────────────────────

    /**
     * THE KNOWLEDGE-BASE SEARCH.
     *
     * `knowledgeBaseIds` is an author-time list and ships EMPTY, because a fresh
     * install has no knowledge bases — an editor adds them in App Studio. Until
     * they do, the step returns nothing and the row it writes says so honestly
     * rather than claiming a search happened.
     *
     * The condition in front of it is the other half of degrading honestly: with
     * no identifiers on the request there is nothing to search FOR, and the step
     * would fail with "the search query is empty". Better to say what is
     * missing.
     *
     * `vars.kbhits` is the step's own result ({ results, count }), threaded into
     * the very next step — which is what turns a search into a log entry.
     */
    act_srkb: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'isEmpty(vars.request.identifiers)',
                then: [
                    { kind: 'toast', message: 'Add the identifiers to search on first — an account name, a customer number, an old address.', tone: 'warning' },
                ],
                else: [
                    {
                        kind: 'kb_query',
                        query: { kind: 'formula', expr: 'vars.request.identifiers' },
                        knowledgeBaseIds: [],
                        topK: 10,
                        resultVar: 'kbhits',
                    },
                    {
                        kind: 'create_record',
                        tableId: 'tbl_srch001',
                        values: {
                            request_id: { kind: 'formula', expr: 'vars.request.id' },
                            request_reference: { kind: 'formula', expr: 'vars.request.reference' },
                            system_name: { kind: 'static', value: 'Workspace knowledge bases' },
                            source_type: { kind: 'static', value: 'knowledge_base' },
                            searched_on: { kind: 'formula', expr: 'today' },
                            searched_by: { kind: 'formula', expr: 'currentUser.name' },
                            query_used: { kind: 'formula', expr: 'vars.request.identifiers' },
                            hits_found: { kind: 'formula', expr: 'number(vars.kbhits.count)' },
                            // The titles that came back, joined — enough for a
                            // reader to see WHAT was found, not just how many.
                            findings: { kind: 'formula', expr: "concat('Returned ', toStr(vars.kbhits.count), ' passage(s): ', join(vars.kbhits.results[*].title, ' · '))" },
                            is_automated: { kind: 'static', value: true },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_srch001' },
                    { kind: 'toast', message: 'Logged. Read what came back and record what you actually found — the machine looked, you decide.', tone: 'success' },
                ],
            },
        ],
    },

    act_sradd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_srch001',
                values: {
                    request_id: { kind: 'formula', expr: 'vars.request.id' },
                    request_reference: { kind: 'formula', expr: 'vars.request.reference' },
                    system_name: { kind: 'formula', expr: 'form.system_name' },
                    source_type: { kind: 'formula', expr: 'form.source_type' },
                    searched_on: { kind: 'formula', expr: 'form.searched_on' },
                    searched_by: { kind: 'formula', expr: 'currentUser.name' },
                    query_used: { kind: 'formula', expr: 'form.query_used' },
                    hits_found: { kind: 'formula', expr: 'form.hits_found' },
                    findings: { kind: 'formula', expr: 'form.findings' },
                    is_automated: { kind: 'static', value: false },
                },
            },
            { kind: 'reset_form', form: 'searchlog' },
            { kind: 'refresh', tableId: 'tbl_srch001' },
        ],
    },

    // ── Case file: disclosures ─────────────────────────────────────────────

    /**
     * The guard that matters. Disclosing to an unverified requester is a
     * personal data breach with a 72-hour notification clock of its own, so the
     * step refuses to write and says what is missing.
     */
    act_dsadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.verified',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_disc001',
                        values: {
                            request_id: { kind: 'formula', expr: 'vars.request.id' },
                            request_reference: { kind: 'formula', expr: 'vars.request.reference' },
                            sent_on: { kind: 'formula', expr: 'form.sent_on' },
                            delivery: { kind: 'formula', expr: 'form.delivery' },
                            contents: { kind: 'formula', expr: 'form.contents' },
                            machine_readable: { kind: 'formula', expr: 'form.machine_readable' },
                            sent_by: { kind: 'formula', expr: 'currentUser.name' },
                            receipt_confirmed: { kind: 'static', value: false },
                        },
                    },
                    { kind: 'reset_form', form: 'disclosure' },
                    { kind: 'toast', message: 'Recorded. Close the request as fulfilled once everything asked for has gone out.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Identity has not been verified — record the check on the Identity tab before disclosing anything.', tone: 'danger' },
                ],
            },
            { kind: 'refresh', tableId: 'tbl_disc001' },
        ],
    },

    /** Ticking "receipt confirmed" on a disclosure row — an inline cell edit. */
    act_dssave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_disc001',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: { receipt_confirmed: { kind: 'formula', expr: 'form.receipt_confirmed' } },
            },
            { kind: 'refresh', tableId: 'tbl_disc001' },
        ],
    },

    // ── Case file: withholdings ────────────────────────────────────────────

    act_exadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_exem001',
                values: {
                    request_id: { kind: 'formula', expr: 'vars.request.id' },
                    request_reference: { kind: 'formula', expr: 'vars.request.reference' },
                    ground: { kind: 'formula', expr: 'form.ground' },
                    what_withheld: { kind: 'formula', expr: 'form.what_withheld' },
                    decided_on: { kind: 'formula', expr: 'form.decided_on' },
                    decided_by: { kind: 'formula', expr: 'currentUser.name' },
                    notes: { kind: 'formula', expr: 'form.notes' },
                },
            },
            { kind: 'reset_form', form: 'withheld' },
            { kind: 'refresh', tableId: 'tbl_exem001' },
        ],
    },

    // ── Case file: the three decisions ─────────────────────────────────────

    act_csback: { kind: 'navigate', screenId: 'scr_register' },

    act_csext: { kind: 'open_modal', modalId: 'cmp_csextm' },

    /**
     * Two further months (Art. 12(3)). The new due date is computed from the
     * CURRENT one — vars.request.due_date, the row as it was picked — because
     * an extension extends the deadline you already have. 60 days rather than
     * two calendar months, for the same reason intake uses 30: early is safe,
     * late is a breach, and the column stays editable.
     */
    act_csextdo: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_reqs001',
                recordId: { kind: 'formula', expr: 'vars.request.id' },
                values: {
                    extension_taken: { kind: 'static', value: true },
                    extension_reason: { kind: 'formula', expr: 'form.reason' },
                    extension_notified_on: { kind: 'formula', expr: 'form.notified_on' },
                    due_date: { kind: 'formula', expr: "formatDate(dateAdd(vars.request.due_date, 60, 'day'), 'YYYY-MM-DD')" },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_csextm' },
            { kind: 'reset_form', form: 'extension' },
            { kind: 'refresh', tableId: 'tbl_reqs001' },
            { kind: 'toast', message: 'Extended by two months. Make sure the reason has actually reached the requester.', tone: 'success' },
        ],
    },

    act_csref: { kind: 'open_modal', modalId: 'cmp_csrefm' },

    /**
     * A refusal, recorded as carefully as a fulfilment.
     *
     * It writes BOTH tables on purpose: the request carries the ground and the
     * words the requester was given (so the register and the report can show
     * it), and a withholding row files the same decision in the evidence trail
     * next to every partial redaction — one place to look for "what did we not
     * hand over, and why".
     */
    act_csrefdo: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_reqs001',
                recordId: { kind: 'formula', expr: 'vars.request.id' },
                values: {
                    outcome: { kind: 'static', value: 'refused' },
                    status: { kind: 'static', value: 'closed' },
                    closed_on: { kind: 'formula', expr: 'form.decided_on' },
                    refusal_ground: { kind: 'formula', expr: 'form.ground' },
                    refusal_explanation: { kind: 'formula', expr: 'form.explanation' },
                },
            },
            {
                kind: 'create_record',
                tableId: 'tbl_exem001',
                values: {
                    request_id: { kind: 'formula', expr: 'vars.request.id' },
                    request_reference: { kind: 'formula', expr: 'vars.request.reference' },
                    ground: { kind: 'formula', expr: 'form.ground' },
                    what_withheld: { kind: 'static', value: 'The request was refused in full.' },
                    decided_on: { kind: 'formula', expr: 'form.decided_on' },
                    decided_by: { kind: 'formula', expr: 'currentUser.name' },
                    notes: { kind: 'formula', expr: 'form.explanation' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_csrefm' },
            { kind: 'reset_form', form: 'refusal' },
            { kind: 'refresh', tableId: 'tbl_reqs001' },
            { kind: 'refresh', tableId: 'tbl_exem001' },
            { kind: 'toast', message: 'Refusal recorded. Tell the requester the ground, and that they may complain to a supervisory authority (Art. 12(4)).', tone: 'success' },
        ],
    },

    /** Closing as fulfilled is a disclosure decision, so it is guarded too. */
    act_csdone: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.verified',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_reqs001',
                        recordId: { kind: 'formula', expr: 'vars.request.id' },
                        values: {
                            outcome: { kind: 'static', value: 'fulfilled' },
                            status: { kind: 'static', value: 'closed' },
                            closed_on: { kind: 'formula', expr: 'today' },
                        },
                    },
                    { kind: 'toast', message: 'Closed as fulfilled.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Not while identity is unverified. Verify, or refuse under Art. 12(6) and record the ground.', tone: 'danger' },
                ],
            },
            { kind: 'refresh', tableId: 'tbl_reqs001' },
        ],
    },

    // ── Setup — inline edits on the vocabulary grids ───────────────────────

    act_sutysave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_types01',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    article: { kind: 'formula', expr: 'form.article' },
                    description: { kind: 'formula', expr: 'form.description' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_types01' },
        ],
    },

    act_sustsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_stat001',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    stage: { kind: 'formula', expr: 'form.stage' },
                    color: { kind: 'formula', expr: 'form.color' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_stat001' },
        ],
    },

    act_sugrsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_grnd001',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    legal_basis: { kind: 'formula', expr: 'form.legal_basis' },
                    description: { kind: 'formula', expr: 'form.description' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_grnd001' },
        ],
    },
};

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'Data subject requests',
        description: 'Register, clock and evidence trail for GDPR Articles 15 to 22.',
        icon: 'ShieldCheck',
    },
    theme: { ...THEME_DEFAULTS, primary: '#0F766E', radius: 'sm' },
    // The paper identity in the plex face: a warm, editorial register — a back
    // office that reads like a well-set document, which is exactly what a
    // statutory register is.
    design: { preset: 'paper', font: 'plex', surface: 'hairline', motion: 'subtle', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
    nav: {
        style: 'sidebar',
        groups: [
            { id: 'nvg_requests', label: 'Requests', icon: 'Inbox', screens: ['scr_register', 'scr_intake'] },
            { id: 'nvg_account', label: 'Accountability', icon: 'ShieldCheck', screens: ['scr_evidence', 'scr_report'] },
            { id: 'nvg_admin', label: 'Admin', icon: 'TableProperties', screens: ['scr_setup'] },
        ],
    },
    roles: [
        { id: 'dpo', name: 'Privacy officer (DPO)' },
        { id: 'handler', name: 'Request handler' },
    ],
    /**
     * `filters` is NOT declared — it is reserved, and filter_bar publishes into
     * it directly.
     */
    variables: [
        { name: 'request', label: 'Open request', type: 'record', default: null, description: 'The request the case file is showing. Set by opening one from the register.' },
        { name: 'verified', label: 'Identity verified', type: 'yesno', default: false, description: 'Session mirror of the open request’s identity_verified column. Seeded when a request is opened and updated by the identity check, so the disclosure guard is right immediately.' },
        { name: 'kbhits', label: 'Knowledge base hits', type: 'any', default: null, description: 'What the knowledge base search returned: { results, count }. Written into the search log by the same action.' },
    ],
    homeScreenId: 'scr_register',
    screens: [
        SCREEN_REGISTER,
        SCREEN_INTAKE,
        SCREEN_CASE,
        SCREEN_EVIDENCE,
        SCREEN_REPORT,
        SCREEN_SETUP,
    ],
    actions,
};

// ---------------------------------------------------------------------------
// Seed
//
// A register you can read on the first screen: eight requests across all six
// rights, two of them already past their deadline, one due this week, one
// running on an extension that was properly notified, one fulfilled and one
// refused with the ground recorded — plus the evidence behind each.
//
// Every person here is fictional and every address is at example.com; the
// systems are generic categories rather than products. This is demonstration
// data in a register that would otherwise hold real people's requests, and it
// is written so nobody could mistake it for one.
//
// `$id` is a LOCAL alias, never a column; { $ref } points at a row seeded
// earlier, and templateInstall seeds parent tables first.
//
// The dates are anchored around mid-August 2026 so that "overdue" and "due this
// week" are visibly true on the register the moment the app is installed.
// due_date is always received + 30 days — the same arithmetic act_incre does —
// except where an extension was taken, which adds 60 more.
// ---------------------------------------------------------------------------

const seed = {
    tbl_types01: [
        { key: 'access', name: 'Access', article: 'Art. 15', description: 'A copy of their personal data, plus the purposes, recipients, retention and where it came from.', position: 1 },
        { key: 'rectification', name: 'Rectification', article: 'Art. 16', description: 'Correct inaccurate data, or complete data that is incomplete.', position: 2 },
        { key: 'erasure', name: 'Erasure', article: 'Art. 17', description: 'Delete the data — unless a ground in Art. 17(3) applies, such as a legal retention duty.', position: 3 },
        { key: 'restriction', name: 'Restriction', article: 'Art. 18', description: 'Keep the data but stop using it, typically while accuracy or a legitimate interest is contested.', position: 4 },
        { key: 'portability', name: 'Portability', article: 'Art. 20', description: 'Hand over the data they gave you in a structured, commonly used, machine-readable format.', position: 5 },
        { key: 'objection', name: 'Objection', article: 'Art. 21', description: 'Stop processing based on legitimate interests; for direct marketing there is no balancing test.', position: 6 },
    ],

    tbl_stat001: [
        { key: 'received', name: 'Received', stage: 'open', color: 'info', position: 1 },
        { key: 'verifying', name: 'Verifying identity', stage: 'waiting', color: 'warning', position: 2 },
        { key: 'searching', name: 'Searching systems', stage: 'open', color: 'primary', position: 3 },
        { key: 'preparing', name: 'Preparing the answer', stage: 'open', color: 'primary', position: 4 },
        { key: 'closed', name: 'Closed', stage: 'closed', color: 'neutral', position: 5 },
    ],

    tbl_grnd001: [
        { key: 'third_party', name: 'Rights and freedoms of others', legal_basis: 'Art. 15(4)', description: 'A copy may not adversely affect other people — redact third-party data rather than withholding the whole answer.', position: 1 },
        { key: 'legal_privilege', name: 'Legal professional privilege', legal_basis: 'National law', description: 'Advice covered by privilege, where national law provides the exemption.', position: 2 },
        { key: 'legal_retention', name: 'Retention required by law', legal_basis: 'Art. 17(3)(b)', description: 'Erasure refused because a legal obligation requires the data to be kept — say which one.', position: 3 },
        { key: 'excessive', name: 'Manifestly unfounded or excessive', legal_basis: 'Art. 12(5)', description: 'A high bar, and you carry the burden of showing it. Repetition alone is not enough.', position: 4 },
        { key: 'identity_unproven', name: 'Identity not established', legal_basis: 'Art. 12(6)', description: 'Reasonable doubts remain after asking for the additional information needed to confirm identity.', position: 5 },
        { key: 'trade_secret', name: 'Trade secret or intellectual property', legal_basis: 'Recital 63', description: 'Cannot be used to refuse everything — withhold the protected element, disclose the rest.', position: 6 },
    ],

    tbl_reqs001: [
        // ── Past the deadline: the two rows the register exists to shout about.
        {
            $id: 'rq018', reference: 'DSR-2026-018', request_type: 'access', status: 'searching',
            requester_name: 'Sam Example', requester_email: 'sam.example@example.com',
            identifiers: 'sam.example@example.com; customer 88214; former address on file until 2024',
            channel: 'email', received_date: '2026-07-02', due_date: '2026-08-01',
            identity_verified: true, verified_on: '2026-07-06', outcome: 'pending', handler_name: 'Robin Sample',
            summary: 'Asks for everything held about them, including call recordings and anything shared with third parties.',
        },
        {
            $id: 'rq017', reference: 'DSR-2026-017', request_type: 'erasure', status: 'verifying',
            requester_name: 'Kim Voorbeeld', requester_email: 'kim.voorbeeld@example.com',
            identifiers: 'kim.voorbeeld@example.com; newsletter subscriber id 40921',
            channel: 'webform', received_date: '2026-06-25', due_date: '2026-07-25',
            identity_verified: false, outcome: 'pending', handler_name: 'Robin Sample',
            summary: 'Wants the account and all marketing history deleted. Sent from an address that is not the one on file.',
        },

        // ── Due this week.
        {
            $id: 'rq019', reference: 'DSR-2026-019', request_type: 'portability', status: 'preparing',
            requester_name: 'Alex Fictief', requester_email: 'alex.fictief@example.com',
            identifiers: 'alex.fictief@example.com; account AF-2291',
            channel: 'email', received_date: '2026-07-20', due_date: '2026-08-19',
            identity_verified: true, verified_on: '2026-07-21', outcome: 'pending', handler_name: 'Dana Monster',
            summary: 'Moving to another provider and wants the data they supplied, machine-readable.',
        },

        // ── Comfortably inside the month.
        {
            $id: 'rq020', reference: 'DSR-2026-020', request_type: 'rectification', status: 'searching',
            requester_name: 'Chris Placeholder', requester_email: 'chris.placeholder@example.com',
            identifiers: 'chris.placeholder@example.com; invoice numbers 2025-1183 and 2025-1247',
            channel: 'post', received_date: '2026-07-28', due_date: '2026-08-27',
            identity_verified: true, verified_on: '2026-07-30', outcome: 'pending', handler_name: 'Dana Monster',
            summary: 'Date of birth and the billing address are wrong on two invoices; encloses a corrected version.',
        },
        {
            $id: 'rq021', reference: 'DSR-2026-021', request_type: 'objection', status: 'received',
            requester_name: 'Robin Steekproef', requester_email: 'robin.steekproef@example.com',
            identifiers: 'robin.steekproef@example.com',
            channel: 'phone', received_date: '2026-08-10', due_date: '2026-09-09',
            identity_verified: false, outcome: 'pending', handler_name: 'Robin Sample',
            summary: 'Telephoned to object to direct marketing. Taken down verbatim by the person who answered.',
        },

        // ── Running on a properly notified extension.
        {
            $id: 'rq016', reference: 'DSR-2026-016', request_type: 'access', status: 'preparing',
            requester_name: 'Jo Dummy', requester_email: 'jo.dummy@example.com',
            identifiers: 'jo.dummy@example.com; staff number 5512; grievance file 2025-07',
            channel: 'email', received_date: '2026-06-18', due_date: '2026-09-16',
            extension_taken: true,
            extension_reason: 'Four years of correspondence across two systems, and a grievance file that has to be redacted line by line.',
            extension_notified_on: '2026-07-10',
            identity_verified: true, verified_on: '2026-06-19', outcome: 'pending', handler_name: 'Dana Monster',
            summary: 'Former employee asking for everything, including the grievance file and the notes behind it.',
        },

        // ── Closed: one fulfilled, one refused with the ground recorded.
        {
            $id: 'rq014', reference: 'DSR-2026-014', request_type: 'access', status: 'closed',
            requester_name: 'Lee Anoniem', requester_email: 'lee.anoniem@example.com',
            identifiers: 'lee.anoniem@example.com; customer 71104',
            channel: 'webform', received_date: '2026-06-05', due_date: '2026-07-05',
            identity_verified: true, verified_on: '2026-06-08', outcome: 'fulfilled',
            closed_on: '2026-06-28', handler_name: 'Robin Sample',
            summary: 'Standard access request. Answered with a data export and the Art. 15(1) information.',
        },
        {
            $id: 'rq015', reference: 'DSR-2026-015', request_type: 'access', status: 'closed',
            requester_name: 'Max Herhaling', requester_email: 'max.herhaling@example.com',
            identifiers: 'max.herhaling@example.com',
            channel: 'email', received_date: '2026-06-11', due_date: '2026-07-11',
            identity_verified: true, verified_on: '2026-06-12', outcome: 'refused',
            refusal_ground: 'excessive',
            refusal_explanation: 'Fifth identical request in eleven weeks, each answered in full and none of the data changed in between. We explained why we consider this excessive, offered to answer again for a reasonable fee, and set out the right to complain to the supervisory authority and to a judicial remedy.',
            closed_on: '2026-06-20', handler_name: 'Dana Monster',
            summary: 'Repeat access request, identical wording to the four answered before it.',
        },
    ],

    tbl_ident01: [
        { request_id: { $ref: 'rq018' }, request_reference: 'DSR-2026-018', method: 'account_login', outcome: 'verified', checked_on: '2026-07-06', checked_by: 'Robin Sample', notes: 'Request submitted from inside the signed-in account; no document requested or kept.' },
        { request_id: { $ref: 'rq017' }, request_reference: 'DSR-2026-017', method: 'known_address', outcome: 'more_info', checked_on: '2026-06-27', checked_by: 'Robin Sample', notes: 'Sent from an address we have never seen. Wrote to the address on file asking them to confirm; no answer yet.' },
        { request_id: { $ref: 'rq019' }, request_reference: 'DSR-2026-019', method: 'account_login', outcome: 'verified', checked_on: '2026-07-21', checked_by: 'Dana Monster', notes: 'Verified through the account session.' },
        { request_id: { $ref: 'rq020' }, request_reference: 'DSR-2026-020', method: 'id_document', outcome: 'verified', checked_on: '2026-07-30', checked_by: 'Dana Monster', notes: 'Redacted copy of an identity document, viewed and destroyed the same day; photograph and document number were not retained.' },
        { request_id: { $ref: 'rq016' }, request_reference: 'DSR-2026-016', method: 'employer', outcome: 'verified', checked_on: '2026-06-19', checked_by: 'Dana Monster', notes: 'Staff number and leaving date confirmed against the HR record.' },
        { request_id: { $ref: 'rq014' }, request_reference: 'DSR-2026-014', method: 'account_login', outcome: 'verified', checked_on: '2026-06-08', checked_by: 'Robin Sample', notes: 'Verified through the account session.' },
        { request_id: { $ref: 'rq015' }, request_reference: 'DSR-2026-015', method: 'account_login', outcome: 'verified', checked_on: '2026-06-12', checked_by: 'Dana Monster', notes: 'Same account as the four earlier requests.' },
    ],

    tbl_srch001: [
        { request_id: { $ref: 'rq018' }, request_reference: 'DSR-2026-018', system_name: 'Customer application', source_type: 'application', searched_on: '2026-07-07', searched_by: 'Robin Sample', query_used: 'customer 88214', hits_found: 1, findings: 'Account record, 4 orders, 11 support contacts.', is_automated: false },
        { request_id: { $ref: 'rq018' }, request_reference: 'DSR-2026-018', system_name: 'Support mailbox archive', source_type: 'mailbox', searched_on: '2026-07-07', searched_by: 'Robin Sample', query_used: 'sam.example@example.com', hits_found: 23, findings: '23 messages across 6 threads; two mention another customer and will need redaction.', is_automated: false },
        { request_id: { $ref: 'rq018' }, request_reference: 'DSR-2026-018', system_name: 'Workspace knowledge bases', source_type: 'knowledge_base', searched_on: '2026-07-08', searched_by: 'Robin Sample', query_used: 'sam.example@example.com; customer 88214', hits_found: 2, findings: 'Returned 2 passage(s): Complaints handling procedure · Retention schedule 2026.', is_automated: true },
        { request_id: { $ref: 'rq018' }, request_reference: 'DSR-2026-018', system_name: 'Call recording store', source_type: 'application', searched_on: '2026-07-09', searched_by: 'Robin Sample', query_used: 'customer 88214', hits_found: 0, findings: 'Nothing: recordings older than 90 days are deleted, so nothing from this period survives.', is_automated: false },
        { request_id: { $ref: 'rq019' }, request_reference: 'DSR-2026-019', system_name: 'Customer application', source_type: 'application', searched_on: '2026-07-22', searched_by: 'Dana Monster', query_used: 'account AF-2291', hits_found: 1, findings: 'Profile, preferences and 38 activity rows — all of it data the requester supplied, so all of it in scope for portability.', is_automated: false },
        { request_id: { $ref: 'rq020' }, request_reference: 'DSR-2026-020', system_name: 'Billing application', source_type: 'application', searched_on: '2026-07-31', searched_by: 'Dana Monster', query_used: 'invoice 2025-1183; invoice 2025-1247', hits_found: 2, findings: 'Both invoices found; date of birth and billing address confirmed wrong on both.', is_automated: false },
        { request_id: { $ref: 'rq016' }, request_reference: 'DSR-2026-016', system_name: 'HR file share', source_type: 'file_share', searched_on: '2026-06-22', searched_by: 'Dana Monster', query_used: 'staff number 5512', hits_found: 47, findings: 'Personnel file, appraisals and the 2025-07 grievance file; the grievance file names three colleagues.', is_automated: false },
        { request_id: { $ref: 'rq016' }, request_reference: 'DSR-2026-016', system_name: 'Personnel paper archive', source_type: 'paper', searched_on: '2026-06-24', searched_by: 'Dana Monster', query_used: 'Dummy, staff number 5512', hits_found: 1, findings: 'One folder, signed contract only. Copied and returned to the archive.', is_automated: false },
        { request_id: { $ref: 'rq016' }, request_reference: 'DSR-2026-016', system_name: 'Nightly backups', source_type: 'backup', searched_on: '2026-06-24', searched_by: 'Dana Monster', query_used: 'staff number 5512', hits_found: 0, findings: 'Backups are not searchable per person and are overwritten after 35 days; recorded here so the decision not to restore them is on the file.', is_automated: false },
        { request_id: { $ref: 'rq014' }, request_reference: 'DSR-2026-014', system_name: 'Customer application', source_type: 'application', searched_on: '2026-06-09', searched_by: 'Robin Sample', query_used: 'customer 71104', hits_found: 1, findings: 'Account record and 2 orders.', is_automated: false },
        { request_id: { $ref: 'rq014' }, request_reference: 'DSR-2026-014', system_name: 'Support mailbox archive', source_type: 'mailbox', searched_on: '2026-06-09', searched_by: 'Robin Sample', query_used: 'lee.anoniem@example.com', hits_found: 4, findings: '4 messages, one thread. Nothing about anyone else.', is_automated: false },
    ],

    tbl_disc001: [
        { request_id: { $ref: 'rq014' }, request_reference: 'DSR-2026-014', sent_on: '2026-06-28', delivery: 'secure_download', contents: 'Data export (CSV), the four support messages as PDF, and the Art. 15(1) information: purposes, categories, recipients, retention periods and the source of the data.', machine_readable: true, sent_by: 'Robin Sample', receipt_confirmed: true },
        { request_id: { $ref: 'rq016' }, request_reference: 'DSR-2026-016', sent_on: '2026-07-10', delivery: 'encrypted_email', contents: 'Interim letter: the request is complex, an extension of two months is being taken, with the reasons — sent inside the first month as Art. 12(3) requires.', machine_readable: false, sent_by: 'Dana Monster', receipt_confirmed: true },
        { request_id: { $ref: 'rq015' }, request_reference: 'DSR-2026-015', sent_on: '2026-06-20', delivery: 'encrypted_email', contents: 'Refusal letter: the ground relied on, why we consider the request excessive, the offer to answer again for a reasonable fee, and the right to complain to a supervisory authority and to a judicial remedy.', machine_readable: false, sent_by: 'Dana Monster', receipt_confirmed: false },
    ],

    tbl_exem001: [
        { request_id: { $ref: 'rq015' }, request_reference: 'DSR-2026-015', ground: 'excessive', what_withheld: 'The request was refused in full.', decided_on: '2026-06-20', decided_by: 'Dana Monster', notes: 'Fifth identical request in eleven weeks with no change to the underlying data. The four earlier ones were answered in full; the decision and the reasoning were put to the requester in writing.' },
        { request_id: { $ref: 'rq016' }, request_reference: 'DSR-2026-016', ground: 'third_party', what_withheld: 'Names, contact details and verbatim statements of the three colleagues who appear in the 2025-07 grievance file.', decided_on: '2026-07-14', decided_by: 'Dana Monster', notes: 'Redacted rather than withheld wholesale: the requester gets the substance of what was said about them, without identifying who said it, none of whom consented.' },
        { request_id: { $ref: 'rq018' }, request_reference: 'DSR-2026-018', ground: 'third_party', what_withheld: 'Another customer’s name and order reference in two support threads.', decided_on: '2026-07-09', decided_by: 'Robin Sample', notes: 'Two messages were mis-threaded and mention an unrelated customer. Their details are redacted; the rest of both messages is disclosed.' },
    ],
};

module.exports = {
    id: 'app-data-subject-requests',
    version: 1,
    title: 'Data subject requests',
    description: 'Handle access, rectification, erasure, restriction, portability and objection requests (GDPR Art. 15–22) inside the statutory month. Stored due dates make overdue obvious, identity verification gates every disclosure, and the search log, disclosures and withheld-with-a-ground records are the evidence that you did it properly.',
    category: 'Data',
    icon: 'ShieldCheck',
    tags: ['gdpr', 'privacy', 'dsar', 'compliance', 'requests', 'deadlines'],
    definition,
    dataModel,
    seed,
};
