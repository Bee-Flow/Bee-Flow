/**
 * App Studio template — Data breach register (GDPR Articles 33 and 34).
 *
 * Personal data ends up somewhere it should not be, or stops being available at
 * all. From the moment you BECOME AWARE you have 72 hours to notify the
 * supervisory authority (Art. 33(1)), and where the risk to people is high you
 * must tell them too, without undue delay (Art. 34(1)). Every breach — including
 * the ones you correctly decide not to notify — has to be documented so the
 * authority can verify that you complied (Art. 33(5)).
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS ────────────────────────────────
 *
 * THE 72-HOUR DEADLINE IS THREE STORED COLUMNS, WRITTEN ONCE AT INTAKE.
 *
 * `became_aware_at` is what the reporter types. From it the intake action writes
 * `notify_due_at` (awareness + 72 hours — the exact statutory instant) and
 * `notify_due_date` (the calendar day that instant falls on). All three are
 * plain columns, because of what a query is allowed to read:
 *
 *   • A BINDING FILTER may read only currentUser / vars / forms / screen /
 *     today. It cannot read `now`, and it cannot subtract two columns. So
 *     "how long have I got" is not expressible where it has to work — in the
 *     query that decides which breaches the register shows, and in the sort
 *     that decides which one you see first.
 *   • A COMPUTED FIELD would have to be `stored:true` to be evaluated at all
 *     (a `stored:false` computed is dead metadata nothing computes), and a
 *     stored computed is emitted as raw author SQL into `GENERATED ALWAYS AS
 *     (…) STORED`. computedDialect.js translates exactly two SQLite idioms on
 *     the way to Postgres — `char(n)` and the rtrim/CAST pair — so a
 *     `datetime(became_aware_at,'+72 hours')` would reach a Postgres install
 *     verbatim and fail at CREATE TABLE. There is no expression that is valid
 *     in both dialects, and a generated column is only ever materialised when
 *     its table is CREATED, so it could never be added to a live register.
 *
 * Hence: the deadline is a FACT about the moment you became aware, stamped once,
 * by the action that records the breach. Every urgency question then becomes a
 * comparison a filter can actually make:
 *
 *     needs notifying now   notify_due_date <= today   (and nothing notified yet)
 *     sort                  notify_due_at asc          (the exact instant)
 *
 * The date copy is deliberately the deadline's calendar DAY, and the queue
 * flags a breach from the START of that day. A breach whose deadline is 16:40
 * appears in the "due now" count at 00:00, sixteen hours early. Erring early is
 * a choice; erring late is a fine.
 *
 * The exact instant is not thrown away: the breach file shows a live countdown
 * in hours, computed by a formula over `now`. That is legal there because it is
 * NOT a filter — a display formula is evaluated client-side on every render and
 * never becomes part of a fetch cache key.
 *
 * ── AND AFTERWARDS, THE PROOF ───────────────────────────────────────────────
 *
 * A register also has to show, later, that the clock WAS met. So the action that
 * records the notification stamps `authority_hours` — whole hours from awareness
 * to notification, computed from two stored timestamps at the moment it happens.
 * That single number makes "were we ever late?" a sortable column, a filter and
 * a median instead of an argument, and Art. 33(1)'s "reasons for the delay"
 * has a column of its own for the times the answer is yes.
 *
 * ── RECORDED, NOT NOTIFIABLE, IS AN OUTCOME — NOT AN OMISSION ───────────────
 *
 * A breach unlikely to result in a risk is not notified, and is still recorded
 * (Art. 33(5)). That judgement is the thing the register exists to evidence, so
 * it is a first-class value: the assessment asks WHO MUST BE TOLD as an explicit
 * choice of three, "nobody" writes `outcome = recorded_only`, and the reasoning
 * is a required field, not a note. It has its own counter on the front page.
 *
 * ── CONSTRAINTS THAT SHAPED THIS FILE (none of them obvious) ────────────────
 *
 *  • NO JOINS. Every read compiles to `FROM <one table>`; a filter or sort may
 *    only name that table's own columns. So every child row (an action-log
 *    entry, a system, a processor) carries a DENORMALISED `breach_reference`
 *    text copy beside its `breach_id` relation. The relation is the truth; the
 *    copy is what makes a cross-breach log readable without following it.
 *
 *  • A SERVER STEP sees form, vars, item, value, currentUser, now, today — and
 *    NOT screen, forms, actions, records or datasets. Nothing here reads
 *    `screen.params`: it resolves in preview and writes NULL in production.
 *
 *  • A GUARD MAY ONLY READ AN IMMUTABLE FIELD OF THE OPEN RECORD. `vars.breach`
 *    is the snapshot taken when the row was clicked, so `vars.breach.id` and
 *    `vars.breach.reference` are safe and `vars.breach.severity` is not — the
 *    user may have just changed it. Every condition here tests `.id` only, and
 *    anything that must reflect the CURRENT row (the stage stepper, the file
 *    itself) is bound to a live `record` query instead of to the snapshot.
 *
 *  • AN OPTIONAL FILTER whose formula resolves to null is OMITTED ENTIRELY.
 *    That is what makes the register useful on first open: with nothing chosen
 *    every clause drops out and you see all open breaches, most urgent first.
 *    The breach file uses the opposite half — required:true — so with nothing
 *    open it shows nothing rather than every processor in the organisation.
 *
 *  • A height:'fill' SECTION stretches its FIRST grid row only, so each screen
 *    is one auto-height header section plus one fill section whose children add
 *    up to a single 12-column row.
 *
 *  • `filter_bar` publishes to one hardcoded variable, `vars.filters`, which is
 *    reserved and must not be declared.
 *
 *  • An aggregate binding with no explicit `limit` is silently capped at 50.
 *
 * ── WHAT THIS TEMPLATE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * No routine (`run_automation`) for deadline reminders. It would install unwired
 * and a button that cannot succeed until someone configures it is worse than no
 * button — the clock is on the home screen instead, where it is true the moment
 * the app is installed.
 *
 * No multiselect for the categories of personal data affected. Every display
 * component summarises an array as "3 items" rather than listing it, so the
 * register would hide the one fact Art. 33(3)(a) asks you to state. It is a text
 * field, written in the words that have to go into the notification itself.
 *
 * No delete on the register or its log. A record that can be removed is not
 * evidence, and "why is there a gap in the references?" is the first question an
 * auditor asks. Only the supporting systems list can be corrected by deletion.
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
// Three roles, because a breach register has three genuinely different jobs.
// `default:'role'` inverts the default to deny, so every grant below is a
// decision rather than an oversight. The owner is never listed — resolveScope
// short-circuits them to full access.
//
// `roleMapping.default` is 'reporter', and that is the deliberate part: Article
// 33's clock starts when the ORGANISATION becomes aware, which in practice means
// whichever colleague noticed. Making everyone able to report — and to see only
// what they reported — is what stops the first hours being spent looking for
// who has the login.
// ---------------------------------------------------------------------------

/**
 * The register itself. Nobody deletes, not even the DPO: a logged breach is the
 * proof that it was handled, and a register with a delete button is a story.
 * A reporter may correct their own report until someone picks it up; they cannot
 * see anyone else's, because a breach record is by construction a description of
 * other people's personal data going wrong.
 */
const ACCESS_REGISTER = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'all', delete: false },
        responder: { read: 'all', create: true, update: 'all', delete: false },
        reporter: { read: 'own', create: true, update: 'own', delete: false },
    },
};

/**
 * The action log — the evidence trail. Append-only in spirit: you may fix your
 * own entry (a mistyped time), never anyone else's, and nobody removes one.
 */
const ACCESS_LOG = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'own', delete: false },
        responder: { read: 'all', create: true, update: 'own', delete: false },
        reporter: { read: 'own', create: true, update: 'own', delete: false },
    },
};

/**
 * Systems and processors touched by a breach. This one IS correctable — it is
 * working notes about infrastructure, not a statement about what happened — so
 * the people running the response may remove a line they added in error.
 */
const ACCESS_SYSTEMS = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'all', delete: 'all' },
        responder: { read: 'all', create: true, update: 'all', delete: 'own' },
        reporter: { read: 'none', create: false, update: 'none', delete: 'none' },
    },
};

/** The severity vocabulary: the DPO's to define, everyone else's to work within. */
const ACCESS_VOCAB = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'all', delete: 'all' },
        responder: { read: 'all', create: false, update: 'none', delete: 'none' },
        reporter: { read: 'all', create: false, update: 'none', delete: 'none' },
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
 * The three kinds of personal data breach the EDPB guidelines name. A real
 * incident is often two of them at once; the register records the MOST SERIOUS
 * one (confidentiality over integrity over availability) and the description
 * carries the rest. A `select` rather than a multiselect is what keeps the
 * column groupable, sortable and readable in a grid — a documented convention
 * beats a field nothing can display.
 */
const BREACH_TYPE_OPTIONS = [
    { value: 'confidentiality', label: 'Confidentiality — data seen by the wrong people' },
    { value: 'integrity', label: 'Integrity — data altered without authorisation' },
    { value: 'availability', label: 'Availability — data lost or unreachable' },
];

/** Where the response has got to. The stepper on the breach file reads this. */
const STAGE_OPTIONS = [
    { value: 'reported', label: 'Reported' },
    { value: 'assessed', label: 'Assessed' },
    { value: 'notified', label: 'Notified' },
    { value: 'closed', label: 'Closed' },
];

/**
 * How the case ended. `recorded_only` is the one that matters: a breach that was
 * correctly NOT notified is a compliant outcome under Art. 33(5), not a case
 * somebody forgot to finish, and the register has to be able to say so.
 */
const OUTCOME_OPTIONS = [
    { value: 'pending', label: 'Not decided yet' },
    { value: 'recorded_only', label: 'Recorded, not notifiable (Art. 33(5))' },
    { value: 'notified_authority', label: 'Authority notified' },
    { value: 'notified_all', label: 'Authority and data subjects notified' },
    { value: 'not_a_breach', label: 'Assessed as not a personal data breach' },
];

/** The single explicit decision the assessment exists to record. */
const NOTIFY_DECISION_OPTIONS = [
    { value: 'nobody', label: 'Nobody — unlikely to result in a risk (Art. 33(1))' },
    { value: 'authority_only', label: 'The supervisory authority (Art. 33)' },
    { value: 'authority_and_subjects', label: 'The authority AND the people affected (Art. 34)' },
];

/** Art. 34(2)/(3): individually, or by public communication when that is allowed. */
const SUBJECT_METHOD_OPTIONS = [
    { value: 'individual', label: 'Individually (e-mail, letter, in person)' },
    { value: 'public', label: 'Public communication (Art. 34(3)(c))' },
];

/** The three grounds Art. 34(3) gives for NOT telling the people affected. */
const EXEMPT_GROUND_OPTIONS = [
    { value: 'encryption', label: 'Art. 34(3)(a) — data was unintelligible (encrypted)' },
    { value: 'measures', label: 'Art. 34(3)(b) — later measures removed the high risk' },
    { value: 'disproportionate', label: 'Art. 34(3)(c) — disproportionate effort; public communication instead' },
];

/** What a log entry records. The vocabulary of an incident timeline. */
const ACTION_TYPE_OPTIONS = [
    { value: 'detected', label: 'Detected / became aware' },
    { value: 'contained', label: 'Containment measure' },
    { value: 'assessed', label: 'Risk assessed' },
    { value: 'notified_authority', label: 'Authority notified' },
    { value: 'notified_subjects', label: 'Data subjects notified' },
    { value: 'communication', label: 'Communication with a processor or third party' },
    { value: 'remediation', label: 'Remediation' },
    { value: 'note', label: 'Note' },
    { value: 'closed', label: 'Case closed' },
];

/** Who held the data. Art. 33(2) makes the processor's own clock relevant. */
const PARTY_ROLE_OPTIONS = [
    { value: 'own_system', label: 'Our own system' },
    { value: 'processor', label: 'Processor' },
    { value: 'sub_processor', label: 'Sub-processor' },
    { value: 'recipient', label: 'Third-party recipient' },
];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const dataModel = {
    modelVersion: 1,
    roles: [
        { key: 'dpo', label: 'Data protection officer' },
        { key: 'responder', label: 'Incident responder' },
        { key: 'reporter', label: 'Anyone who spots a breach' },
    ],
    roleMapping: { default: 'reporter', byGroup: {} },
    tables: [
        {
            id: 'tbl_brchs01',
            key: 'breaches',
            name: 'Breach register',
            icon: 'ShieldCheck',
            access: ACCESS_REGISTER,
            fields: [
                // Unique, because two breaches sharing a reference is exactly the
                // ambiguity an authority reference number is supposed to remove.
                { id: 'fld_brref01', key: 'reference', type: 'text', required: true, unique: true },
                { id: 'fld_brtit01', key: 'title', type: 'text', required: true, unique: false },
                { id: 'fld_brdes01', key: 'description', type: 'text', required: true, unique: false },
                {
                    id: 'fld_brtyp01', key: 'breach_type', type: 'select', required: true, unique: false,
                    options: BREACH_TYPE_OPTIONS, default: 'confidentiality',
                },
                // When it HAPPENED. Often unknown, sometimes months ago, and
                // never the start of the clock — kept apart from awareness on
                // purpose, because conflating the two is the mistake that makes
                // a register report the wrong deadline.
                { id: 'fld_brocc01', key: 'occurred_at', type: 'datetime', required: false, unique: false },
                // THE CLOCK STARTS HERE (Art. 33(1)).
                { id: 'fld_brawr01', key: 'became_aware_at', type: 'datetime', required: true, unique: false },
                // Awareness + 72 hours, stamped once by the intake action. See
                // the module header for why this is not a computed field.
                { id: 'fld_brdue01', key: 'notify_due_at', type: 'datetime', required: false, unique: false },
                // The same instant's calendar day. The ONLY form a binding filter
                // can compare, because `today` is the only clock it may read.
                { id: 'fld_brdud01', key: 'notify_due_date', type: 'date', required: false, unique: false },

                // Assessment. `severity` is a text KEY into severity_levels, not
                // a select: the tiers are the DPO's vocabulary and adding one
                // must not mean a developer editing a schema. Required with a
                // default, so a breach can never sit in the register with no
                // risk tier at all — "unassessed" is a tier, blank is a hole.
                { id: 'fld_brsev01', key: 'severity', type: 'text', required: true, unique: false, default: 'unassessed' },
                { id: 'fld_brrsk01', key: 'risk_summary', type: 'text', required: false, unique: false },
                { id: 'fld_brppl01', key: 'people_affected', type: 'number', subtype: 'integer', required: false, unique: false },
                { id: 'fld_brrec01', key: 'records_affected', type: 'number', subtype: 'integer', required: false, unique: false },
                // Art. 33(3)(a) asks for the categories in words, and words are
                // what has to go into the notification — see the header.
                { id: 'fld_brcat01', key: 'data_categories', type: 'text', required: false, unique: false },
                { id: 'fld_brspc01', key: 'special_categories', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_brasb01', key: 'assessed_by', type: 'text', required: false, unique: false },
                { id: 'fld_brasa01', key: 'assessed_at', type: 'datetime', required: false, unique: false },

                // Notification — authority. `authority_required` defaults to
                // TRUE: Art. 33(1) notifies UNLESS you can show a risk is
                // unlikely, so the register assumes the obligation until someone
                // writes down why it does not apply.
                { id: 'fld_braur01', key: 'authority_required', type: 'bool', required: false, unique: false, default: true },
                { id: 'fld_braua01', key: 'authority_notified_at', type: 'datetime', required: false, unique: false },
                // Whole hours from awareness to notification, stamped when the
                // notification is recorded. The proof, afterwards, that the
                // clock was met — and the column "were we late?" sorts on.
                { id: 'fld_brauh01', key: 'authority_hours', type: 'number', subtype: 'integer', required: false, unique: false },
                { id: 'fld_braun01', key: 'authority_reference', type: 'text', required: false, unique: false },
                // Art. 33(1): a notification later than 72 hours must be
                // accompanied by the reasons for the delay. Its own column,
                // because an obligation buried in a free-text note is not one.
                { id: 'fld_braul01', key: 'authority_late_reason', type: 'text', required: false, unique: false },

                // Notification — data subjects (Art. 34).
                { id: 'fld_brsur01', key: 'subjects_required', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_brsua01', key: 'subjects_notified_at', type: 'datetime', required: false, unique: false },
                {
                    id: 'fld_brsum01', key: 'subjects_method', type: 'select', required: false, unique: false,
                    options: SUBJECT_METHOD_OPTIONS, default: 'individual',
                },
                { id: 'fld_brsug01', key: 'subjects_exempt_ground', type: 'select', required: false, unique: false, options: EXEMPT_GROUND_OPTIONS },
                { id: 'fld_brsue01', key: 'subjects_exempt_reason', type: 'text', required: false, unique: false },

                // The response.
                { id: 'fld_brcon01', key: 'containment', type: 'text', required: false, unique: false },
                { id: 'fld_brrem01', key: 'remediation', type: 'text', required: false, unique: false },

                {
                    id: 'fld_brstg01', key: 'stage', type: 'select', required: true, unique: false,
                    options: STAGE_OPTIONS, default: 'reported',
                },
                {
                    id: 'fld_brout01', key: 'outcome', type: 'select', required: true, unique: false,
                    options: OUTCOME_OPTIONS, default: 'pending',
                },
                { id: 'fld_brrpb01', key: 'reported_by', type: 'text', required: false, unique: false },
                { id: 'fld_brcls01', key: 'closed_on', type: 'date', required: false, unique: false },
                { id: 'fld_bratt01', key: 'attachments', type: 'file', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_bacts01',
            key: 'breach_actions',
            name: 'Action log',
            icon: 'History',
            access: ACCESS_LOG,
            fields: [
                { id: 'fld_babrc01', key: 'breach_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_brchs01' } },
                // Denormalised display copy — there are no joins, so a log read
                // across breaches has to carry the reference on the row.
                { id: 'fld_baref01', key: 'breach_reference', type: 'text', required: false, unique: false },
                { id: 'fld_bawhn01', key: 'happened_at', type: 'datetime', required: true, unique: false },
                {
                    id: 'fld_batyp01', key: 'action_type', type: 'select', required: true, unique: false,
                    options: ACTION_TYPE_OPTIONS, default: 'note',
                },
                { id: 'fld_basum01', key: 'summary', type: 'text', required: true, unique: false },
                { id: 'fld_bawho01', key: 'actor_name', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_bsys001',
            key: 'breach_systems',
            name: 'Systems and processors',
            icon: 'Boxes',
            access: ACCESS_SYSTEMS,
            fields: [
                { id: 'fld_bsbrc01', key: 'breach_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_brchs01' } },
                { id: 'fld_bsref01', key: 'breach_reference', type: 'text', required: false, unique: false },
                { id: 'fld_bsnam01', key: 'name', type: 'text', required: true, unique: false },
                {
                    id: 'fld_bsrol01', key: 'party_role', type: 'select', required: true, unique: false,
                    options: PARTY_ROLE_OPTIONS, default: 'own_system',
                },
                { id: 'fld_bsdat01', key: 'data_held', type: 'text', required: false, unique: false },
                // Art. 33(2): a processor must notify the controller without
                // undue delay. When they were late, THIS is the column that
                // shows the delay was theirs — your own 72 hours still run from
                // the moment you became aware, which is this timestamp.
                { id: 'fld_bsnot01', key: 'told_us_at', type: 'datetime', required: false, unique: false },
                { id: 'fld_bscnt01', key: 'contact', type: 'text', required: false, unique: false },
                { id: 'fld_bscon01', key: 'contained', type: 'bool', required: false, unique: false, default: false },
            ],
        },
        {
            id: 'tbl_sevs001',
            key: 'severity_levels',
            name: 'Severity levels',
            icon: 'Gauge',
            access: ACCESS_VOCAB,
            fields: [
                // The KEY is what a breach stores. Unique, because two tiers
                // sharing a key would silently merge two risk levels.
                { id: 'fld_svkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_svnam01', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_svgui01', key: 'guidance', type: 'text', required: false, unique: false },
                // What the tier IMPLIES. Read by the person assessing, not by the
                // app: a server step cannot read another table, so the assessment
                // asks for the notification decision explicitly and this column
                // is the guidance it is made against.
                { id: 'fld_svaut01', key: 'notify_authority', type: 'bool', required: false, unique: false, default: true },
                { id: 'fld_svsub01', key: 'notify_subjects', type: 'bool', required: false, unique: false, default: false },
                {
                    id: 'fld_svcol01', key: 'color', type: 'select', required: false, unique: false,
                    options: COLOR_OPTIONS, default: 'neutral',
                },
                { id: 'fld_svpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Shared vocabularies for the SCREENS.
//
// These literal lists are the one seam in the config-as-data story:
// `filter_bar.options`, `data_grid.columns` and `input_select.options` are
// author-time lists, not bindings. A severity tier added on Setup is stored,
// filtered and displayed correctly everywhere, but does not appear in the
// assessment dropdown until an editor adds it there. That is a platform limit,
// not a modelling choice, and the Setup screen says so in plain words.
// ---------------------------------------------------------------------------

const SEVERITY_TONES = [
    { value: 'unassessed', label: 'Not assessed', tone: 'neutral' },
    { value: 'none', label: 'No risk', tone: 'success' },
    { value: 'low', label: 'Low risk', tone: 'info' },
    { value: 'medium', label: 'Risk', tone: 'warning' },
    { value: 'high', label: 'High risk', tone: 'danger' },
];

const SEVERITY_OPTIONS = SEVERITY_TONES.map((s) => ({ value: s.value, label: s.label }));

const STAGE_FILTER_OPTIONS = STAGE_OPTIONS.map((s) => ({ value: s.value, label: s.label }));


/**
 * THE COUNTDOWN.
 *
 * Legal here and illegal in a filter: this is a DISPLAY formula, evaluated
 * client-side on every render, so reading `now` cannot make a fetch and its
 * cache key disagree. It reads only fields that are fixed for the life of the
 * record — awareness and the stamped deadline — so the snapshot in `vars.breach`
 * cannot go stale underneath it.
 */
const CLOCK_EXPR = [
    "dateDiff(vars.breach.notify_due_at, now, 'hour') >= 0",
    " ? concat('**', toStr(dateDiff(vars.breach.notify_due_at, now, 'hour')),",
    "   ' hours left.** The Article 33 notification is due ',",
    "   formatDate(vars.breach.notify_due_at, 'DD-MM-YYYY HH:mm'), ' UTC — 72 hours after ',",
    "   formatDate(vars.breach.became_aware_at, 'DD-MM-YYYY HH:mm'), ' UTC, when we became aware.')",
    " : concat('**The 72 hours ran out ', toStr(abs(dateDiff(vars.breach.notify_due_at, now, 'hour'))),",
    "   ' hours ago** (deadline ', formatDate(vars.breach.notify_due_at, 'DD-MM-YYYY HH:mm'),",
    "   ' UTC). If the authority has not been notified yet, the notification must give the reasons for the delay (Art. 33(1)).')",
].join('');

/** Awareness + 72 hours, as written by the intake action. */
const DUE_AT_EXPR = "dateAdd(form.became_aware_at, 72, 'hour')";
const DUE_DATE_EXPR = "formatDate(dateAdd(form.became_aware_at, 72, 'hour'), 'YYYY-MM-DD')";

/**
 * The open register. `stage != closed` is a fixed clause; everything the filter
 * bar publishes is optional, so with nothing chosen you see every open breach —
 * and the sort is the exact deadline, so the top row is the one you are closest
 * to failing.
 */
const openBreachesBinding = {
    kind: 'records',
    tableId: 'tbl_brchs01',
    filter: [
        { field: 'stage', op: 'neq', value: 'closed' },
        { field: 'title', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
        { field: 'severity', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.severity' }, required: false },
        { field: 'stage', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.stage' }, required: false },
        // A toggle that is off must not filter to "due on no day at all", so it
        // resolves to null and the clause drops out entirely.
        { field: 'notify_due_date', op: 'lte', value: { kind: 'formula', expr: 'vars.filters.due ? today : null' }, required: false },
    ],
    sort: [{ field: 'notify_due_at', dir: 'asc' }],
    limit: 200,
};

/** The open breach, re-read live. Never the snapshot — see the module header. */
const openBreachRecord = {
    kind: 'record',
    tableId: 'tbl_brchs01',
    filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.breach.id' }, required: true }],
    limit: 1,
};

/** Child rows of the open breach. Required: with nothing open, show nothing. */
const forOpenBreach = (tableId, sort, limit) => ({
    kind: 'records',
    tableId,
    filter: [{ field: 'breach_id', op: 'eq', value: { kind: 'formula', expr: 'vars.breach.id' }, required: true }],
    sort,
    limit,
});

// ==================================================================
// THE CLOCK — every open breach, most urgent first. The home screen.
// ==================================================================
const SCREEN_CLOCK = {
    id: 'scr_clock',
    name: 'Open breaches',
    icon: 'AlertTriangle',
    showInNav: true,
    maxWidth: 'full',
    description: 'The 72-hour clock, running.',
    sections: [
        {
            id: 'sec_cktop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_ckhdr',
                    type: 'page_header',
                    props: {
                        look: 'banner',
                        title: 'Open breaches',
                        subtitle: 'Ordered by the Article 33 deadline — 72 hours from the moment we became aware, not from when it happened.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'AlertTriangle',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_cknew',
                            type: 'button',
                            props: { label: 'Report a breach', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_goreport',
                        },
                    ],
                },
                {
                    id: 'cmp_ckst1',
                    type: 'stat',
                    props: {
                        look: 'accent',
                        label: 'Open',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'stage', op: 'neq', value: 'closed' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'breaches still being handled',
                        icon: 'Inbox',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    /**
                     * THE NUMBER THE APP EXISTS FOR. "Still owes the authority a
                     * notification, and the deadline day has arrived or gone."
                     * `authority_required` defaults to true, so a breach nobody
                     * has assessed yet counts here — which is the safe direction.
                     */
                    id: 'cmp_ckst2',
                    type: 'stat',
                    props: {
                        look: 'accent',
                        label: 'Due now',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'authority_required', op: 'eq', value: true },
                                { field: 'authority_notified_at', op: 'isNull' },
                                { field: 'notify_due_date', op: 'lte', value: { kind: 'formula', expr: 'today' } },
                            ],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'authority not notified, 72 hours up today or already past',
                        icon: 'Timer',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_ckst3',
                    type: 'stat',
                    props: {
                        look: 'accent',
                        label: 'Notified late',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'authority_hours', op: 'gt', value: 72 }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'ever — each needs a reason for the delay on file',
                        icon: 'History',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_ckst4',
                    type: 'stat',
                    props: {
                        look: 'accent',
                        label: 'Recorded, not notifiable',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'outcome', op: 'eq', value: 'recorded_only' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'assessed as no risk and documented (Art. 33(5))',
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
                    id: 'cmp_ckfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search', type: 'search', options: [] },
                            { name: 'severity', label: 'Severity', type: 'select', options: SEVERITY_OPTIONS },
                            { name: 'stage', label: 'Stage', type: 'select', options: STAGE_FILTER_OPTIONS },
                            { name: 'due', label: 'Deadline reached', type: 'toggle', options: [] },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            // ONE row of children — a fill section stretches its first row only.
            id: 'sec_ckmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_ckgrid',
                    type: 'data_grid',
                    props: {
                        source: openBreachesBinding,
                        columns: [
                            { key: 'reference', label: 'Reference', format: 'text', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'title', label: 'What happened', format: 'text', width: 320, sortable: true, filterable: true, editable: false },
                            { key: 'breach_type', label: 'Type', format: 'badge', width: 140, sortable: true, filterable: true, editable: false },
                            { key: 'severity', label: 'Severity', format: 'badge', width: 120, sortable: true, filterable: true, editable: false },
                            // The DATE copy, not the timestamp: a grid formats a
                            // datetime as a date anyway, and this is the column
                            // the urgency filter compares against — showing the
                            // other one would mean the eye and the filter were
                            // reading different things.
                            { key: 'notify_due_date', label: 'Notify by', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                            { key: 'people_affected', label: 'People', format: 'number', width: 90, sortable: true, filterable: false, editable: false },
                            { key: 'stage', label: 'Stage', format: 'badge', width: 120, sortable: true, filterable: true, editable: false },
                            { key: 'outcome', label: 'Outcome', format: 'badge', width: 180, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        // Inline editing is off deliberately: a statutory register
                        // is not something to nudge a cell in. Every change goes
                        // through a form on the breach file that also writes the
                        // action log. `selectable:'none'` is also what makes
                        // onRowClick fire with the row itself.
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Open', actionId: 'act_bopen' }],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'Nothing open. When something happens, report it here — the clock starts the moment anyone in the organisation knows.',
                    },
                    style: { span: 12, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_bopen',
                },
            ],
        },
    ],
};

// ==================================================================
// REPORT — the intake, where the clock is set correctly or not at all.
// ==================================================================
const SCREEN_REPORT = {
    id: 'scr_report',
    name: 'Report a breach',
    icon: 'Plus',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Log it now; assess it after.',
    sections: [
        {
            id: 'sec_rptop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rphdr',
                    type: 'page_header',
                    props: {
                        title: 'Report a breach',
                        subtitle: 'Report first, investigate second. A record you can correct beats a deadline you missed while gathering detail.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'Plus',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_rpback',
                            type: 'button',
                            props: { label: 'Back to the register', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_goclock',
                        },
                    ],
                },
                {
                    id: 'cmp_rpnote',
                    type: 'callout',
                    props: {
                        title: 'The clock starts at awareness, not at the incident',
                        text: 'The 72 hours of Article 33 run from the moment the organisation became **aware** — which can be days or months after the thing itself happened. A backup found missing this morning, lost last spring, is due within 72 hours of this morning. If a processor told you, awareness is the moment **they told you**; record that on the Systems tab afterwards.',
                        tone: 'warning',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_rpmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_rpform',
                    type: 'form',
                    props: { name: 'newbreach', submitLabel: 'Record it and start the clock', showReset: false, showSubmit: true },
                    style: { span: 8, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_report',
                    children: [
                        {
                            id: 'cmp_rpf1',
                            type: 'input_text',
                            props: {
                                name: 'reference', label: 'Reference', required: true, inputType: 'text',
                                placeholder: 'BR-2026-018', defaultValue: null, valueFrom: { kind: 'static', value: null },
                            },
                            style: { span: 4 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rpf2',
                            type: 'input_text',
                            props: {
                                name: 'title', label: 'What happened, in one line', required: true, inputType: 'text',
                                placeholder: 'Mailing sent with every recipient in the To field', defaultValue: null,
                                valueFrom: { kind: 'static', value: null },
                            },
                            style: { span: 8 },
                            visible: true,
                        },
                        {
                            // defaultValue 'now' is right almost every time — you
                            // are reporting because you have just found out.
                            id: 'cmp_rpf3',
                            type: 'input_datetime',
                            props: { name: 'became_aware_at', label: 'We became aware (date and time)', required: true, withTime: true, defaultValue: 'now' },
                            style: { span: 4 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rpf4',
                            type: 'input_datetime',
                            props: { name: 'occurred_at', label: 'It happened (if known)', required: false, withTime: true, defaultValue: null },
                            style: { span: 4 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rpf5',
                            type: 'input_select',
                            props: {
                                name: 'breach_type', label: 'Kind of breach', required: true, options: BREACH_TYPE_OPTIONS,
                                defaultValue: 'confidentiality', placeholder: null, valueFrom: { kind: 'static', value: null },
                            },
                            style: { span: 4 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rpf6',
                            type: 'input_textarea',
                            props: { name: 'description', label: 'What we know so far', required: true, rows: 4, placeholder: 'What was exposed, how it came to light, who is involved.', valueFrom: { kind: 'static', value: null } },
                            style: { span: 12 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rpf7',
                            type: 'input_text',
                            props: {
                                name: 'data_categories', label: 'Categories of personal data affected (Art. 33(3)(a))', required: false, inputType: 'text',
                                placeholder: 'Name, e-mail address, order history', defaultValue: null, valueFrom: { kind: 'static', value: null },
                            },
                            style: { span: 8 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rpf8',
                            type: 'input_number',
                            props: { name: 'people_affected', label: 'People affected (estimate)', required: false, min: 0, max: 100000000, step: 1, defaultValue: null },
                            style: { span: 4 },
                            visible: true,
                        },
                        {
                            id: 'cmp_rpf9',
                            type: 'input_textarea',
                            props: { name: 'containment', label: 'What has already been done to contain it', required: false, rows: 3, placeholder: 'Mailing recalled, account locked, server disconnected.', valueFrom: { kind: 'static', value: null } },
                            style: { span: 12 },
                            visible: true,
                        },
                    ],
                },
                {
                    /**
                     * The last few reports, so a second person who noticed the
                     * same thing sees it is already logged instead of opening a
                     * duplicate with a different deadline.
                     */
                    id: 'cmp_rprec',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_brchs01',
                            sort: [{ field: 'created_at', dir: 'desc' }],
                            limit: 8,
                        },
                        titleKey: 'title',
                        subtitleKey: 'reference',
                        metaKey: 'severity',
                        timestampKey: 'became_aware_at',
                        badgeKey: 'stage',
                        badgeToneMap: [
                            { value: 'reported', label: 'Reported', tone: 'warning' },
                            { value: 'assessed', label: 'Assessed', tone: 'info' },
                            { value: 'notified', label: 'Notified', tone: 'primary' },
                            { value: 'closed', label: 'Closed', tone: 'neutral' },
                        ],
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'ShieldCheck',
                        emptyText: 'Nothing reported yet.',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_bopen',
                },
            ],
        },
    ],
};

// ==================================================================
// BREACH FILE — one breach, its clock, and everything done about it.
// ==================================================================
const SCREEN_BREACH = {
    id: 'scr_breach',
    name: 'Breach file',
    icon: 'FileText',
    showInNav: false,
    maxWidth: 'full',
    description: 'One breach in full, with its action log.',
    sections: [
        {
            id: 'sec_brtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_brhdr',
                    type: 'page_header',
                    props: {
                        title: 'Breach file',
                        subtitle: null,
                        titleFrom: { kind: 'formula', expr: 'vars.breach.title' },
                        subtitleFrom: { kind: 'formula', expr: 'vars.breach.reference' },
                        icon: 'FileText',
                        showDivider: true,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_brback',
                            type: 'button',
                            props: { label: 'Back to the register', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_goclock',
                        },
                    ],
                },
                {
                    // What the screen says on first open, before anything is
                    // picked. Without it the page is four empty panels.
                    id: 'cmp_brnone',
                    type: 'callout',
                    props: {
                        title: 'No breach open',
                        text: 'Pick one from the register — Open breaches, or the closed register — and its file, its clock and its action log appear here.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: { kind: 'formula', expr: '!vars.breach.id' },
                },
                {
                    id: 'cmp_brclock',
                    type: 'markdown',
                    props: {
                        content: 'The Article 33 deadline appears here once a breach is open.',
                        contentFrom: { kind: 'formula', expr: CLOCK_EXPR },
                    },
                    style: { span: 12 },
                    visible: { kind: 'formula', expr: 'vars.breach.id' },
                },
                {
                    /**
                     * Bound to the LIVE row, not to `vars.breach`: the snapshot
                     * was taken when the row was clicked, so a stepper reading it
                     * would still show "Reported" immediately after the very
                     * assessment this screen exists to record.
                     *
                     * A breach that is recorded-but-not-notifiable jumps from
                     * Assessed straight to Closed. That is the honest picture —
                     * "Notified" is a step it correctly never takes.
                     */
                    id: 'cmp_brstep',
                    type: 'stepper',
                    props: {
                        value: { ...openBreachRecord, pick: { row: 'first', column: 'stage' } },
                        steps: [
                            { value: 'reported', label: 'Reported', icon: 'Inbox' },
                            { value: 'assessed', label: 'Assessed', icon: 'Gauge' },
                            { value: 'notified', label: 'Notified', icon: 'Mail' },
                            { value: 'closed', label: 'Closed', icon: 'CheckCircle2' },
                        ],
                        orientation: 'horizontal',
                        tone: 'primary',
                        showLabels: true,
                    },
                    style: { span: 12 },
                    visible: { kind: 'formula', expr: 'vars.breach.id' },
                },
                {
                    id: 'cmp_brdet',
                    type: 'record_detail',
                    props: {
                        source: openBreachRecord,
                        columns: 3,
                        fields: [
                            { key: 'reference', label: 'Reference', format: 'text' },
                            { key: 'breach_type', label: 'Kind', format: 'badge' },
                            { key: 'severity', label: 'Severity', format: 'badge' },
                            { key: 'became_aware_at', label: 'We became aware', format: 'datetime' },
                            { key: 'notify_due_at', label: 'Article 33 deadline', format: 'datetime' },
                            { key: 'occurred_at', label: 'It happened', format: 'datetime' },
                            { key: 'people_affected', label: 'People affected', format: 'number' },
                            { key: 'records_affected', label: 'Records affected', format: 'number' },
                            { key: 'special_categories', label: 'Special-category data (Art. 9)', format: 'text' },
                            { key: 'data_categories', label: 'Categories of data', format: 'text' },
                            { key: 'outcome', label: 'Outcome', format: 'badge' },
                            { key: 'reported_by', label: 'Reported by', format: 'text' },
                            { key: 'description', label: 'What happened', format: 'markdown' },
                            { key: 'containment', label: 'Containment', format: 'markdown' },
                            { key: 'risk_summary', label: 'Risk assessment', format: 'markdown' },
                            { key: 'authority_notified_at', label: 'Authority notified', format: 'datetime' },
                            { key: 'authority_hours', label: 'Hours from awareness', format: 'number' },
                            { key: 'authority_reference', label: 'Authority reference', format: 'text' },
                            { key: 'authority_late_reason', label: 'Reason for the delay', format: 'markdown' },
                            { key: 'subjects_notified_at', label: 'People told', format: 'datetime' },
                            { key: 'subjects_exempt_ground', label: 'Exemption used', format: 'badge' },
                            { key: 'remediation', label: 'Remediation', format: 'markdown' },
                        ],
                        emptyText: 'Open a breach from the register to see its file.',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_brmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_brtabs',
                    type: 'tabs',
                    props: {},
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        // ── Assessment ─────────────────────────────────────
                        {
                            id: 'cmp_brt1',
                            type: 'tab',
                            props: { label: 'Assessment', icon: 'Gauge' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    /**
                                     * The vocabulary, read live from the config
                                     * table, so what the DPO wrote on Setup is
                                     * what the assessor reads here.
                                     */
                                    id: 'cmp_asguide',
                                    type: 'list',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_sevs001', sort: [{ field: 'position', dir: 'asc' }], limit: 30 },
                                        titleKey: 'name',
                                        subtitleKey: 'guidance',
                                        metaKey: 'key',
                                        timestampKey: null,
                                        badgeKey: 'key',
                                        badgeToneMap: SEVERITY_TONES,
                                        unreadKey: null,
                                        selectedWhen: null,
                                        icon: 'Gauge',
                                        emptyText: 'No severity levels configured — add them on Setup.',
                                    },
                                    style: { span: 5, height: 'lg' },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_asform',
                                    type: 'form',
                                    props: { name: 'assess', submitLabel: 'Record the assessment', showReset: false, showSubmit: true },
                                    style: { span: 7, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_assess',
                                    children: [
                                        {
                                            id: 'cmp_asf1',
                                            type: 'input_select',
                                            props: {
                                                name: 'severity', label: 'Severity', required: true, options: SEVERITY_OPTIONS,
                                                defaultValue: 'medium', placeholder: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 6 },
                                            visible: true,
                                        },
                                        {
                                            /**
                                             * The whole assessment in one field.
                                             * Asked as "who must be told" rather
                                             * than as two checkboxes because that
                                             * is the shape of the obligation —
                                             * and because a checkbox has no way
                                             * to show what it currently is, so
                                             * re-submitting a form would silently
                                             * clear a decision already made.
                                             */
                                            id: 'cmp_asf2',
                                            type: 'input_select',
                                            props: {
                                                name: 'notify_decision', label: 'Who must be told?', required: true, options: NOTIFY_DECISION_OPTIONS,
                                                defaultValue: 'authority_only', placeholder: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 6 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_asf3',
                                            type: 'input_textarea',
                                            props: {
                                                name: 'risk_summary',
                                                label: 'Risk to the rights and freedoms of the people affected — and, if you are not notifying, why not (Art. 33(5))',
                                                required: true, rows: 4,
                                                placeholder: 'What could happen to them, how likely, and what makes it more or less severe.',
                                                valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_asf4',
                                            type: 'input_number',
                                            props: { name: 'people_affected', label: 'People affected', required: false, min: 0, max: 100000000, step: 1, defaultValue: null },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_asf5',
                                            type: 'input_number',
                                            props: { name: 'records_affected', label: 'Records affected', required: false, min: 0, max: 100000000, step: 1, defaultValue: null },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_asf6',
                                            type: 'input_checkbox',
                                            props: { name: 'special_categories', label: 'Special-category data is involved (Art. 9)', defaultChecked: false },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_asf7',
                                            type: 'input_text',
                                            props: {
                                                name: 'data_categories', label: 'Categories of personal data affected', required: false, inputType: 'text',
                                                placeholder: 'Name, e-mail address, order history', defaultValue: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                    ],
                                },
                            ],
                        },

                        // ── Authority (Art. 33) ────────────────────────────
                        {
                            id: 'cmp_brt2',
                            type: 'tab',
                            props: { label: 'Authority (Art. 33)', icon: 'Building2' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_aunote',
                                    type: 'callout',
                                    props: {
                                        title: 'Notify within 72 hours, or say why not',
                                        text: 'Record the notification the moment it is sent — the register works out the hours from awareness for you and keeps them as the evidence. Later than 72 hours is allowed, but the notification itself must carry the **reasons for the delay**, so write them here too.',
                                        tone: 'info',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_auform',
                                    type: 'form',
                                    props: { name: 'authnotice', submitLabel: 'Record the notification', showReset: false, showSubmit: true },
                                    style: { span: 6, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_authnote',
                                    children: [
                                        {
                                            id: 'cmp_auf1',
                                            type: 'input_datetime',
                                            props: { name: 'notified_at', label: 'Notified the authority at', required: true, withTime: true, defaultValue: 'now' },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_auf2',
                                            type: 'input_text',
                                            props: {
                                                name: 'authority_reference', label: 'Their reference number', required: false, inputType: 'text',
                                                placeholder: 'AP-2026-000000', defaultValue: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_auf3',
                                            type: 'input_textarea',
                                            props: {
                                                name: 'late_reason', label: 'Reasons for the delay (only if later than 72 hours)', required: false, rows: 3,
                                                placeholder: 'Why the notification could not be made within 72 hours of becoming aware.',
                                                valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                    ],
                                },
                                {
                                    /**
                                     * The other legitimate ending. A form rather
                                     * than a button, because the ground for not
                                     * notifying IS the record — a one-click
                                     * "not notifiable" would produce exactly the
                                     * undocumented decision Art. 33(5) is about.
                                     */
                                    id: 'cmp_nnform',
                                    type: 'form',
                                    props: { name: 'notnotifiable', submitLabel: 'Record as not notifiable', showReset: false, showSubmit: true },
                                    style: { span: 6, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_notnotify',
                                    children: [
                                        {
                                            id: 'cmp_nnf1',
                                            type: 'input_textarea',
                                            props: {
                                                name: 'justification', label: 'Why a risk to people is unlikely (Art. 33(1))', required: true, rows: 4,
                                                placeholder: 'What was affected, why it cannot harm anyone, and what makes you confident of that.',
                                                valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_nnf2',
                                            type: 'input_date',
                                            props: { name: 'decided_on', label: 'Decided on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                    ],
                                },
                            ],
                        },

                        // ── Data subjects (Art. 34) ────────────────────────
                        {
                            id: 'cmp_brt3',
                            type: 'tab',
                            props: { label: 'People affected (Art. 34)', icon: 'Users' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sunote',
                                    type: 'callout',
                                    props: {
                                        title: 'High risk means telling the people themselves',
                                        text: 'Article 34 has no 72-hour clock — it says **without undue delay**. Tell them in clear, plain language what happened, what it means for them and what they can do. You may skip it only on one of the three grounds in Article 34(3), and the ground has to be recorded.',
                                        tone: 'info',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_suform',
                                    type: 'form',
                                    props: { name: 'subjnotice', submitLabel: 'Record that we told them', showReset: false, showSubmit: true },
                                    style: { span: 6, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_subjnote',
                                    children: [
                                        {
                                            id: 'cmp_suf1',
                                            type: 'input_datetime',
                                            props: { name: 'notified_at', label: 'People told at', required: true, withTime: true, defaultValue: 'now' },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_suf2',
                                            type: 'input_select',
                                            props: {
                                                name: 'method', label: 'How', required: true, options: SUBJECT_METHOD_OPTIONS,
                                                defaultValue: 'individual', placeholder: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_suf3',
                                            type: 'input_textarea',
                                            props: {
                                                name: 'summary', label: 'What we told them', required: true, rows: 3,
                                                placeholder: 'The message sent, and where it went.',
                                                valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                    ],
                                },
                                {
                                    id: 'cmp_seform',
                                    type: 'form',
                                    props: { name: 'subjexempt', submitLabel: 'Record the exemption', showReset: false, showSubmit: true },
                                    style: { span: 6, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_subjexmpt',
                                    children: [
                                        {
                                            id: 'cmp_sef1',
                                            type: 'input_select',
                                            props: {
                                                name: 'ground', label: 'Ground for not telling them', required: true, options: EXEMPT_GROUND_OPTIONS,
                                                defaultValue: 'encryption', placeholder: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_sef2',
                                            type: 'input_textarea',
                                            props: {
                                                name: 'reason', label: 'Why that ground applies here', required: true, rows: 4,
                                                placeholder: 'For encryption: which algorithm, where the keys were, and why they are safe.',
                                                valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                    ],
                                },
                            ],
                        },

                        // ── Systems and processors ─────────────────────────
                        {
                            id: 'cmp_brt4',
                            type: 'tab',
                            props: { label: 'Systems and processors', icon: 'Boxes' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sygrid',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenBreach('tbl_bsys001', [{ field: 'name', dir: 'asc' }], 100),
                                        columns: [
                                            { key: 'name', label: 'System or organisation', format: 'text', width: 240, sortable: true, filterable: true, editable: false },
                                            { key: 'party_role', label: 'Role', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'data_held', label: 'What it held', format: 'text', width: 260, sortable: false, filterable: false, editable: false },
                                            { key: 'told_us_at', label: 'They told us', format: 'date', width: 130, sortable: true, filterable: false, editable: false },
                                            { key: 'contained', label: 'Contained', format: 'boolean', width: 100, sortable: false, filterable: false, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Remove', actionId: 'act_sysdel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'Nothing listed yet — add the systems, processors and recipients the data passed through.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_syform',
                                    type: 'form',
                                    props: { name: 'newsystem', submitLabel: 'Add', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_sysadd',
                                    children: [
                                        {
                                            id: 'cmp_syf1',
                                            type: 'input_text',
                                            props: {
                                                name: 'name', label: 'System or organisation', required: true, inputType: 'text',
                                                placeholder: 'Nimbusveld Mailing BV', defaultValue: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_syf2',
                                            type: 'input_select',
                                            props: {
                                                name: 'party_role', label: 'Role', required: true, options: PARTY_ROLE_OPTIONS,
                                                defaultValue: 'own_system', placeholder: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 3 },
                                            visible: true,
                                        },
                                        {
                                            // Art. 33(2). Blank for our own
                                            // systems; for a processor it is the
                                            // moment OUR clock started.
                                            id: 'cmp_syf3',
                                            type: 'input_datetime',
                                            props: { name: 'told_us_at', label: 'They told us at (processors)', required: false, withTime: true, defaultValue: null },
                                            style: { span: 5 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_syf4',
                                            type: 'input_text',
                                            props: {
                                                name: 'data_held', label: 'What it held', required: false, inputType: 'text',
                                                placeholder: 'Newsletter recipients and their names', defaultValue: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 5 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_syf5',
                                            type: 'input_text',
                                            props: {
                                                name: 'contact', label: 'Contact', required: false, inputType: 'email',
                                                placeholder: 'privacy@example.com', defaultValue: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_syf6',
                                            type: 'input_checkbox',
                                            props: { name: 'contained', label: 'Contained', defaultChecked: false },
                                            style: { span: 3 },
                                            visible: true,
                                        },
                                    ],
                                },
                            ],
                        },

                        // ── Action log ─────────────────────────────────────
                        {
                            id: 'cmp_brt5',
                            type: 'tab',
                            props: { label: 'Action log', icon: 'History' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    /**
                                     * THE EVIDENCE. Everything the app does to a
                                     * breach also writes a line here, so the
                                     * timeline is complete without anyone
                                     * remembering to keep it.
                                     */
                                    id: 'cmp_lgline',
                                    type: 'timeline',
                                    props: {
                                        source: forOpenBreach('tbl_bacts01', [{ field: 'happened_at', dir: 'desc' }], 100),
                                        titleKey: 'summary',
                                        dateKey: 'happened_at',
                                        descriptionKey: 'actor_name',
                                        icon: 'History',
                                        rowLimit: 100,
                                        emptyText: 'No entries yet — open a breach, or add the first step taken.',
                                    },
                                    style: { span: 7, height: 'lg' },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_lgform',
                                    type: 'form',
                                    props: { name: 'newaction', submitLabel: 'Add to the log', showReset: false, showSubmit: true },
                                    style: { span: 5, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_logadd',
                                    children: [
                                        {
                                            id: 'cmp_lgf1',
                                            type: 'input_datetime',
                                            props: { name: 'happened_at', label: 'When', required: true, withTime: true, defaultValue: 'now' },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_lgf2',
                                            type: 'input_select',
                                            props: {
                                                name: 'action_type', label: 'What kind of step', required: true, options: ACTION_TYPE_OPTIONS,
                                                defaultValue: 'note', placeholder: null, valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_lgf3',
                                            type: 'input_textarea',
                                            props: {
                                                name: 'summary', label: 'What was done', required: true, rows: 4,
                                                placeholder: 'Who did what, and what it changed.',
                                                valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 12 },
                                            visible: true,
                                        },
                                    ],
                                },
                            ],
                        },

                        // ── Close ──────────────────────────────────────────
                        {
                            id: 'cmp_brt6',
                            type: 'tab',
                            props: { label: 'Close', icon: 'CheckCircle2' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_clnote',
                                    type: 'callout',
                                    props: {
                                        title: 'Closing does not remove anything',
                                        text: 'A closed breach moves to the closed register and stays there — that register IS the Article 33(5) documentation. Write down what was changed so it cannot happen again; that is the part an authority reads first.',
                                        tone: 'info',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_clform',
                                    type: 'form',
                                    props: { name: 'closebreach', submitLabel: 'Close this breach', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_close',
                                    children: [
                                        {
                                            id: 'cmp_clf1',
                                            type: 'input_textarea',
                                            props: {
                                                name: 'remediation', label: 'What was changed so it cannot happen again', required: true, rows: 4,
                                                placeholder: 'Process, system or training change — and who owns it.',
                                                valueFrom: { kind: 'static', value: null },
                                            },
                                            style: { span: 8 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_clf2',
                                            type: 'input_date',
                                            props: { name: 'closed_on', label: 'Closed on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } },
                                            style: { span: 4 },
                                            visible: true,
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// CLOSED REGISTER — the documentation, and the proof the clock was met.
// ==================================================================
const SCREEN_CLOSED = {
    id: 'scr_closed',
    name: 'Closed register',
    icon: 'BookOpen',
    showInNav: true,
    maxWidth: 'full',
    description: 'Everything handled, including what was correctly not notified.',
    sections: [
        {
            id: 'sec_cltop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_cldhdr',
                    type: 'page_header',
                    props: {
                        title: 'Closed register (datalekregister)',
                        subtitle: 'Article 33(5): every breach documented, whether or not it was notified — this is what an authority asks to see.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'BookOpen',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_cldst1',
                    type: 'stat',
                    props: {
                        look: 'accent',
                        label: 'Closed',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'stage', op: 'eq', value: 'closed' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'cases documented',
                        icon: 'BookOpen',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    /**
                     * The median, not the average: one forgotten case at 400
                     * hours would make a mean say nothing about how the team
                     * actually works. p50 is a real aggregate the query compiler
                     * computes with a window function.
                     */
                    id: 'cmp_cldst2',
                    type: 'stat',
                    props: {
                        look: 'accent',
                        label: 'Median hours to notify',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            aggregates: [{ fn: 'p50', field: 'authority_hours', as: 'p50h' }],
                            filter: [{ field: 'authority_hours', op: 'isNotNull' }],
                            limit: 1,
                            pick: { row: 'first', column: 'p50h' },
                        },
                        caption: 'from awareness to the authority — the ceiling is 72',
                        icon: 'Timer',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_cldst3',
                    type: 'stat',
                    props: {
                        look: 'accent',
                        label: 'Slowest notification',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            aggregates: [{ fn: 'max', field: 'authority_hours', as: 'worst' }],
                            filter: [{ field: 'authority_hours', op: 'isNotNull' }],
                            limit: 1,
                            pick: { row: 'first', column: 'worst' },
                        },
                        caption: 'hours — anything over 72 needs its reason on file',
                        icon: 'AlertTriangle',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_cldfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search', type: 'search', options: [] },
                            { name: 'outcome', label: 'Outcome', type: 'select', options: OUTCOME_OPTIONS },
                            { name: 'severity', label: 'Severity', type: 'select', options: SEVERITY_OPTIONS },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_clmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_cldgrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_brchs01',
                            filter: [
                                { field: 'stage', op: 'eq', value: 'closed' },
                                { field: 'title', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                { field: 'outcome', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.outcome' }, required: false },
                                { field: 'severity', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.severity' }, required: false },
                            ],
                            sort: [{ field: 'became_aware_at', dir: 'desc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'reference', label: 'Reference', format: 'text', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'title', label: 'What happened', format: 'text', width: 280, sortable: true, filterable: true, editable: false },
                            { key: 'severity', label: 'Severity', format: 'badge', width: 110, sortable: true, filterable: true, editable: false },
                            { key: 'outcome', label: 'Outcome', format: 'badge', width: 200, sortable: true, filterable: true, editable: false },
                            { key: 'became_aware_at', label: 'Aware', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                            { key: 'authority_hours', label: 'Hours to notify', format: 'number', width: 130, sortable: true, filterable: false, editable: false },
                            { key: 'closed_on', label: 'Closed', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Open', actionId: 'act_bopen' }],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'Nothing closed yet.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_bopen',
                },
                {
                    id: 'cmp_cldpie',
                    type: 'chart',
                    props: {
                        chartType: 'donut',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            groupBy: [{ field: 'outcome', as: 'outcome' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'stage', op: 'eq', value: 'closed' }],
                            limit: 20,
                        },
                        title: 'How cases ended',
                        xKey: 'outcome',
                        series: [{ key: 'n', label: 'Breaches', color: 'primary' }],
                        stacked: false,
                        showLegend: true,
                        showGrid: false,
                        valueFormat: 'number',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_clchart',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_cldbar',
                    type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            groupBy: [{ field: 'became_aware_at', bucket: 'month', as: 'month' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            limit: 24,
                        },
                        title: 'Breaches by the month we became aware',
                        xKey: 'month',
                        series: [{ key: 'n', label: 'Breaches', color: 'primary' }],
                        stacked: false,
                        showLegend: false,
                        showGrid: true,
                        valueFormat: 'number',
                    },
                    style: { span: 6, height: 'md' },
                    visible: true,
                },
                {
                    id: 'cmp_cldsev',
                    type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_brchs01',
                            groupBy: [{ field: 'severity', as: 'severity' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            limit: 20,
                        },
                        title: 'Breaches by severity',
                        xKey: 'severity',
                        series: [{ key: 'n', label: 'Breaches', color: 'info' }],
                        stacked: false,
                        showLegend: false,
                        showGrid: true,
                        valueFormat: 'number',
                    },
                    style: { span: 6, height: 'md' },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// SETUP — the severity vocabulary, and what it does not reach.
// ==================================================================
const SCREEN_SETUP = {
    id: 'scr_setup',
    name: 'Setup',
    icon: 'Settings',
    showInNav: true,
    maxWidth: 'wide',
    description: 'The severity vocabulary the assessment is made in.',
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
                        subtitle: 'Severity tiers are data, not code — what you write here is what the person assessing a breach reads.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'Settings',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_stadd',
                            type: 'button',
                            props: { label: 'Add a severity level', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_sevopen',
                        },
                    ],
                },
                {
                    id: 'cmp_stnote',
                    type: 'callout',
                    props: {
                        title: 'One thing to know',
                        text: 'A tier you add here is stored, filtered and shown correctly everywhere, and the Assessment tab reads its guidance live. The one exception is the Severity **dropdown** on that tab and in the filter bars: those lists are fixed in the app design, so a new tier will not appear in them until an editor adds it there.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
                {
                    id: 'cmp_stlaw',
                    type: 'markdown',
                    props: {
                        content: [
                            '**What the register has to contain.** Article 33(5) asks you to document the facts of the breach, its effects, and the remedial action taken — for **every** breach, notified or not.',
                            '',
                            '**Notify the authority** within 72 hours of becoming aware, unless a risk to people is unlikely (Art. 33(1)). Later is allowed with reasons for the delay.',
                            '',
                            '**Tell the people affected** without undue delay where the risk to them is high (Art. 34(1)), unless one of the three grounds in Article 34(3) applies.',
                            '',
                            '**A processor** must tell you without undue delay (Art. 33(2)); your own 72 hours start when they do.',
                        ].join('\n'),
                        contentFrom: { kind: 'static', value: null },
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
                    id: 'cmp_stgrid',
                    type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_sevs001', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                        columns: [
                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                            { key: 'key', label: 'Stored as', format: 'text', width: 140, sortable: true, filterable: true, editable: false },
                            { key: 'name', label: 'Name', format: 'text', width: 180, sortable: false, filterable: false, editable: true },
                            { key: 'guidance', label: 'What it means', format: 'text', width: 420, sortable: false, filterable: false, editable: true },
                            { key: 'notify_authority', label: 'Notify authority', format: 'boolean', width: 140, sortable: false, filterable: false, editable: true },
                            { key: 'notify_subjects', label: 'Tell people', format: 'boolean', width: 120, sortable: false, filterable: false, editable: true },
                            { key: 'color', label: 'Colour', format: 'badge', width: 110, sortable: false, filterable: false, editable: true },
                        ],
                        pageSize: 25,
                        // Inline editing needs selectable:'none' — with a
                        // selection mode set, onRowSelect fires with the SELECTED
                        // ROWS instead of the edited one, and the save writes
                        // nothing.
                        selectable: 'none',
                        searchable: false,
                        rowActions: [{ label: 'Delete', actionId: 'act_sevdel' }],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No severity levels yet — add the tiers your DPO assesses in.',
                    },
                    style: { span: 12, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_sevsave',
                },
            ],
        },
        {
            id: 'sec_stdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_stmod',
                    type: 'modal',
                    props: { title: 'Add a severity level', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_stfrm',
                            type: 'form',
                            props: { name: 'newlevel', submitLabel: 'Add', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sevadd',
                            children: [
                                {
                                    id: 'cmp_stf1',
                                    type: 'input_text',
                                    props: {
                                        name: 'key', label: 'Stored as (what a breach records, e.g. very_high)', required: true, inputType: 'text',
                                        placeholder: 'very_high', defaultValue: null, valueFrom: { kind: 'static', value: null },
                                    },
                                    style: { span: 8 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_stf2',
                                    type: 'input_number',
                                    props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 },
                                    style: { span: 4 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_stf3',
                                    type: 'input_text',
                                    props: {
                                        name: 'name', label: 'Name', required: true, inputType: 'text',
                                        placeholder: 'Very high risk', defaultValue: null, valueFrom: { kind: 'static', value: null },
                                    },
                                    style: { span: 6 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_stf4',
                                    type: 'input_select',
                                    props: {
                                        name: 'color', label: 'Colour', required: false, options: COLOR_OPTIONS,
                                        defaultValue: 'neutral', placeholder: null, valueFrom: { kind: 'static', value: null },
                                    },
                                    style: { span: 6 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_stf5',
                                    type: 'input_textarea',
                                    props: {
                                        name: 'guidance', label: 'What it means, and what it implies', required: false, rows: 3,
                                        placeholder: 'When to use this tier, and who has to be told.',
                                        valueFrom: { kind: 'static', value: null },
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_stf6',
                                    type: 'input_checkbox',
                                    props: { name: 'notify_authority', label: 'At this tier the authority is notified', defaultChecked: true },
                                    style: { span: 6 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_stf7',
                                    type: 'input_checkbox',
                                    props: { name: 'notify_subjects', label: 'At this tier the people affected are told', defaultChecked: false },
                                    style: { span: 6 },
                                    visible: true,
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Actions
//
// Every write follows the same shape: guard on `vars.breach.id` (the only field
// of the snapshot that cannot go stale), write the register, write the action
// log, refresh BOTH tables, clear the form, say what happened. The log entry is
// not optional politeness — it is the evidence that the step was taken, and
// making it part of the same sequence is the only way it cannot be forgotten.
//
// A `sequence` takes ONLY { kind, steps }: onError/onSuccess are dropped as a
// structural repair, and the runner already surfaces the real failure message.
// ---------------------------------------------------------------------------

const actions = {
    // ── Navigation ─────────────────────────────────────────────────────────
    act_goclock: { kind: 'navigate', screenId: 'scr_clock' },
    act_goreport: { kind: 'navigate', screenId: 'scr_report' },

    /** Open a breach. `item` is the clicked row, on both a row click and a row action. */
    act_bopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'breach', value: { kind: 'formula', expr: 'item' } },
            { kind: 'navigate', screenId: 'scr_breach' },
        ],
    },

    // ── Intake ─────────────────────────────────────────────────────────────

    /**
     * Record a breach and START THE CLOCK.
     *
     * The two deadline columns are computed HERE, once, from the awareness time
     * the reporter typed — never recomputed on read, because the deadline is a
     * fact about a moment, not a function of when you happen to look. See the
     * module header for why this is not a computed column.
     *
     * `resultVar` names the new row so the very next step can hang the first log
     * entry off it; without it the id exists only as the last step's result and
     * the second server step would overwrite it.
     *
     * It does NOT navigate into the new file: create_record returns { id }, not
     * the row, so `vars.breach` could not be filled honestly. The reporter goes
     * back to the register, where the new breach is at the top — its deadline is
     * the nearest one there is.
     */
    act_report: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_brchs01',
                resultVar: 'newbreach',
                values: {
                    reference: { kind: 'formula', expr: 'form.reference' },
                    title: { kind: 'formula', expr: 'form.title' },
                    description: { kind: 'formula', expr: 'form.description' },
                    breach_type: { kind: 'formula', expr: 'form.breach_type' },
                    occurred_at: { kind: 'formula', expr: 'form.occurred_at' },
                    became_aware_at: { kind: 'formula', expr: 'form.became_aware_at' },
                    notify_due_at: { kind: 'formula', expr: DUE_AT_EXPR },
                    notify_due_date: { kind: 'formula', expr: DUE_DATE_EXPR },
                    data_categories: { kind: 'formula', expr: 'form.data_categories' },
                    people_affected: { kind: 'formula', expr: 'form.people_affected' },
                    containment: { kind: 'formula', expr: 'form.containment' },
                    // Not assessed yet — but Art. 33(1) presumes the obligation
                    // until someone writes down why it does not apply, so the
                    // "due now" counter picks this up from the first minute.
                    severity: { kind: 'static', value: 'unassessed' },
                    authority_required: { kind: 'static', value: true },
                    stage: { kind: 'static', value: 'reported' },
                    outcome: { kind: 'static', value: 'pending' },
                    // currentUser IS populated server-side, so the register knows
                    // who raised it — a Nextcloud user included.
                    reported_by: { kind: 'formula', expr: 'currentUser.name' },
                },
            },
            {
                kind: 'create_record',
                tableId: 'tbl_bacts01',
                values: {
                    breach_id: { kind: 'formula', expr: 'vars.newbreach.id' },
                    breach_reference: { kind: 'formula', expr: 'form.reference' },
                    happened_at: { kind: 'formula', expr: 'form.became_aware_at' },
                    action_type: { kind: 'static', value: 'detected' },
                    summary: { kind: 'formula', expr: "concat('Breach reported: ', form.title)" },
                    actor_name: { kind: 'formula', expr: 'currentUser.name' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_brchs01' },
            { kind: 'refresh', tableId: 'tbl_bacts01' },
            { kind: 'reset_form', form: 'newbreach' },
            { kind: 'toast', message: 'Recorded. The 72 hours run from the moment you entered — assess the risk next.', tone: 'success' },
            { kind: 'navigate', screenId: 'scr_clock' },
        ],
    },

    // ── Assessment ─────────────────────────────────────────────────────────

    /**
     * THE JUDGEMENT THE REGISTER EXISTS TO EVIDENCE.
     *
     * The two obligations are derived from ONE explicit choice rather than
     * inferred from the severity tier: a server step cannot read another table,
     * so a rule keyed on `severity_levels.notify_authority` would be unwritable,
     * and a rule hard-coded per tier would silently mis-handle any tier the DPO
     * adds later. Asking who must be told is both simpler and truer to Art. 33(1)
     * / 34(1), which are about the risk, not about a label.
     *
     * "Nobody" is a complete, compliant outcome — recorded_only — and it lands
     * on the closed register with its reasoning attached.
     */
    act_assess: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.breach.id',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_brchs01',
                        recordId: { kind: 'formula', expr: 'vars.breach.id' },
                        values: {
                            severity: { kind: 'formula', expr: 'form.severity' },
                            risk_summary: { kind: 'formula', expr: 'form.risk_summary' },
                            people_affected: { kind: 'formula', expr: 'form.people_affected' },
                            records_affected: { kind: 'formula', expr: 'form.records_affected' },
                            data_categories: { kind: 'formula', expr: 'form.data_categories' },
                            special_categories: { kind: 'formula', expr: 'form.special_categories' },
                            authority_required: { kind: 'formula', expr: "form.notify_decision != 'nobody'" },
                            subjects_required: { kind: 'formula', expr: "form.notify_decision == 'authority_and_subjects'" },
                            outcome: { kind: 'formula', expr: "form.notify_decision == 'nobody' ? 'recorded_only' : 'pending'" },
                            stage: { kind: 'static', value: 'assessed' },
                            assessed_by: { kind: 'formula', expr: 'currentUser.name' },
                            assessed_at: { kind: 'formula', expr: 'now' },
                        },
                    },
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bacts01',
                        values: {
                            breach_id: { kind: 'formula', expr: 'vars.breach.id' },
                            breach_reference: { kind: 'formula', expr: 'vars.breach.reference' },
                            happened_at: { kind: 'formula', expr: 'now' },
                            action_type: { kind: 'static', value: 'assessed' },
                            summary: { kind: 'formula', expr: "concat('Assessed as ', form.severity, ' risk. To be told: ', form.notify_decision, '. ', form.risk_summary)" },
                            actor_name: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_brchs01' },
                    { kind: 'refresh', tableId: 'tbl_bacts01' },
                    { kind: 'reset_form', form: 'assess' },
                    { kind: 'toast', message: 'Assessment recorded, with its reasoning.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Open a breach from the register first.', tone: 'info' },
                ],
            },
        ],
    },

    // ── Notification: the authority (Art. 33) ──────────────────────────────

    /**
     * `authority_hours` is the proof. Both operands are stored timestamps — the
     * awareness time on the record and the notification time just typed — so the
     * number is reproducible from the register itself, not from when the button
     * was pressed. dateDiff floors, which rounds in the safe direction: 72.9
     * hours records as 72 and still shows as on time, so the late reason is a
     * question of the deadline, not of rounding.
     */
    act_authnote: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.breach.id',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_brchs01',
                        recordId: { kind: 'formula', expr: 'vars.breach.id' },
                        values: {
                            authority_notified_at: { kind: 'formula', expr: 'form.notified_at' },
                            authority_hours: { kind: 'formula', expr: "dateDiff(form.notified_at, vars.breach.became_aware_at, 'hour')" },
                            authority_reference: { kind: 'formula', expr: 'form.authority_reference' },
                            authority_late_reason: { kind: 'formula', expr: 'form.late_reason' },
                            authority_required: { kind: 'static', value: true },
                            stage: { kind: 'static', value: 'notified' },
                            outcome: { kind: 'static', value: 'notified_authority' },
                        },
                    },
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bacts01',
                        values: {
                            breach_id: { kind: 'formula', expr: 'vars.breach.id' },
                            breach_reference: { kind: 'formula', expr: 'vars.breach.reference' },
                            happened_at: { kind: 'formula', expr: 'form.notified_at' },
                            action_type: { kind: 'static', value: 'notified_authority' },
                            summary: { kind: 'formula', expr: "concat('Supervisory authority notified, ', toStr(dateDiff(form.notified_at, vars.breach.became_aware_at, 'hour')), ' hours after we became aware. Reference: ', default(form.authority_reference, 'not given yet'), '.')" },
                            actor_name: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_brchs01' },
                    { kind: 'refresh', tableId: 'tbl_bacts01' },
                    { kind: 'reset_form', form: 'authnotice' },
                    { kind: 'toast', message: 'Notification recorded, with the hours from awareness.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Open a breach from the register first.', tone: 'info' },
                ],
            },
        ],
    },

    /** Recorded, not notifiable — a compliant ending, with its ground on file. */
    act_notnotify: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.breach.id',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_brchs01',
                        recordId: { kind: 'formula', expr: 'vars.breach.id' },
                        values: {
                            authority_required: { kind: 'static', value: false },
                            subjects_required: { kind: 'static', value: false },
                            risk_summary: { kind: 'formula', expr: 'form.justification' },
                            outcome: { kind: 'static', value: 'recorded_only' },
                            stage: { kind: 'static', value: 'assessed' },
                            assessed_by: { kind: 'formula', expr: 'currentUser.name' },
                            assessed_at: { kind: 'formula', expr: 'now' },
                        },
                    },
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bacts01',
                        values: {
                            breach_id: { kind: 'formula', expr: 'vars.breach.id' },
                            breach_reference: { kind: 'formula', expr: 'vars.breach.reference' },
                            happened_at: { kind: 'formula', expr: 'form.decided_on' },
                            action_type: { kind: 'static', value: 'assessed' },
                            summary: { kind: 'formula', expr: "concat('Recorded, not notified — a risk to people is unlikely (Art. 33(1)). ', form.justification)" },
                            actor_name: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_brchs01' },
                    { kind: 'refresh', tableId: 'tbl_bacts01' },
                    { kind: 'reset_form', form: 'notnotifiable' },
                    { kind: 'toast', message: 'Recorded as not notifiable. It stays in the register — that is the compliance step.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Open a breach from the register first.', tone: 'info' },
                ],
            },
        ],
    },

    // ── Notification: the people affected (Art. 34) ────────────────────────

    act_subjnote: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.breach.id',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_brchs01',
                        recordId: { kind: 'formula', expr: 'vars.breach.id' },
                        values: {
                            subjects_notified_at: { kind: 'formula', expr: 'form.notified_at' },
                            subjects_method: { kind: 'formula', expr: 'form.method' },
                            subjects_required: { kind: 'static', value: true },
                            stage: { kind: 'static', value: 'notified' },
                            outcome: { kind: 'static', value: 'notified_all' },
                        },
                    },
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bacts01',
                        values: {
                            breach_id: { kind: 'formula', expr: 'vars.breach.id' },
                            breach_reference: { kind: 'formula', expr: 'vars.breach.reference' },
                            happened_at: { kind: 'formula', expr: 'form.notified_at' },
                            action_type: { kind: 'static', value: 'notified_subjects' },
                            summary: { kind: 'formula', expr: "concat('People affected told (', form.method, '). ', form.summary)" },
                            actor_name: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_brchs01' },
                    { kind: 'refresh', tableId: 'tbl_bacts01' },
                    { kind: 'reset_form', form: 'subjnotice' },
                    { kind: 'toast', message: 'Recorded that the people affected were told.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Open a breach from the register first.', tone: 'info' },
                ],
            },
        ],
    },

    act_subjexmpt: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.breach.id',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_brchs01',
                        recordId: { kind: 'formula', expr: 'vars.breach.id' },
                        values: {
                            subjects_required: { kind: 'static', value: false },
                            subjects_exempt_ground: { kind: 'formula', expr: 'form.ground' },
                            subjects_exempt_reason: { kind: 'formula', expr: 'form.reason' },
                        },
                    },
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bacts01',
                        values: {
                            breach_id: { kind: 'formula', expr: 'vars.breach.id' },
                            breach_reference: { kind: 'formula', expr: 'vars.breach.reference' },
                            happened_at: { kind: 'formula', expr: 'now' },
                            action_type: { kind: 'static', value: 'assessed' },
                            summary: { kind: 'formula', expr: "concat('People affected not told — exemption ', form.ground, ' (Art. 34(3)). ', form.reason)" },
                            actor_name: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_brchs01' },
                    { kind: 'refresh', tableId: 'tbl_bacts01' },
                    { kind: 'reset_form', form: 'subjexempt' },
                    { kind: 'toast', message: 'Exemption recorded. The ground is on file with its reasoning.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Open a breach from the register first.', tone: 'info' },
                ],
            },
        ],
    },

    // ── Action log and supporting records ──────────────────────────────────

    act_logadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.breach.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bacts01',
                        values: {
                            breach_id: { kind: 'formula', expr: 'vars.breach.id' },
                            breach_reference: { kind: 'formula', expr: 'vars.breach.reference' },
                            happened_at: { kind: 'formula', expr: 'form.happened_at' },
                            action_type: { kind: 'formula', expr: 'form.action_type' },
                            summary: { kind: 'formula', expr: 'form.summary' },
                            actor_name: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_bacts01' },
                    { kind: 'reset_form', form: 'newaction' },
                ],
                else: [
                    { kind: 'toast', message: 'Open a breach from the register first.', tone: 'info' },
                ],
            },
        ],
    },

    act_sysadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.breach.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bsys001',
                        values: {
                            breach_id: { kind: 'formula', expr: 'vars.breach.id' },
                            breach_reference: { kind: 'formula', expr: 'vars.breach.reference' },
                            name: { kind: 'formula', expr: 'form.name' },
                            party_role: { kind: 'formula', expr: 'form.party_role' },
                            data_held: { kind: 'formula', expr: 'form.data_held' },
                            told_us_at: { kind: 'formula', expr: 'form.told_us_at' },
                            contact: { kind: 'formula', expr: 'form.contact' },
                            contained: { kind: 'formula', expr: 'form.contained' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_bsys001' },
                    { kind: 'reset_form', form: 'newsystem' },
                ],
                else: [
                    { kind: 'toast', message: 'Open a breach from the register first.', tone: 'info' },
                ],
            },
        ],
    },

    act_sysdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Remove this system from the breach? The action log keeps whatever was written about it.', title: 'Remove system' },
            { kind: 'delete_record', tableId: 'tbl_bsys001', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_bsys001' },
        ],
    },

    // ── Closing ────────────────────────────────────────────────────────────

    /**
     * Closing preserves the outcome the assessment reached: a breach recorded as
     * not notifiable stays `recorded_only` rather than being flattened into
     * "closed", because the closed register has to be able to show WHY each case
     * ended the way it did.
     */
    act_close: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.breach.id',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_brchs01',
                        recordId: { kind: 'formula', expr: 'vars.breach.id' },
                        values: {
                            remediation: { kind: 'formula', expr: 'form.remediation' },
                            closed_on: { kind: 'formula', expr: 'form.closed_on' },
                            stage: { kind: 'static', value: 'closed' },
                        },
                    },
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bacts01',
                        values: {
                            breach_id: { kind: 'formula', expr: 'vars.breach.id' },
                            breach_reference: { kind: 'formula', expr: 'vars.breach.reference' },
                            happened_at: { kind: 'formula', expr: 'now' },
                            action_type: { kind: 'static', value: 'closed' },
                            summary: { kind: 'formula', expr: "concat('Case closed. Remediation: ', form.remediation)" },
                            actor_name: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_brchs01' },
                    { kind: 'refresh', tableId: 'tbl_bacts01' },
                    { kind: 'reset_form', form: 'closebreach' },
                    { kind: 'toast', message: 'Closed and filed in the register.', tone: 'success' },
                    { kind: 'navigate', screenId: 'scr_closed' },
                ],
                else: [
                    { kind: 'toast', message: 'Open a breach from the register first.', tone: 'info' },
                ],
            },
        ],
    },

    // ── Setup: the severity vocabulary ─────────────────────────────────────

    act_sevopen: { kind: 'open_modal', modalId: 'cmp_stmod' },

    act_sevadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_sevs001',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    guidance: { kind: 'formula', expr: 'form.guidance' },
                    notify_authority: { kind: 'formula', expr: 'form.notify_authority' },
                    notify_subjects: { kind: 'formula', expr: 'form.notify_subjects' },
                    color: { kind: 'formula', expr: 'form.color' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_stmod' },
            { kind: 'reset_form', form: 'newlevel' },
            { kind: 'refresh', tableId: 'tbl_sevs001' },
            { kind: 'toast', message: 'Added. The Assessment tab reads it straight away — the dropdown there is fixed in the app design.', tone: 'success' },
        ],
    },

    /** Inline edits on the Setup grid. `form` is the edited row. */
    act_sevsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_sevs001',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    guidance: { kind: 'formula', expr: 'form.guidance' },
                    notify_authority: { kind: 'formula', expr: 'form.notify_authority' },
                    notify_subjects: { kind: 'formula', expr: 'form.notify_subjects' },
                    color: { kind: 'formula', expr: 'form.color' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_sevs001' },
        ],
    },

    act_sevdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this severity level? Breaches already assessed at it keep the key, so they will show a tier that is no longer defined.', title: 'Delete severity level' },
            { kind: 'delete_record', tableId: 'tbl_sevs001', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_sevs001' },
        ],
    },
};

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'Data breach register',
        description: 'Articles 33 and 34, with the 72-hour clock running.',
        icon: 'ShieldCheck',
    },
    theme: { primary: '#B91C1C', ...THEME_DEFAULTS, density: 'compact', appearance: 'dark' },
    // Identity: the "midnight" incident console — dark, compact, Geist — for
    // the app that is literally a running clock. The red primary is an ACCENT
    // (stat edges, the banner header, urgent badges); the large surfaces stay
    // the dark theme's neutrals, so the register never reads as a wall of red.
    design: { preset: 'midnight', font: 'geist', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
    nav: {
        style: 'tabs',
        groups: [
            { id: 'nvg_response', label: 'Response', icon: 'AlertTriangle', screens: ['scr_clock', 'scr_report'] },
            { id: 'nvg_register', label: 'Register', icon: 'BookOpen', screens: ['scr_closed'] },
            { id: 'nvg_setup', label: 'Setup', icon: 'Settings', screens: ['scr_setup'] },
        ],
    },
    roles: [
        { id: 'dpo', name: 'Data protection officer' },
        { id: 'responder', name: 'Incident responder' },
        { id: 'reporter', name: 'Anyone who spots a breach' },
    ],
    /**
     * `filters` is NOT declared — it is reserved for filter_bar, which
     * republishes the whole object on every keystroke.
     */
    variables: [
        { name: 'breach', label: 'Open breach', type: 'record', default: null, description: 'The breach whose file is on screen. Only its id and reference are read after it is set — everything that can change is re-read live.' },
        { name: 'newbreach', label: 'Last recorded breach', type: 'record', default: null, description: 'The row the intake just created, so its first action-log entry can point at it.' },
    ],
    homeScreenId: 'scr_clock',
    screens: [
        SCREEN_CLOCK,
        SCREEN_REPORT,
        SCREEN_BREACH,
        SCREEN_CLOSED,
        SCREEN_SETUP,
    ],
    actions,
};

// ---------------------------------------------------------------------------
// Seed
//
// A register that looks like one somebody has been keeping: nine breaches
// spanning every state the app can be in — one just reported and unassessed,
// one whose 72 hours run out TODAY, one notified comfortably in time, one
// notified late WITH its reason on file, one recorded and correctly not
// notified, one assessed as not a breach at all, and two closed with the
// Article 34 decision going each way.
//
// Every `notify_due_at` is exactly awareness + 72 hours and every
// `authority_hours` is exactly the whole hours between the two timestamps on
// the row — the test file recomputes both with the real expression engine, so a
// hand-edited seed cannot quietly teach the wrong arithmetic.
//
// The organisations are invented and every address is at example.com. `$id` is
// a LOCAL alias, never a column; { $ref } points at a row seeded earlier.
// ---------------------------------------------------------------------------

const seed = {
    tbl_sevs001: [
        {
            key: 'unassessed', name: 'Not assessed', position: 1, color: 'neutral',
            notify_authority: true, notify_subjects: false,
            guidance: 'Nobody has judged the risk yet. The clock is running and the register assumes the authority must be notified until someone writes down why not.',
        },
        {
            key: 'none', name: 'No risk', position: 2, color: 'success',
            notify_authority: false, notify_subjects: false,
            guidance: 'Unlikely to result in a risk to the rights and freedoms of the people affected. Do not notify — record it here with the reasoning (Art. 33(5)).',
        },
        {
            key: 'low', name: 'Low risk', position: 3, color: 'info',
            notify_authority: true, notify_subjects: false,
            guidance: 'Some risk, limited in scope or consequence. Notify the authority within 72 hours; the people affected do not need to be told.',
        },
        {
            key: 'medium', name: 'Risk', position: 4, color: 'warning',
            notify_authority: true, notify_subjects: false,
            guidance: 'A real risk of distress, nuisance or minor financial loss. Notify the authority; tell the people affected if the picture worsens.',
        },
        {
            key: 'high', name: 'High risk', position: 5, color: 'danger',
            notify_authority: true, notify_subjects: true,
            guidance: 'Identity fraud, financial loss, discrimination, damage to reputation, or special-category data exposed. Notify the authority AND tell the people affected without undue delay (Art. 34).',
        },
    ],

    tbl_brchs01: [
        // ── Just reported, nobody has judged it yet ─────────────────────────
        {
            $id: 'br_usb', reference: 'BR-2026-017',
            title: 'Unencrypted USB stick missing from the archive room',
            description: 'A USB stick used for the 2024 payroll export cannot be found. Last seen during the archive move on 12 August. It is not known whether it was encrypted.',
            breach_type: 'confidentiality',
            occurred_at: '2026-08-12T00:00:00.000Z',
            became_aware_at: '2026-08-15T07:30:00.000Z',
            notify_due_at: '2026-08-18T07:30:00.000Z',
            notify_due_date: '2026-08-18',
            severity: 'unassessed',
            data_categories: 'Name, employee number, salary, bank account number',
            people_affected: 90,
            containment: 'Archive room searched, access log pulled, storage cupboard resealed.',
            authority_required: true,
            subjects_required: false,
            stage: 'reported',
            outcome: 'pending',
            reported_by: 'Facilities desk',
        },

        // ── The clock runs out TODAY ────────────────────────────────────────
        {
            $id: 'br_laptop', reference: 'BR-2026-016',
            title: 'Laptop stolen from a car in the station car park',
            description: 'A field adviser\'s laptop was taken from a locked car. Disk encryption was on but the device had been resumed from sleep, so it cannot be assumed the data was unintelligible.',
            breach_type: 'confidentiality',
            occurred_at: '2026-08-11T18:20:00.000Z',
            became_aware_at: '2026-08-12T09:05:00.000Z',
            notify_due_at: '2026-08-15T09:05:00.000Z',
            notify_due_date: '2026-08-15',
            severity: 'high',
            risk_summary: 'Client case notes for roughly 240 people, including two files containing health information. If the disk is readable this is a high risk of distress and of identity fraud.',
            people_affected: 240,
            records_affected: 240,
            data_categories: 'Name, address, date of birth, case notes, health information in two files',
            special_categories: true,
            assessed_by: 'Ilse Mertens',
            assessed_at: '2026-08-12T14:40:00.000Z',
            authority_required: true,
            subjects_required: true,
            stage: 'assessed',
            outcome: 'pending',
            reported_by: 'Ilse Mertens',
            containment: 'Account disabled, remote wipe issued (not yet confirmed), police report filed.',
        },

        // ── Notified in good time ───────────────────────────────────────────
        {
            $id: 'br_payroll', reference: 'BR-2026-015',
            title: 'Payroll file e-mailed to the wrong accountancy firm',
            description: 'The July payroll export was attached to a message addressed to Havenlicht Accountants instead of Havenzicht Accountants. The recipient confirmed deletion in writing.',
            breach_type: 'confidentiality',
            occurred_at: '2026-08-05T10:50:00.000Z',
            became_aware_at: '2026-08-05T11:20:00.000Z',
            notify_due_at: '2026-08-08T11:20:00.000Z',
            notify_due_date: '2026-08-08',
            severity: 'medium',
            risk_summary: 'One professional recipient, bound by confidentiality, who deleted the file and confirmed it. Financial data was exposed but the likelihood of misuse is low.',
            people_affected: 74,
            records_affected: 74,
            data_categories: 'Name, employee number, gross salary, bank account number',
            special_categories: false,
            assessed_by: 'Ilse Mertens',
            assessed_at: '2026-08-05T15:10:00.000Z',
            authority_required: true,
            authority_notified_at: '2026-08-06T09:15:00.000Z',
            authority_hours: 21,
            authority_reference: 'AP-2026-004412',
            subjects_required: false,
            stage: 'notified',
            outcome: 'notified_authority',
            reported_by: 'Payroll team',
            containment: 'Recall attempted, written deletion confirmation obtained the same day.',
        },

        // ── Notified LATE, with the reason on file ──────────────────────────
        {
            $id: 'br_ransom', reference: 'BR-2026-014',
            title: 'Ransomware on the document archive server',
            description: 'The archive server was encrypted by ransomware overnight. Documents were unreachable for four days. There is no evidence of exfiltration, but it could not be ruled out during the first days.',
            breach_type: 'availability',
            occurred_at: '2026-07-28T02:10:00.000Z',
            became_aware_at: '2026-07-28T06:30:00.000Z',
            notify_due_at: '2026-07-31T06:30:00.000Z',
            notify_due_date: '2026-07-31',
            severity: 'medium',
            risk_summary: 'Four days without access to client files delayed case handling. Forensics found no evidence that data left the network, but the scope could not be established within 72 hours.',
            people_affected: 1800,
            records_affected: 26400,
            data_categories: 'Name, address, contract documents, correspondence',
            special_categories: false,
            assessed_by: 'Ilse Mertens',
            assessed_at: '2026-08-01T09:00:00.000Z',
            authority_required: true,
            authority_notified_at: '2026-08-02T10:00:00.000Z',
            authority_hours: 123,
            authority_reference: 'AP-2026-004301',
            authority_late_reason: 'The scope of the encryption could not be established within 72 hours: the affected volumes were only readable after the forensic image completed on 1 August. A holding notification should have been sent within the deadline and was not; the incident procedure has been changed to require one.',
            subjects_required: false,
            stage: 'notified',
            outcome: 'notified_authority',
            reported_by: 'IT operations',
            containment: 'Server isolated the same morning, restored from the 27 July backup, credentials rotated.',
        },

        // ── Recorded, correctly NOT notified ────────────────────────────────
        {
            $id: 'br_letter', reference: 'BR-2026-013',
            title: 'Letter delivered to a former employee\'s old address',
            description: 'A pension statement was sent to an address the employee left in 2024. The letter came back unopened, stamped "return to sender", eleven days later.',
            breach_type: 'confidentiality',
            occurred_at: '2026-07-08T00:00:00.000Z',
            became_aware_at: '2026-07-20T14:00:00.000Z',
            notify_due_at: '2026-07-23T14:00:00.000Z',
            notify_due_date: '2026-07-23',
            severity: 'none',
            risk_summary: 'One letter, returned unopened and destroyed on receipt. The envelope was intact, so nobody other than the postal service handled the contents. No risk to the person is likely, so no notification is made — this record is the compliance step under Art. 33(5).',
            people_affected: 1,
            records_affected: 1,
            data_categories: 'Name, address, pension accrual',
            special_categories: false,
            assessed_by: 'Ilse Mertens',
            assessed_at: '2026-07-20T16:20:00.000Z',
            authority_required: false,
            subjects_required: false,
            stage: 'closed',
            outcome: 'recorded_only',
            reported_by: 'HR administration',
            containment: 'Returned letter destroyed under supervision; address corrected in the HR system.',
            remediation: 'The mailing run now takes addresses from the HR system at the moment of printing instead of from a quarterly export.',
            closed_on: '2026-07-22',
        },

        // ── Assessed as not a personal data breach at all ───────────────────
        {
            $id: 'br_test', reference: 'BR-2026-012',
            title: 'Test export shared in a public project channel',
            description: 'A developer posted an export in an open channel, believing it contained live customer rows. Review showed the file was the synthetic test fixture.',
            breach_type: 'confidentiality',
            occurred_at: '2026-07-09T08:20:00.000Z',
            became_aware_at: '2026-07-09T08:45:00.000Z',
            notify_due_at: '2026-07-12T08:45:00.000Z',
            notify_due_date: '2026-07-12',
            severity: 'none',
            risk_summary: 'Every row in the file came from the generated test fixture; no row related to an identifiable person. It is therefore not a personal data breach, and the register keeps the finding so the question does not have to be answered twice.',
            people_affected: 0,
            records_affected: 0,
            data_categories: 'Synthetic test records only',
            special_categories: false,
            assessed_by: 'Ilse Mertens',
            assessed_at: '2026-07-09T11:30:00.000Z',
            authority_required: false,
            subjects_required: false,
            stage: 'closed',
            outcome: 'not_a_breach',
            reported_by: 'Development team',
            containment: 'Message removed from the channel within the hour.',
            remediation: 'Exports are now written to a folder that cannot be attached to a public channel.',
            closed_on: '2026-07-10',
        },

        // ── High risk, people told by public communication ──────────────────
        {
            $id: 'br_portal', reference: 'BR-2026-011',
            title: 'Portal bug showed order history to the wrong customer',
            description: 'A caching fault in the customer portal served one account\'s order history to another for roughly five hours. Log analysis identified 412 sessions in which a mismatched page was rendered.',
            breach_type: 'confidentiality',
            occurred_at: '2026-06-30T08:00:00.000Z',
            became_aware_at: '2026-06-30T13:10:00.000Z',
            notify_due_at: '2026-07-03T13:10:00.000Z',
            notify_due_date: '2026-07-03',
            severity: 'high',
            risk_summary: 'Order history reveals what people bought and where it was delivered, which for part of the catalogue is sensitive by inference. Individual notification was not possible because the logs identify sessions rather than accounts.',
            people_affected: 412,
            records_affected: 412,
            data_categories: 'Name, delivery address, order history',
            special_categories: false,
            assessed_by: 'Ilse Mertens',
            assessed_at: '2026-06-30T17:45:00.000Z',
            authority_required: true,
            authority_notified_at: '2026-07-01T16:45:00.000Z',
            authority_hours: 27,
            authority_reference: 'AP-2026-003988',
            subjects_required: true,
            subjects_notified_at: '2026-07-03T09:00:00.000Z',
            subjects_method: 'public',
            stage: 'closed',
            outcome: 'notified_all',
            reported_by: 'Portal support',
            containment: 'Cache layer disabled within twenty minutes of the report; sessions invalidated.',
            remediation: 'Per-account cache keys, plus a regression test that fails when a response is cacheable across sessions.',
            closed_on: '2026-07-20',
        },

        // ── High risk, people NOT told: Art. 34(3)(a) ───────────────────────
        {
            $id: 'br_tape', reference: 'BR-2026-010',
            title: 'Backup tape lost in transit between data centres',
            description: 'A courier could not account for one of four tapes in a scheduled transfer. The tape holds a full nightly backup, encrypted at rest.',
            breach_type: 'confidentiality',
            occurred_at: '2026-06-17T00:00:00.000Z',
            became_aware_at: '2026-06-18T07:55:00.000Z',
            notify_due_at: '2026-06-21T07:55:00.000Z',
            notify_due_date: '2026-06-21',
            severity: 'high',
            risk_summary: 'A full backup is a high risk on its face. The tape is encrypted with AES-256 and the keys are held in a separate hardware module that never leaves the primary site, so the data is unintelligible to anyone who finds it.',
            people_affected: 21000,
            records_affected: 21000,
            data_categories: 'Full customer database: names, addresses, contract and invoice data',
            special_categories: false,
            assessed_by: 'Ilse Mertens',
            assessed_at: '2026-06-18T12:00:00.000Z',
            authority_required: true,
            authority_notified_at: '2026-06-20T09:00:00.000Z',
            authority_hours: 49,
            authority_reference: 'AP-2026-003740',
            subjects_required: false,
            subjects_exempt_ground: 'encryption',
            subjects_exempt_reason: 'The tape is encrypted with AES-256; the keys live in a hardware security module at the primary site and were never in transit. The data is therefore unintelligible to any person not authorised to access it, so Article 34(3)(a) applies. The assessment and the key custody record are attached to this file.',
            stage: 'closed',
            outcome: 'notified_authority',
            reported_by: 'IT operations',
            containment: 'Courier audit opened; the remaining three tapes were accounted for and re-sealed.',
            remediation: 'Tape transport replaced by an encrypted site-to-site replica; physical transfers stopped entirely.',
            closed_on: '2026-07-04',
        },

        // ── Open, inside the deadline, waiting on a processor ───────────────
        {
            $id: 'br_mail', reference: 'BR-2026-018',
            title: 'Newsletter sent with all recipients in the To field',
            description: 'A mailing to the customer newsletter list went out with every address in the To field instead of Bcc. The mailing platform is run by a processor, Nimbusveld Mailing BV, who reported it to us.',
            breach_type: 'confidentiality',
            occurred_at: '2026-08-14T09:30:00.000Z',
            became_aware_at: '2026-08-14T16:40:00.000Z',
            notify_due_at: '2026-08-17T16:40:00.000Z',
            notify_due_date: '2026-08-17',
            severity: 'low',
            risk_summary: 'Each recipient can see the e-mail addresses of the other 318. The list is a general newsletter and reveals nothing beyond an interest in the company, so the risk is limited to nuisance and to unwanted contact.',
            people_affected: 319,
            records_affected: 319,
            data_categories: 'E-mail address, first name',
            special_categories: false,
            assessed_by: 'Ilse Mertens',
            assessed_at: '2026-08-14T18:05:00.000Z',
            authority_required: true,
            subjects_required: false,
            stage: 'assessed',
            outcome: 'pending',
            reported_by: 'Marketing',
            containment: 'Mailing stopped after the first batch; the processor confirmed no further batches were sent.',
        },
    ],

    tbl_bsys001: [
        { breach_id: { $ref: 'br_mail' }, breach_reference: 'BR-2026-018', name: 'Nimbusveld Mailing BV', party_role: 'processor', data_held: 'Newsletter list: e-mail addresses and first names', told_us_at: '2026-08-14T16:40:00.000Z', contact: 'privacy@nimbusveld.example.com', contained: true },
        { breach_id: { $ref: 'br_mail' }, breach_reference: 'BR-2026-018', name: 'Marketing website (own)', party_role: 'own_system', data_held: 'Subscription records feeding the list', contained: true },
        { breach_id: { $ref: 'br_laptop' }, breach_reference: 'BR-2026-016', name: 'Field adviser laptop LT-0442', party_role: 'own_system', data_held: 'Offline copies of client case notes', contained: false },
        { breach_id: { $ref: 'br_ransom' }, breach_reference: 'BR-2026-014', name: 'Archive server ARC-01', party_role: 'own_system', data_held: 'Contract documents and correspondence, 2016 onwards', contained: true },
        { breach_id: { $ref: 'br_ransom' }, breach_reference: 'BR-2026-014', name: 'Steenoever Hosting BV', party_role: 'processor', data_held: 'Hosts the archive server and its backups', told_us_at: '2026-07-28T06:30:00.000Z', contact: 'security@steenoever.example.com', contained: true },
        { breach_id: { $ref: 'br_payroll' }, breach_reference: 'BR-2026-015', name: 'Havenlicht Accountants', party_role: 'recipient', data_held: 'Received the July payroll export in error', told_us_at: '2026-08-05T11:20:00.000Z', contact: 'kantoor@havenlicht.example.com', contained: true },
        { breach_id: { $ref: 'br_tape' }, breach_reference: 'BR-2026-010', name: 'Veldkoerier Logistiek', party_role: 'sub_processor', data_held: 'Transported the encrypted backup tapes', told_us_at: '2026-06-18T07:55:00.000Z', contact: 'meldpunt@veldkoerier.example.com', contained: false },
        { breach_id: { $ref: 'br_portal' }, breach_reference: 'BR-2026-011', name: 'Customer portal (own)', party_role: 'own_system', data_held: 'Order history pages served from a shared cache', contained: true },
    ],

    tbl_bacts01: [
        // BR-2026-018 — the open, low-risk one.
        { breach_id: { $ref: 'br_mail' }, breach_reference: 'BR-2026-018', happened_at: '2026-08-14T16:40:00.000Z', action_type: 'detected', summary: 'Nimbusveld Mailing BV reported that the newsletter went out with all recipients in the To field. Our 72 hours run from this moment (Art. 33(2)).', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_mail' }, breach_reference: 'BR-2026-018', happened_at: '2026-08-14T16:55:00.000Z', action_type: 'contained', summary: 'Processor stopped the run after the first batch; remaining batches cancelled and confirmed in writing.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_mail' }, breach_reference: 'BR-2026-018', happened_at: '2026-08-14T18:05:00.000Z', action_type: 'assessed', summary: 'Assessed as low risk: a general newsletter list, exposure limited to e-mail addresses and first names. Authority to be notified; the people affected do not need to be told.', actor_name: 'Ilse Mertens' },

        // BR-2026-017 — reported this morning, nothing else yet.
        { breach_id: { $ref: 'br_usb' }, breach_reference: 'BR-2026-017', happened_at: '2026-08-15T07:30:00.000Z', action_type: 'detected', summary: 'Facilities reported that the payroll USB stick could not be located during the archive inventory.', actor_name: 'Facilities desk' },

        // BR-2026-016 — the one whose clock runs out today.
        { breach_id: { $ref: 'br_laptop' }, breach_reference: 'BR-2026-016', happened_at: '2026-08-12T09:05:00.000Z', action_type: 'detected', summary: 'Adviser reported the theft on arriving at the office; police report filed the same morning.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_laptop' }, breach_reference: 'BR-2026-016', happened_at: '2026-08-12T09:40:00.000Z', action_type: 'contained', summary: 'Account disabled and a remote wipe issued. The device has not checked in, so the wipe is unconfirmed.', actor_name: 'IT operations' },
        { breach_id: { $ref: 'br_laptop' }, breach_reference: 'BR-2026-016', happened_at: '2026-08-12T14:40:00.000Z', action_type: 'assessed', summary: 'Assessed as high risk: roughly 240 client files, two containing health information, on a device that may have been unlocked. Authority and the people affected both to be told.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_laptop' }, breach_reference: 'BR-2026-016', happened_at: '2026-08-14T11:00:00.000Z', action_type: 'note', summary: 'Draft notification prepared and the affected client list extracted. Waiting on the encryption status confirmation from the device management console.', actor_name: 'Ilse Mertens' },

        // BR-2026-015 — notified comfortably in time.
        { breach_id: { $ref: 'br_payroll' }, breach_reference: 'BR-2026-015', happened_at: '2026-08-05T11:20:00.000Z', action_type: 'detected', summary: 'Payroll noticed the recipient domain was wrong while filing the sent message.', actor_name: 'Payroll team' },
        { breach_id: { $ref: 'br_payroll' }, breach_reference: 'BR-2026-015', happened_at: '2026-08-05T12:05:00.000Z', action_type: 'communication', summary: 'Havenlicht Accountants contacted; they confirmed deletion in writing the same afternoon.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_payroll' }, breach_reference: 'BR-2026-015', happened_at: '2026-08-06T09:15:00.000Z', action_type: 'notified_authority', summary: 'Supervisory authority notified, 21 hours after we became aware. Reference: AP-2026-004412.', actor_name: 'Ilse Mertens' },

        // BR-2026-014 — the late one, and why.
        { breach_id: { $ref: 'br_ransom' }, breach_reference: 'BR-2026-014', happened_at: '2026-07-28T06:30:00.000Z', action_type: 'detected', summary: 'Monitoring alerted on the archive share becoming unreadable; ransom note found on the volume root.', actor_name: 'IT operations' },
        { breach_id: { $ref: 'br_ransom' }, breach_reference: 'BR-2026-014', happened_at: '2026-07-28T07:15:00.000Z', action_type: 'contained', summary: 'Server isolated from the network and the forensic image started.', actor_name: 'IT operations' },
        { breach_id: { $ref: 'br_ransom' }, breach_reference: 'BR-2026-014', happened_at: '2026-08-01T09:00:00.000Z', action_type: 'assessed', summary: 'Forensics completed: no evidence of exfiltration. Assessed as a risk on availability grounds; authority to be notified, people affected not.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_ransom' }, breach_reference: 'BR-2026-014', happened_at: '2026-08-02T10:00:00.000Z', action_type: 'notified_authority', summary: 'Supervisory authority notified, 123 hours after we became aware, with the reasons for the delay. Reference: AP-2026-004301.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_ransom' }, breach_reference: 'BR-2026-014', happened_at: '2026-08-04T15:30:00.000Z', action_type: 'remediation', summary: 'Incident procedure changed: a holding notification now goes out within 72 hours whenever the scope is still open.', actor_name: 'Ilse Mertens' },

        // BR-2026-013 — recorded, not notifiable.
        { breach_id: { $ref: 'br_letter' }, breach_reference: 'BR-2026-013', happened_at: '2026-07-20T14:00:00.000Z', action_type: 'detected', summary: 'Returned pension statement received in the post room, envelope intact.', actor_name: 'HR administration' },
        { breach_id: { $ref: 'br_letter' }, breach_reference: 'BR-2026-013', happened_at: '2026-07-20T16:20:00.000Z', action_type: 'assessed', summary: 'Recorded, not notified — a risk to the person is unlikely (Art. 33(1)). One letter, returned unopened and destroyed under supervision.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_letter' }, breach_reference: 'BR-2026-013', happened_at: '2026-07-22T10:00:00.000Z', action_type: 'closed', summary: 'Case closed. Remediation: the mailing run now reads addresses from the HR system at print time.', actor_name: 'Ilse Mertens' },

        // BR-2026-011 — public communication under Art. 34(3)(c).
        { breach_id: { $ref: 'br_portal' }, breach_reference: 'BR-2026-011', happened_at: '2026-06-30T13:10:00.000Z', action_type: 'detected', summary: 'Two customers reported seeing an order that was not theirs; the caching fault was confirmed within the hour.', actor_name: 'Portal support' },
        { breach_id: { $ref: 'br_portal' }, breach_reference: 'BR-2026-011', happened_at: '2026-06-30T13:30:00.000Z', action_type: 'contained', summary: 'Cache layer disabled and all sessions invalidated.', actor_name: 'IT operations' },
        { breach_id: { $ref: 'br_portal' }, breach_reference: 'BR-2026-011', happened_at: '2026-07-01T16:45:00.000Z', action_type: 'notified_authority', summary: 'Supervisory authority notified, 27 hours after we became aware. Reference: AP-2026-003988.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_portal' }, breach_reference: 'BR-2026-011', happened_at: '2026-07-03T09:00:00.000Z', action_type: 'notified_subjects', summary: 'People affected told by public communication: a notice on the portal and on the front page, because the logs identify sessions rather than accounts (Art. 34(3)(c)).', actor_name: 'Ilse Mertens' },

        // BR-2026-010 — Art. 34(3)(a) encryption exemption.
        { breach_id: { $ref: 'br_tape' }, breach_reference: 'BR-2026-010', happened_at: '2026-06-18T07:55:00.000Z', action_type: 'detected', summary: 'Veldkoerier Logistiek reported that one of four tapes could not be accounted for on delivery.', actor_name: 'IT operations' },
        { breach_id: { $ref: 'br_tape' }, breach_reference: 'BR-2026-010', happened_at: '2026-06-20T09:00:00.000Z', action_type: 'notified_authority', summary: 'Supervisory authority notified, 49 hours after we became aware. Reference: AP-2026-003740.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_tape' }, breach_reference: 'BR-2026-010', happened_at: '2026-06-20T11:20:00.000Z', action_type: 'assessed', summary: 'People affected not told — exemption encryption (Art. 34(3)). AES-256 at rest with keys held in an HSM that never left the primary site.', actor_name: 'Ilse Mertens' },
        { breach_id: { $ref: 'br_tape' }, breach_reference: 'BR-2026-010', happened_at: '2026-07-04T14:00:00.000Z', action_type: 'closed', summary: 'Case closed. Remediation: physical tape transport replaced by encrypted site-to-site replication.', actor_name: 'Ilse Mertens' },

        // BR-2026-012 — not a breach.
        { breach_id: { $ref: 'br_test' }, breach_reference: 'BR-2026-012', happened_at: '2026-07-09T08:45:00.000Z', action_type: 'detected', summary: 'Developer self-reported posting what they believed was a live export in an open channel.', actor_name: 'Development team' },
        { breach_id: { $ref: 'br_test' }, breach_reference: 'BR-2026-012', happened_at: '2026-07-09T11:30:00.000Z', action_type: 'assessed', summary: 'File reviewed row by row: entirely synthetic test data, no identifiable person. Not a personal data breach; recorded so the question is answered once.', actor_name: 'Ilse Mertens' },
    ],
};

module.exports = {
    id: 'app-breach-register',
    version: 1,
    title: 'Data breach register',
    description: 'GDPR Articles 33 and 34 with the 72-hour clock on the front page: report a breach, assess the risk, notify the authority and the people affected in time, and keep the evidence that you did — including for the breaches you correctly decided not to notify.',
    category: 'Compliance',
    icon: 'ShieldCheck',
    tags: ['gdpr', 'avg', 'datalek', 'data breach', 'article 33', 'article 34', 'incident', 'compliance'],
    definition,
    dataModel,
    seed,
};
