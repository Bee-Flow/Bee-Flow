/**
 * App Studio template — AI system register (EU AI Act).
 *
 * The inventory the AI Act assumes every organisation already keeps: which AI
 * systems it operates, what each one is for, which risk tier it falls in, who
 * exercises human oversight over it, what happened when one went wrong, and
 * when it was last assessed. In practice this is a spreadsheet a compliance
 * officer maintains from memory — which is exactly the document that should not
 * be sitting in someone else's cloud.
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS ────────────────────────────────
 *
 * "UNCLASSIFIED" IS A TIER, NOT A MISSING VALUE.
 *
 * Risk tiers are TEXT KEYS pointing at a `risk_tiers` config table, so the
 * compliance officer owns the vocabulary rather than a developer (a `select`
 * field's options live in the data model, and the data model is only editable
 * from the builder — the wrong person and the wrong risk for what is plainly
 * configuration). That much mirrors the Sprint template.
 *
 * The consequence that shapes this whole file is what happens to a system
 * nobody has classified yet. The tidy modelling answer is NULL, and NULL is
 * invisible: it drops out of a group-by, it disappears from a board, and the
 * one system nobody has looked at is the one the register stops mentioning.
 * So `unclassified` is a SEEDED TIER — red, first in the order, with real copy
 * in its obligations column — and it is the DEFAULT a newly registered system
 * gets. It therefore has a column on the triage board, a count on the register,
 * a colour, and a place in every chart. The dangerous case is the loud one.
 *
 * The second half of the same decision: the Annex III USE CASES are a config
 * table too, and each use case carries the tier it triggers (`default_tier`).
 * Picking the use case on a system IS classifying it — which is how the
 * decision is actually made in practice, and it means the classification rule
 * is data the officer can correct, not a branch in an action.
 *
 * ── CONSTRAINTS THAT SHAPED THIS FILE (none of them obvious) ────────────────
 *
 *  • NO JOINS. Every read compiles to `FROM <one table>`; a filter or sort may
 *    only name the bound table's own columns. An incident therefore cannot show
 *    its system's name by following `system_id`, so `system_name` is
 *    DENORMALISED onto incidents, oversight and assessments, and every action
 *    that sets the relation writes the copy in the same step. Same for
 *    `use_case_name` on a system. They are display copies and are treated as
 *    such.
 *
 *  • A BINDING FILTER FORMULA may only read currentUser / vars / forms /
 *    screen / today. Anything else makes the fetch layer and the read-side
 *    cache key diverge and the component loads forever. Every dynamic filter
 *    here goes through `vars` — or through `today`, which is what the two
 *    deadline counters on the register and the incident screen compare against.
 *
 *  • THE SERVER'S formula scope is a strict subset of the browser's: a
 *    create/update/delete step sees form, vars, item, value, currentUser, now
 *    and today, and NOT screen/forms/actions/records. Nothing here reads
 *    `screen.params`: it resolves in preview and writes NULL in production.
 *
 *  • A WRITE DOES NOT UPDATE THE VARIABLE YOU CLICKED. `vars.system` is the row
 *    the user picked, and it goes stale the moment anything writes to that row.
 *    So the System screen shows the system through a LIVE `record` binding
 *    filtered on `id == vars.system.id` — the variable supplies identity only.
 *    That is why classifying a system makes the header field change in front of
 *    you instead of after a navigation. (`record` bindings ignore `recordId`
 *    and take the first row of the filter, so the id goes in the filter.)
 *
 *  • ONE `filter_bar` PER SCREEN, and it publishes to the single hardcoded
 *    `vars.filters`. There is exactly one in this app, on the register. The
 *    incident screen uses column filters and grid search instead, because a
 *    second bar would share that one variable and the two screens would leak
 *    each other's filters.
 *
 *  • A `height:'fill'` section stretches its FIRST grid row only, so every
 *    screen is one auto-height header section plus one fill section whose
 *    children are a single 12-column row.
 *
 *  • An aggregate binding with no explicit `limit` is silently capped at 50.
 *
 * ── WHAT THIS TEMPLATE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * No count of oversight rows or assessments ON the system row. It would need an
 * aggregate grouped by a parent the row does not carry, and a stored
 * denormalised total would drift the moment anyone edited a child. A system
 * with nobody watching it is found by opening it, and by the register's
 * "reviews overdue" counter, which is honest and always current.
 *
 * No delete on systems or incidents for anyone but the compliance officer, and
 * none at all on incidents for a system owner. A statutory register in which a
 * business owner can quietly remove an entry is not a register.
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
// Three roles, and the split is the real one around a compliance register:
// the officer owns the vocabulary and the record, the business owner keeps
// their own systems honest, and an auditor may read everything and change
// nothing. `default:'role'` inverts the default to deny, so each grant below is
// a decision rather than an oversight. The app owner is never listed —
// resolveScope short-circuits them to full access.
// ---------------------------------------------------------------------------

/**
 * The vocabularies: tiers and Annex III use cases. Only the compliance officer
 * may change what the words MEAN — everyone else reads them, because a system
 * owner quietly renaming "high" would silently reclassify other people's
 * systems.
 */
const ACCESS_VOCABULARY = {
    default: 'role',
    roles: {
        officer: { read: 'all', create: true, update: 'all', delete: 'all' },
        contributor: { read: 'all', create: false, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * The register itself. A system owner may add a system and keep any system's
 * facts current — an inventory that only one person may edit is an inventory
 * that is wrong. Deleting is the officer's alone: removing an entry is a
 * decision about the completeness of a statutory record.
 */
const ACCESS_SYSTEMS = {
    default: 'role',
    roles: {
        officer: { read: 'all', create: true, update: 'all', delete: 'all' },
        contributor: { read: 'all', create: true, update: 'all', delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * Incidents. Append-mostly on purpose: a contributor may file one and correct
 * their OWN filing, never someone else's and never by deletion. Article 73
 * turns some of these into a notification to a supervisory authority, and a
 * report you can erase afterwards is worth nothing as evidence.
 */
const ACCESS_INCIDENTS = {
    default: 'role',
    roles: {
        officer: { read: 'all', create: true, update: 'all', delete: 'all' },
        contributor: { read: 'all', create: true, update: 'own', delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * Oversight arrangements and assessments. A system owner records who watches
 * their system and what came out of a review, and may withdraw an entry they
 * added themselves — a mistyped reviewer is not an audit event.
 */
const ACCESS_EVIDENCE = {
    default: 'role',
    roles: {
        officer: { read: 'all', create: true, update: 'all', delete: 'all' },
        contributor: { read: 'all', create: true, update: 'all', delete: 'own' },
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
 * Where the system runs, phrased the way it matters for this product's buyers:
 * the question is not "cloud or not" but "whose infrastructure, under whose
 * jurisdiction".
 */
const HOSTING_OPTIONS = [
    { value: 'self_hosted', label: 'Self-hosted — our own infrastructure' },
    { value: 'external_eu', label: 'External vendor — hosted in the EU' },
    { value: 'external_other', label: 'External vendor — hosted outside the EU' },
];

/**
 * Provider or deployer. The AI Act hangs almost completely different duties on
 * these two words, so a register that does not say which one you are cannot
 * tell you what you owe.
 */
const OPERATOR_ROLE_OPTIONS = [
    { value: 'deployer', label: 'Deployer — we use it' },
    { value: 'provider', label: 'Provider — we built or rebranded it' },
    { value: 'both', label: 'Both' },
];

const STATUS_OPTIONS = [
    { value: 'planned', label: 'Planned' },
    { value: 'in_use', label: 'In use' },
    { value: 'paused', label: 'Paused' },
    { value: 'retired', label: 'Retired' },
];

/**
 * Incident severity, cut along the line that decides the REPORTING CLOCK rather
 * than along a generic low/medium/high. Article 73 gives a serious incident a
 * 15-day notification deadline, shortened to 10 days where a person died and to
 * 2 days for a widespread infringement or a serious and irreversible disruption
 * of critical infrastructure. Those three deadlines are the only reason to
 * distinguish the three "serious" values at all — see act_sysinadd.
 */
const SEVERITY_OPTIONS = [
    { value: 'minor', label: 'Minor — no reporting duty' },
    { value: 'significant', label: 'Significant — worth recording' },
    { value: 'serious', label: 'Serious incident (Art. 73) — report within 15 days' },
    { value: 'serious_death', label: 'Serious — a person died — report within 10 days' },
    { value: 'serious_infra', label: 'Serious — critical infrastructure or widespread infringement — report within 2 days' },
];

const INCIDENT_STATUS_OPTIONS = [
    { value: 'open', label: 'Open' },
    { value: 'investigating', label: 'Investigating' },
    { value: 'mitigated', label: 'Mitigated' },
    { value: 'closed', label: 'Closed' },
];

/** What the human watching the system is actually allowed to do about it. */
const AUTHORITY_OPTIONS = [
    { value: 'stop_system', label: 'May stop the system' },
    { value: 'override_output', label: 'May override an individual output' },
    { value: 'escalate_only', label: 'May only escalate' },
];

const FREQUENCY_OPTIONS = [
    { value: 'continuous', label: 'Every output' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'quarterly', label: 'Quarterly' },
];

const ASSESSMENT_TYPE_OPTIONS = [
    { value: 'fria', label: 'Fundamental-rights impact assessment (Art. 27)' },
    { value: 'conformity', label: 'Conformity assessment (Art. 43)' },
    { value: 'dpia', label: 'Data protection impact assessment (GDPR Art. 35)' },
    { value: 'periodic', label: 'Periodic review' },
];

const OUTCOME_OPTIONS = [
    { value: 'passed', label: 'Passed' },
    { value: 'passed_with_actions', label: 'Passed with actions' },
    { value: 'failed', label: 'Failed' },
    { value: 'not_applicable', label: 'Not applicable' },
];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const dataModel = {
    modelVersion: 1,
    roles: [
        { key: 'officer', label: 'Compliance officer' },
        { key: 'contributor', label: 'System owner' },
        { key: 'auditor', label: 'Auditor' },
    ],
    /**
     * An explicit null default, not 'contributor'. This register names who is
     * accountable for each system and carries incident narratives; opening the
     * app must grant nothing until someone has been given a role on purpose.
     * (canonicalizeDataModel preserves an explicit null — absent would mean
     * "the author never thought about roles" and would resolve to 'app'.)
     */
    roleMapping: { default: null, byGroup: {} },
    tables: [
        // ── The vocabularies ───────────────────────────────────────────────
        {
            id: 'tbl_tiers01',
            key: 'risk_tiers',
            name: 'Risk tiers',
            icon: 'Layers',
            access: ACCESS_VOCABULARY,
            fields: [
                // The KEY is what a system stores. Unique, because two tiers
                // sharing a key would merge two columns of the triage board and
                // quietly reclassify everything in one of them.
                { id: 'fld_trkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_trlbl01', key: 'label', type: 'text', required: true, unique: false },
                {
                    id: 'fld_trcol01', key: 'color', type: 'select', required: false, unique: false,
                    options: COLOR_OPTIONS, default: 'neutral',
                },
                { id: 'fld_trsum01', key: 'summary', type: 'text', required: false, unique: false },
                // What the tier actually obliges you to do, in the officer's own
                // words. Markdown, because the honest answer to "what does high
                // risk mean" is a list, not a sentence.
                { id: 'fld_trobl01', key: 'obligations', type: 'richtext', required: false, unique: false },
                // How often a system in this tier has to be looked at again.
                // Read by a human on the triage screen rather than by a
                // scheduler: the register records the policy, the review date on
                // the system records the decision.
                { id: 'fld_trrev01', key: 'review_months', type: 'number', subtype: 'integer', required: false, unique: false, default: 12 },
                // false for the prohibited tier. A tier you may not operate in
                // is a different kind of fact from a tier that is merely
                // onerous, and the triage screen says so out loud.
                { id: 'fld_trprm01', key: 'permitted', type: 'bool', required: false, unique: false, default: true },
                { id: 'fld_trpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_usecase1',
            key: 'use_cases',
            name: 'Use cases',
            icon: 'BookOpen',
            access: ACCESS_VOCABULARY,
            fields: [
                { id: 'fld_uckey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_ucnam01', key: 'name', type: 'text', required: true, unique: false },
                // 'Annex III, 4(a)' — or 'Article 50' for the transparency
                // cases, which is why this is free text and not an Annex III
                // point number.
                { id: 'fld_ucleg01', key: 'legal_reference', type: 'text', required: false, unique: false },
                { id: 'fld_ucare01', key: 'area', type: 'text', required: false, unique: false },
                // THE CLASSIFICATION RULE, as data. Picking a use case on a
                // system copies this into the system's risk_tier — which is how
                // the tier is decided in practice, and it keeps the rule
                // correctable by the officer instead of frozen into an action.
                { id: 'fld_uctie01', key: 'default_tier', type: 'text', required: true, unique: false, default: 'high' },
                { id: 'fld_ucdes01', key: 'description', type: 'text', required: false, unique: false },
                { id: 'fld_ucpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },

        // ── The register ───────────────────────────────────────────────────
        {
            id: 'tbl_aisys01',
            key: 'ai_systems',
            name: 'AI systems',
            icon: 'Boxes',
            access: ACCESS_SYSTEMS,
            fields: [
                { id: 'fld_asnam01', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_aspur01', key: 'purpose', type: 'text', required: true, unique: false },
                // Accountability is a ROLE here, never a person's private
                // details: "HR operations lead" survives someone leaving, and a
                // register is not a place to accumulate personal data of its own.
                { id: 'fld_asown01', key: 'business_owner', type: 'text', required: false, unique: false },
                { id: 'fld_asoem01', key: 'business_owner_email', type: 'text', required: false, unique: false },
                { id: 'fld_asdep01', key: 'department', type: 'text', required: false, unique: false },
                { id: 'fld_asven01', key: 'provider_vendor', type: 'text', required: false, unique: false },
                { id: 'fld_asmod01', key: 'model_or_service', type: 'text', required: false, unique: false },
                {
                    id: 'fld_ashos01', key: 'hosting', type: 'select', required: false, unique: false,
                    options: HOSTING_OPTIONS, default: 'self_hosted',
                },
                {
                    id: 'fld_asopr01', key: 'operator_role', type: 'select', required: false, unique: false,
                    options: OPERATOR_ROLE_OPTIONS, default: 'deployer',
                },
                {
                    id: 'fld_asstat1', key: 'status', type: 'select', required: false, unique: false,
                    options: STATUS_OPTIONS, default: 'planned',
                },
                { id: 'fld_assvc01', key: 'in_service_date', type: 'date', required: false, unique: false },
                // The key into risk_tiers. Text, not select — see the header.
                // The default is 'unclassified', which is a REAL tier: a system
                // enters the register visibly unclassified rather than invisibly
                // null.
                { id: 'fld_astie01', key: 'risk_tier', type: 'text', required: false, unique: false, default: 'unclassified' },
                { id: 'fld_asuci01', key: 'use_case_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_usecase1' } },
                // DENORMALISED display copy of the use case's name. There are no
                // joins, so the register grid and the triage cards can only show
                // a column the row itself carries.
                { id: 'fld_asucn01', key: 'use_case_name', type: 'text', required: false, unique: false },
                // Article 50: are the people meeting this system told that they
                // are meeting a machine?
                { id: 'fld_astra01', key: 'transparency_notice', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_asgpa01', key: 'general_purpose_model', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_aspii01', key: 'personal_data', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_aslas01', key: 'last_assessed_on', type: 'date', required: false, unique: false },
                { id: 'fld_asrev01', key: 'next_review_due', type: 'date', required: false, unique: false },
                { id: 'fld_asnot01', key: 'notes', type: 'richtext', required: false, unique: false },
            ],
        },

        // ── The evidence ───────────────────────────────────────────────────
        {
            id: 'tbl_overs01',
            key: 'human_oversight',
            name: 'Human oversight',
            icon: 'UserCheck',
            access: ACCESS_EVIDENCE,
            fields: [
                { id: 'fld_hosys01', key: 'system_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_aisys01' } },
                { id: 'fld_hosnm01', key: 'system_name', type: 'text', required: false, unique: false },
                { id: 'fld_horev01', key: 'reviewer', type: 'text', required: true, unique: false },
                { id: 'fld_hoeml01', key: 'reviewer_email', type: 'text', required: false, unique: false },
                {
                    id: 'fld_hopow01', key: 'authority', type: 'select', required: false, unique: false,
                    options: AUTHORITY_OPTIONS, default: 'override_output',
                },
                {
                    id: 'fld_hofrq01', key: 'frequency', type: 'select', required: false, unique: false,
                    options: FREQUENCY_OPTIONS, default: 'weekly',
                },
                { id: 'fld_hopro01', key: 'procedure', type: 'text', required: false, unique: false },
                // Article 26(2): oversight has to be exercised by someone with
                // the competence and the authority to do it. An untrained
                // reviewer is a name on a form.
                { id: 'fld_hotra01', key: 'trained', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_hocnf01', key: 'last_confirmed_on', type: 'date', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_incid01',
            key: 'incidents',
            name: 'Incidents',
            icon: 'AlertTriangle',
            access: ACCESS_INCIDENTS,
            fields: [
                { id: 'fld_insys01', key: 'system_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_aisys01' } },
                { id: 'fld_insnm01', key: 'system_name', type: 'text', required: false, unique: false },
                { id: 'fld_intit01', key: 'title', type: 'text', required: true, unique: false },
                { id: 'fld_inocc01', key: 'occurred_on', type: 'date', required: false, unique: false },
                // THE CLOCK STARTS HERE. Article 73 counts from the moment the
                // operator became AWARE of the incident, not from the moment it
                // happened — an incident found three months late is still
                // reportable within the deadline from today.
                { id: 'fld_inawr01', key: 'became_aware_on', type: 'date', required: false, unique: false },
                {
                    id: 'fld_insev01', key: 'severity', type: 'select', required: false, unique: false,
                    options: SEVERITY_OPTIONS, default: 'minor',
                },
                { id: 'fld_indes01', key: 'description', type: 'text', required: true, unique: false },
                { id: 'fld_inact01', key: 'action_taken', type: 'text', required: false, unique: false },
                {
                    id: 'fld_instat1', key: 'status', type: 'select', required: false, unique: false,
                    options: INCIDENT_STATUS_OPTIONS, default: 'open',
                },
                // Stored, not computed at read time: the deadline is a fact
                // about the day you became aware, and recomputing it later from
                // an edited date would silently move a statutory date that has
                // already been communicated.
                { id: 'fld_indue01', key: 'report_due_on', type: 'date', required: false, unique: false },
                { id: 'fld_inrep01', key: 'reported_on', type: 'date', required: false, unique: false },
                { id: 'fld_inaut01', key: 'authority_reference', type: 'text', required: false, unique: false },
                { id: 'fld_inlog01', key: 'logged_by', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_asmnt01',
            key: 'assessments',
            name: 'Assessments',
            icon: 'FileCheck',
            access: ACCESS_EVIDENCE,
            fields: [
                { id: 'fld_avsys01', key: 'system_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_aisys01' } },
                { id: 'fld_avsnm01', key: 'system_name', type: 'text', required: false, unique: false },
                {
                    id: 'fld_avtyp01', key: 'assessment_type', type: 'select', required: false, unique: false,
                    options: ASSESSMENT_TYPE_OPTIONS, default: 'periodic',
                },
                { id: 'fld_avprf01', key: 'performed_on', type: 'date', required: false, unique: false },
                { id: 'fld_avaut01', key: 'performed_by', type: 'text', required: false, unique: false },
                {
                    id: 'fld_avout01', key: 'outcome', type: 'select', required: false, unique: false,
                    options: OUTCOME_OPTIONS, default: 'passed',
                },
                { id: 'fld_avfnd01', key: 'findings', type: 'text', required: false, unique: false },
                { id: 'fld_avnxt01', key: 'next_due_on', type: 'date', required: false, unique: false },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Shared vocabularies for the SCREENS.
//
// These literal lists are the one seam in the config-as-data story:
// `filter_bar.options`, `data_grid.columns` and `input_select.options` are
// author-time lists, not bindings. A tier added on Setup therefore grows a
// column on the triage board (whose columns ARE bound) but does not appear in
// the register's tier dropdown until an editor adds it. That is a platform
// limit, not a modelling choice, and the Setup screen says so rather than
// leaving someone to discover it.
// ---------------------------------------------------------------------------

const TIER_TONES = [
    { value: 'unclassified', label: 'Unclassified', tone: 'danger' },
    { value: 'prohibited', label: 'Prohibited', tone: 'danger' },
    { value: 'high', label: 'High risk', tone: 'warning' },
    { value: 'limited', label: 'Limited risk', tone: 'info' },
    { value: 'minimal', label: 'Minimal risk', tone: 'success' },
];

const TIER_FILTER_OPTIONS = TIER_TONES.map((t) => ({ value: t.value, label: t.label }));

const STATUS_FILTER_OPTIONS = STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label }));

const HOSTING_FILTER_OPTIONS = HOSTING_OPTIONS.map((h) => ({ value: h.value, label: h.label }));

const STATUS_TONES = [
    { value: 'in_use', label: 'In use', tone: 'success' },
    { value: 'planned', label: 'Planned', tone: 'info' },
    { value: 'paused', label: 'Paused', tone: 'warning' },
    { value: 'retired', label: 'Retired', tone: 'neutral' },
];

/**
 * The triage board's cards. Three facts, because a card that shows only a name
 * cannot be triaged: who is accountable, whose infrastructure it runs on, and
 * when it is next due a look.
 */
const SYSTEM_CARD_FIELDS = [
    { key: 'business_owner', label: 'Accountable', slot: 'meta', format: 'text' },
    { key: 'hosting', label: 'Hosting', slot: 'meta', format: 'text' },
    { key: 'next_review_due', label: 'Review due', slot: 'chip', format: 'date' },
];

/** The one system on screen, read LIVE rather than from the stale variable. */
const OPEN_SYSTEM = {
    kind: 'record',
    tableId: 'tbl_aisys01',
    filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.system.id' }, required: true }],
    limit: 1,
};

/** Child rows of the open system. Required: with nothing open, show nothing. */
const forOpenSystem = (tableId, sort, limit) => ({
    kind: 'records',
    tableId,
    filter: [{ field: 'system_id', op: 'eq', value: { kind: 'formula', expr: 'vars.system.id' }, required: true }],
    sort,
    limit,
});

// ==================================================================
// REGISTER — the list everyone asks for, and the first screen on open.
// ==================================================================
const SCREEN_REGISTER = {
    id: 'scr_register',
    name: 'Register',
    icon: 'Table',
    showInNav: true,
    maxWidth: 'full',
    description: 'Every AI system this organisation operates.',
    sections: [
        {
            id: 'sec_regtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_reghdr',
                    type: 'page_header',
                    props: {
                        look: 'banner',
                        title: 'AI system register (verwerkingsregister voor AI-systemen)',
                        subtitle: 'What we run, what it is for, and which risk tier it falls in. A new system enters unclassified on purpose — classifying it is a decision someone has to make.',
                        icon: 'Table',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_regnew',
                            type: 'button',
                            props: { label: 'Register a system', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_regopen',
                        },
                        {
                            id: 'cmp_regrem',
                            type: 'button',
                            props: { label: 'Chase overdue reviews', variant: 'ghost', iconLeft: 'Mail', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_regremind',
                        },
                    ],
                },
                {
                    id: 'cmp_regfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search', type: 'search', options: [] },
                            { name: 'tier', label: 'Risk tier', type: 'select', options: TIER_FILTER_OPTIONS },
                            { name: 'status', label: 'Status', type: 'select', options: STATUS_FILTER_OPTIONS },
                            { name: 'hosting', label: 'Hosting', type: 'select', options: HOSTING_FILTER_OPTIONS },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
                {
                    id: 'cmp_regs1',
                    type: 'stat',
                    props: {
                        look: 'gradient',
                        label: 'Systems on the register',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_aisys01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            limit: 1,
                        },
                        caption: 'including planned and retired',
                        icon: 'Boxes',
                        positiveIsGood: true,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_regs2',
                    type: 'stat',
                    props: {
                        look: 'gradient',
                        label: 'High risk',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_aisys01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'risk_tier', op: 'eq', value: 'high' }],
                            limit: 1,
                        },
                        caption: 'Chapter III obligations apply',
                        icon: 'ShieldCheck',
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    // The number this whole template exists to make visible.
                    id: 'cmp_regs3',
                    type: 'stat',
                    props: {
                        look: 'gradient',
                        label: 'Unclassified',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_aisys01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'risk_tier', op: 'eq', value: 'unclassified' }],
                            limit: 1,
                        },
                        caption: 'nobody has decided yet — start on Triage',
                        icon: 'AlertTriangle',
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_regs4',
                    type: 'stat',
                    props: {
                        look: 'gradient',
                        label: 'Reviews overdue',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_aisys01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            // `today` is one of the few roots a binding filter
                            // may read, which is what makes an overdue counter
                            // expressible without an automation.
                            filter: [{ field: 'next_review_due', op: 'lt', value: { kind: 'formula', expr: 'today' } }],
                            limit: 1,
                        },
                        caption: 'past the date the tier asks for',
                        icon: 'CalendarClock',
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
            ],
        },
        {
            // ONE row of children: a fill section stretches its first row only.
            id: 'sec_regmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_reggrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_aisys01',
                            // Every clause is OPTIONAL, and an optional filter
                            // whose formula resolves to null is omitted whole.
                            // So the register opens showing everything, and the
                            // bar narrows it — no empty first screen.
                            filter: [
                                { field: 'name', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                { field: 'risk_tier', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.tier' }, required: false },
                                { field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.status' }, required: false },
                                { field: 'hosting', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.hosting' }, required: false },
                            ],
                            sort: [{ field: 'name', dir: 'asc' }],
                            limit: 300,
                        },
                        columns: [
                            { key: 'name', label: 'System', format: 'text', width: 240, sortable: true, filterable: true, editable: false },
                            { key: 'risk_tier', label: 'Risk tier', format: 'badge', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'use_case_name', label: 'Use case', format: 'text', width: 240, sortable: true, filterable: true, editable: false },
                            { key: 'status', label: 'Status', format: 'badge', width: 110, sortable: true, filterable: true, editable: true },
                            { key: 'operator_role', label: 'Our role', format: 'badge', width: 120, sortable: true, filterable: true, editable: true },
                            { key: 'hosting', label: 'Hosting', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'provider_vendor', label: 'Provider', format: 'text', width: 170, sortable: true, filterable: true, editable: false },
                            { key: 'business_owner', label: 'Accountable', format: 'text', width: 180, sortable: true, filterable: true, editable: true },
                            { key: 'next_review_due', label: 'Review due', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                        ],
                        pageSize: 25,
                        // Inline editing needs selectable:'none' — with a
                        // selection mode set, onRowSelect fires with the
                        // selected rows instead of the edited one.
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Open', actionId: 'act_regrow' }],
                        look: 'striped',
                        density: 'compact',
                        zebra: true,
                        emptyText: 'Nothing on the register yet — register the first system.',
                    },
                    style: { span: 12, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_regsave',
                },
            ],
        },
        {
            id: 'sec_regdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_regmodal',
                    type: 'modal',
                    props: { title: 'Register an AI system', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_regform',
                            type: 'form',
                            props: { name: 'newsystem', submitLabel: 'Add to the register', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_regcreate',
                            children: [
                                { id: 'cmp_regf1', type: 'input_text', props: { name: 'name', label: 'System name', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_regf2', type: 'input_text', props: { name: 'department', label: 'Department', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_regf3', type: 'input_textarea', props: { name: 'purpose', label: 'What is it used for?', required: true, rows: 3, placeholder: 'The decision or task it takes part in, in one or two sentences.' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_regf4', type: 'input_text', props: { name: 'business_owner', label: 'Accountable role', required: false, inputType: 'text', placeholder: 'e.g. HR operations lead — a role, not a person' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_regf5', type: 'input_text', props: { name: 'business_owner_email', label: 'Contact address', required: false, inputType: 'email' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_regf6', type: 'input_text', props: { name: 'provider_vendor', label: 'Provider or vendor', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_regf7', type: 'input_text', props: { name: 'model_or_service', label: 'Model or service used', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                {
                                    id: 'cmp_regf8', type: 'input_select',
                                    props: { name: 'hosting', label: 'Where does it run?', required: true, options: HOSTING_OPTIONS, defaultValue: 'self_hosted' },
                                    style: { span: 6 }, visible: true,
                                },
                                {
                                    id: 'cmp_regf9', type: 'input_select',
                                    props: { name: 'operator_role', label: 'Are we the provider or the deployer?', required: true, options: OPERATOR_ROLE_OPTIONS, defaultValue: 'deployer' },
                                    style: { span: 6 }, visible: true,
                                },
                                {
                                    id: 'cmp_regf10', type: 'input_select',
                                    props: { name: 'status', label: 'Status', required: true, options: STATUS_OPTIONS, defaultValue: 'planned' },
                                    style: { span: 6 }, visible: true,
                                },
                                { id: 'cmp_regf11', type: 'input_date', props: { name: 'in_service_date', label: 'In service since', required: false }, style: { span: 6 }, visible: true },
                                { id: 'cmp_regf12', type: 'input_checkbox', props: { name: 'personal_data', label: 'It processes personal data', defaultChecked: false }, style: { span: 12 }, visible: true },
                                { id: 'cmp_regf13', type: 'input_checkbox', props: { name: 'general_purpose_model', label: 'It is built on a general-purpose AI model (GPAI)', defaultChecked: false }, style: { span: 12 }, visible: true },
                                {
                                    id: 'cmp_regnote', type: 'callout',
                                    props: {
                                        title: 'It will land unclassified',
                                        text: 'That is deliberate. Open it on **Triage** and pick the use case it matches — the use case carries the tier it triggers.',
                                        tone: 'info',
                                    },
                                    style: { span: 12 }, visible: true,
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
// TRIAGE — where the emptiness is impossible to miss.
// ==================================================================
const SCREEN_TRIAGE = {
    id: 'scr_triage',
    name: 'Triage',
    icon: 'Layers',
    showInNav: true,
    maxWidth: 'full',
    description: 'Systems by risk tier — unclassified first.',
    sections: [
        {
            id: 'sec_trtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_trhdr',
                    type: 'page_header',
                    props: {
                        title: 'Risk triage (risicoclassificatie)',
                        subtitle: 'Drag a system into the tier it belongs to. The first column is everything nobody has decided about yet.',
                        icon: 'Layers',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_trnote',
                    type: 'callout',
                    props: {
                        title: 'Unclassified is not a neutral state',
                        text: 'A system nobody has classified is a system nobody has checked against Article 5 or Annex III. It sits in the red column until someone decides — which is the whole point of the column being there.',
                        tone: 'warning',
                    },
                    style: { span: 9 },
                    visible: true,
                },
                {
                    id: 'cmp_trstat',
                    type: 'stat',
                    props: {
                        label: 'Waiting on a decision',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_aisys01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'risk_tier', op: 'eq', value: 'unclassified' }],
                            limit: 1,
                        },
                        caption: 'systems, right now',
                        icon: 'AlertTriangle',
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_trmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_trtiers',
                    type: 'list',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_tiers01', sort: [{ field: 'position', dir: 'asc' }], limit: 24 },
                        titleKey: 'label',
                        subtitleKey: 'summary',
                        metaKey: 'key',
                        badgeKey: 'key',
                        badgeToneMap: TIER_TONES,
                        // selectedWhen is a formula = a BARE STRING here, not a
                        // {kind:'formula'} wrapper.
                        selectedWhen: 'item.id == vars.tier.id',
                        icon: 'Layers',
                        emptyText: 'No tiers configured — add them on Setup.',
                    },
                    style: { span: 3, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_trpick',
                },
                {
                    id: 'cmp_trboard',
                    type: 'kanban',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_aisys01',
                            sort: [{ field: 'name', dir: 'asc' }],
                            limit: 300,
                        },
                        groupByField: 'risk_tier',
                        // THE BOARD IS ITS CONFIG TABLE. A tier added on Setup
                        // grows a column here, in position order, with the
                        // colour the officer chose — no builder, no deploy.
                        columnsSource: {
                            kind: 'records',
                            tableId: 'tbl_tiers01',
                            sort: [{ field: 'position', dir: 'asc' }],
                            limit: 12,
                        },
                        columns: [],
                        // No swimlanes: a register has one axis that matters.
                        // Written out rather than left to the default, because
                        // the default is a BARE null and canonicalize would
                        // wrap it into a binding on the next save — a
                        // structural repair, which is a definition that does
                        // not round-trip.
                        swimlaneField: null,
                        swimlanes: [],
                        swimlanesSource: { kind: 'static', value: null },
                        titleKey: 'name',
                        subtitleKey: 'use_case_name',
                        badgeKey: 'status',
                        badgeToneMap: STATUS_TONES,
                        cardFields: SYSTEM_CARD_FIELDS,
                        colorKey: 'hosting',
                        cardColorMap: [
                            { value: 'self_hosted', label: 'Self-hosted', tone: 'success' },
                            { value: 'external_eu', label: 'Vendor, EU', tone: 'info' },
                            { value: 'external_other', label: 'Vendor, outside the EU', tone: 'warning' },
                        ],
                        collapsible: true,
                        emptyText: 'Nothing on the register yet.',
                        allowDrag: true,
                    },
                    style: { span: 9, height: 'fill' },
                    visible: true,
                    onCardMove: 'act_trmove',
                    onRowClick: 'act_trcard',
                },
            ],
        },
        {
            id: 'sec_trtier',
            style: { padding: 4, gap: 3, background: 'panel' },
            children: [
                {
                    id: 'cmp_trobl',
                    type: 'record_detail',
                    props: {
                        // Read live rather than from vars.tier, so an obligation
                        // edited on Setup shows here after the refresh instead of
                        // whatever the click captured.
                        source: {
                            kind: 'record',
                            tableId: 'tbl_tiers01',
                            filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.tier.id' }, required: true }],
                            limit: 1,
                        },
                        columns: 2,
                        fields: [
                            { key: 'label', label: 'Tier', format: 'badge' },
                            { key: 'key', label: 'Stored as', format: 'text' },
                            { key: 'summary', label: 'In one line', format: 'text' },
                            { key: 'review_months', label: 'Re-check every (months)', format: 'number' },
                            { key: 'obligations', label: 'What it obliges us to do', format: 'markdown' },
                        ],
                        emptyText: 'Pick a tier on the left to read what it obliges you to do.',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// SYSTEM — one system in full: classification, oversight, incidents, reviews.
// ==================================================================
const SCREEN_SYSTEM = {
    id: 'scr_system',
    name: 'System',
    icon: 'Box',
    showInNav: false,
    maxWidth: 'wide',
    description: 'One AI system in full.',
    sections: [
        {
            id: 'sec_systop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_syshdr',
                    type: 'page_header',
                    props: {
                        title: 'AI system',
                        titleFrom: { kind: 'formula', expr: 'vars.system.name' },
                        subtitleFrom: { kind: 'formula', expr: 'vars.system.purpose' },
                        icon: 'Box',
                        showDivider: true,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sysback',
                            type: 'button',
                            props: { label: 'Back to the register', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_sysback',
                        },
                    ],
                },
                {
                    id: 'cmp_sysdet',
                    type: 'record_detail',
                    props: {
                        // OPEN_SYSTEM, not vars.system: classification writes to
                        // this row, and a stale variable would keep showing the
                        // old tier until the screen was left and re-entered.
                        source: OPEN_SYSTEM,
                        columns: 3,
                        fields: [
                            { key: 'risk_tier', label: 'Risk tier', format: 'badge' },
                            { key: 'use_case_name', label: 'Use case', format: 'text' },
                            { key: 'status', label: 'Status', format: 'badge' },
                            { key: 'operator_role', label: 'Our role', format: 'badge' },
                            { key: 'hosting', label: 'Hosting', format: 'badge' },
                            { key: 'provider_vendor', label: 'Provider', format: 'text' },
                            { key: 'model_or_service', label: 'Model or service', format: 'text' },
                            { key: 'business_owner', label: 'Accountable', format: 'text' },
                            { key: 'business_owner_email', label: 'Contact', format: 'text' },
                            { key: 'in_service_date', label: 'In service since', format: 'date' },
                            { key: 'last_assessed_on', label: 'Last assessed', format: 'date' },
                            { key: 'next_review_due', label: 'Review due', format: 'date' },
                            { key: 'notes', label: 'Notes', format: 'markdown' },
                        ],
                        emptyText: 'Open a system from the register or the triage board.',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_sysmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_systabs',
                    type: 'tabs',
                    props: {},
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_systab1',
                            type: 'tab',
                            props: { label: 'Classification', icon: 'ShieldCheck' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_syscnot',
                                    type: 'callout',
                                    props: {
                                        title: 'Picking the use case sets the tier',
                                        text: 'Each use case carries the tier it triggers, so choosing the row that matches this system classifies it and records which Annex III point (or Article 50 duty) the classification rests on. Change the rule itself on Setup.',
                                        tone: 'info',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_syscase',
                                    type: 'list',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_usecase1', sort: [{ field: 'position', dir: 'asc' }], limit: 60 },
                                        titleKey: 'name',
                                        subtitleKey: 'description',
                                        metaKey: 'legal_reference',
                                        badgeKey: 'default_tier',
                                        badgeToneMap: TIER_TONES,
                                        selectedWhen: 'item.id == vars.system.use_case_id',
                                        icon: 'BookOpen',
                                        emptyText: 'No use cases configured — add them on Setup.',
                                    },
                                    style: { span: 12, height: 'lg' },
                                    visible: true,
                                    onRowClick: 'act_syscase',
                                },
                            ],
                        },
                        {
                            id: 'cmp_systab2',
                            type: 'tab',
                            props: { label: 'Human oversight', icon: 'UserCheck' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sysovg',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenSystem('tbl_overs01', [{ field: 'reviewer', dir: 'asc' }], 50),
                                        columns: [
                                            { key: 'reviewer', label: 'Who reviews', format: 'text', width: 200, sortable: true, filterable: true, editable: true },
                                            { key: 'reviewer_email', label: 'Contact', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'authority', label: 'May do', format: 'badge', width: 170, sortable: true, filterable: true, editable: true },
                                            { key: 'frequency', label: 'How often', format: 'badge', width: 120, sortable: true, filterable: true, editable: true },
                                            { key: 'trained', label: 'Trained', format: 'boolean', width: 90, sortable: false, filterable: false, editable: true },
                                            { key: 'last_confirmed_on', label: 'Confirmed', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                                            { key: 'procedure', label: 'How', format: 'text', width: 320, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'Nobody is recorded as watching this system. For a high-risk system that is a finding, not a blank.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sysovsave',
                                },
                                {
                                    id: 'cmp_sysovf',
                                    type: 'form',
                                    props: { name: 'newoversight', submitLabel: 'Record this reviewer', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_sysovadd',
                                    children: [
                                        { id: 'cmp_sysov1', type: 'input_text', props: { name: 'reviewer', label: 'Who reviews the output', required: true, inputType: 'text', placeholder: 'A role — e.g. Recruitment team lead' }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_sysov2', type: 'input_text', props: { name: 'reviewer_email', label: 'Contact address', required: false, inputType: 'email' }, style: { span: 4 }, visible: true },
                                        {
                                            id: 'cmp_sysov3', type: 'input_select',
                                            props: { name: 'authority', label: 'What may they do?', required: true, options: AUTHORITY_OPTIONS, defaultValue: 'override_output' },
                                            style: { span: 4 }, visible: true,
                                        },
                                        {
                                            id: 'cmp_sysov4', type: 'input_select',
                                            props: { name: 'frequency', label: 'How often', required: true, options: FREQUENCY_OPTIONS, defaultValue: 'weekly' },
                                            style: { span: 4 }, visible: true,
                                        },
                                        { id: 'cmp_sysov5', type: 'input_date', props: { name: 'last_confirmed_on', label: 'Arrangement confirmed on', required: false, defaultValue: 'today' }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_sysov6', type: 'input_checkbox', props: { name: 'trained', label: 'They have been trained on this system', defaultChecked: false }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_sysov7', type: 'input_textarea', props: { name: 'procedure', label: 'How the review actually happens', required: false, rows: 2 }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                        {
                            id: 'cmp_systab3',
                            type: 'tab',
                            props: { label: 'Incidents', icon: 'AlertTriangle' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sysing',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenSystem('tbl_incid01', [{ field: 'became_aware_on', dir: 'desc' }], 100),
                                        columns: [
                                            { key: 'became_aware_on', label: 'Aware since', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                                            { key: 'title', label: 'What happened', format: 'text', width: 320, sortable: false, filterable: true, editable: false },
                                            { key: 'severity', label: 'Severity', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'status', label: 'Status', format: 'badge', width: 120, sortable: true, filterable: true, editable: true },
                                            { key: 'report_due_on', label: 'Report due', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                                            { key: 'reported_on', label: 'Reported', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No incidents recorded for this system.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sysinsave',
                                },
                                {
                                    id: 'cmp_sysinf',
                                    type: 'form',
                                    props: { name: 'newincident', submitLabel: 'Log the incident', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_sysinadd',
                                    children: [
                                        { id: 'cmp_sysin1', type: 'input_text', props: { name: 'title', label: 'What happened', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                        { id: 'cmp_sysin2', type: 'input_date', props: { name: 'occurred_on', label: 'It happened on', required: false }, style: { span: 4 }, visible: true },
                                        // Defaults to today, because the usual
                                        // case is "we just found out" — and this
                                        // date, not the one above, starts the
                                        // Article 73 clock.
                                        { id: 'cmp_sysin3', type: 'input_date', props: { name: 'became_aware_on', label: 'We became aware on', required: true, defaultValue: 'today' }, style: { span: 4 }, visible: true },
                                        {
                                            id: 'cmp_sysin4', type: 'input_select',
                                            props: { name: 'severity', label: 'Severity', required: true, options: SEVERITY_OPTIONS, defaultValue: 'minor' },
                                            style: { span: 4 }, visible: true,
                                        },
                                        { id: 'cmp_sysin5', type: 'input_textarea', props: { name: 'description', label: 'What went wrong, and to whom', required: true, rows: 3 }, style: { span: 12 }, visible: true },
                                        { id: 'cmp_sysin6', type: 'input_textarea', props: { name: 'action_taken', label: 'What was done about it', required: false, rows: 2 }, style: { span: 12 }, visible: true },
                                        {
                                            id: 'cmp_sysinno', type: 'callout',
                                            props: {
                                                title: 'The reporting deadline is set for you',
                                                text: 'Pick a serious severity and the register computes the Article 73 deadline from the date you became aware: 15 days normally, 10 where a person died, 2 for a widespread infringement or a serious disruption of critical infrastructure.',
                                                tone: 'warning',
                                            },
                                            style: { span: 12 }, visible: true,
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            id: 'cmp_systab4',
                            type: 'tab',
                            props: { label: 'Assessments', icon: 'FileCheck' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sysasg',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenSystem('tbl_asmnt01', [{ field: 'performed_on', dir: 'desc' }], 50),
                                        columns: [
                                            { key: 'performed_on', label: 'Done on', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                                            { key: 'assessment_type', label: 'Type', format: 'badge', width: 220, sortable: true, filterable: true, editable: false },
                                            { key: 'outcome', label: 'Outcome', format: 'badge', width: 150, sortable: true, filterable: true, editable: true },
                                            { key: 'performed_by', label: 'By', format: 'text', width: 160, sortable: false, filterable: true, editable: true },
                                            { key: 'next_due_on', label: 'Next due', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                                            { key: 'findings', label: 'Findings', format: 'text', width: 340, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'This system has never been assessed.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sysassave',
                                },
                                {
                                    id: 'cmp_sysasf',
                                    type: 'form',
                                    props: { name: 'newassessment', submitLabel: 'Record the assessment', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_sysasadd',
                                    children: [
                                        {
                                            id: 'cmp_sysas1', type: 'input_select',
                                            props: { name: 'assessment_type', label: 'Kind of review', required: true, options: ASSESSMENT_TYPE_OPTIONS, defaultValue: 'periodic' },
                                            style: { span: 4 }, visible: true,
                                        },
                                        { id: 'cmp_sysas2', type: 'input_date', props: { name: 'performed_on', label: 'Carried out on', required: true, defaultValue: 'today' }, style: { span: 4 }, visible: true },
                                        {
                                            id: 'cmp_sysas3', type: 'input_select',
                                            props: { name: 'outcome', label: 'Outcome', required: true, options: OUTCOME_OPTIONS, defaultValue: 'passed' },
                                            style: { span: 4 }, visible: true,
                                        },
                                        { id: 'cmp_sysas4', type: 'input_text', props: { name: 'performed_by', label: 'Carried out by', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_sysas5', type: 'input_date', props: { name: 'next_due_on', label: 'Next one due', required: false }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_sysas6', type: 'input_textarea', props: { name: 'findings', label: 'Findings and actions', required: false, rows: 3 }, style: { span: 12 }, visible: true },
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
// INCIDENTS — the reporting clock, across every system.
// ==================================================================
const SCREEN_INCIDENTS = {
    id: 'scr_incident',
    name: 'Incidents',
    icon: 'AlertTriangle',
    showInNav: true,
    maxWidth: 'full',
    description: 'What went wrong, and what still has to be reported.',
    sections: [
        {
            id: 'sec_intop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_inhdr',
                    type: 'page_header',
                    props: {
                        title: 'Incidents (ernstige incidenten)',
                        subtitle: 'Log incidents on the system itself. This screen is where you see which ones are still owed to a supervisory authority.',
                        icon: 'AlertTriangle',
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
                        title: 'Article 73 — reporting a serious incident',
                        text: 'The deadline runs from the day you became **aware**, not the day it happened: 15 days as a rule, 10 days where a person died, 2 days for a widespread infringement or a serious and irreversible disruption of critical infrastructure. Record the notification here so the register shows it was made.',
                        tone: 'warning',
                    },
                    style: { span: 6 },
                    visible: true,
                },
                {
                    id: 'cmp_ins1',
                    type: 'stat',
                    props: {
                        label: 'Still open',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_incid01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'status', op: 'in', value: ['open', 'investigating'] }],
                            limit: 1,
                        },
                        caption: 'open or under investigation',
                        icon: 'Inbox',
                        positiveIsGood: false,
                    },
                    style: { span: 2 },
                    visible: true,
                },
                {
                    id: 'cmp_ins2',
                    type: 'stat',
                    props: {
                        label: 'Notification owed',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_incid01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            // A deadline exists only on a serious incident, so
                            // "has a due date and no notification" IS the set of
                            // outstanding reports — no second severity clause.
                            filter: [
                                { field: 'report_due_on', op: 'isNotNull' },
                                { field: 'reported_on', op: 'isNull' },
                            ],
                            limit: 1,
                        },
                        caption: 'serious, not yet reported',
                        icon: 'FileText',
                        positiveIsGood: false,
                    },
                    style: { span: 2 },
                    visible: true,
                },
                {
                    id: 'cmp_ins3',
                    type: 'stat',
                    props: {
                        label: 'Past the deadline',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_incid01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'report_due_on', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                                { field: 'reported_on', op: 'isNull' },
                            ],
                            limit: 1,
                        },
                        caption: 'report these today',
                        icon: 'Timer',
                        positiveIsGood: false,
                    },
                    style: { span: 2 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_inmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_ingrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_incid01',
                            sort: [{ field: 'became_aware_on', dir: 'desc' }],
                            limit: 300,
                        },
                        columns: [
                            { key: 'became_aware_on', label: 'Aware since', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                            // The denormalised copy — there is no join to follow
                            // system_id, so the register writes the name onto the
                            // incident when it is logged.
                            { key: 'system_name', label: 'System', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                            { key: 'title', label: 'What happened', format: 'text', width: 320, sortable: false, filterable: true, editable: false },
                            { key: 'severity', label: 'Severity', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'status', label: 'Status', format: 'badge', width: 130, sortable: true, filterable: true, editable: true },
                            { key: 'report_due_on', label: 'Report due', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                            { key: 'reported_on', label: 'Reported on', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                            { key: 'authority_reference', label: 'Authority ref.', format: 'text', width: 150, sortable: false, filterable: true, editable: true },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [
                            { label: 'Open', actionId: 'act_inopen' },
                            { label: 'Record notification', actionId: 'act_inreport' },
                        ],
                        look: 'striped',
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No incidents recorded. Log one from the system it happened on.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_insave',
                },
                {
                    id: 'cmp_inchart',
                    type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_incid01',
                            groupBy: [{ field: 'system_name', as: 'system' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'incidents' }],
                            sort: [{ field: 'incidents', dir: 'desc' }],
                            limit: 12,
                        },
                        title: 'Incidents per system',
                        xKey: 'system',
                        series: [{ key: 'incidents', label: 'Incidents', color: 'danger' }],
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
        {
            id: 'sec_indlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_inmodal',
                    type: 'modal',
                    props: { title: 'Incident', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_indet',
                            type: 'record_detail',
                            props: {
                                source: {
                                    kind: 'record',
                                    tableId: 'tbl_incid01',
                                    filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.incident.id' }, required: true }],
                                    limit: 1,
                                },
                                columns: 2,
                                fields: [
                                    { key: 'system_name', label: 'System', format: 'text' },
                                    { key: 'title', label: 'What happened', format: 'text' },
                                    { key: 'occurred_on', label: 'Occurred on', format: 'date' },
                                    { key: 'became_aware_on', label: 'We became aware on', format: 'date' },
                                    { key: 'severity', label: 'Severity', format: 'badge' },
                                    { key: 'status', label: 'Status', format: 'badge' },
                                    { key: 'report_due_on', label: 'Report due (Art. 73)', format: 'date' },
                                    { key: 'reported_on', label: 'Reported on', format: 'date' },
                                    { key: 'authority_reference', label: 'Authority reference', format: 'text' },
                                    { key: 'logged_by', label: 'Logged by', format: 'text' },
                                    { key: 'description', label: 'Description', format: 'text' },
                                    { key: 'action_taken', label: 'Action taken', format: 'text' },
                                ],
                                emptyText: 'Open an incident from the list.',
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                        {
                            id: 'cmp_inbtn',
                            type: 'button',
                            props: { label: 'Record the notification as sent today', variant: 'primary', iconLeft: 'FileCheck', role: 'button' },
                            style: { span: 6 },
                            // Hidden once it has been reported: a button that
                            // would overwrite a statutory date with today's is
                            // not a button anyone should be offered twice.
                            visible: { kind: 'formula', expr: 'vars.incident.id && !vars.incident.reported_on' },
                            onClick: 'act_inrepdlg',
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// SETUP — the vocabulary the whole app reads.
// ==================================================================
const SCREEN_SETUP = {
    id: 'scr_setup',
    name: 'Setup',
    icon: 'TableProperties',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Risk tiers and Annex III use cases.',
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
                        subtitle: 'The tiers and the use cases are data, not code. Add a tier and the triage board grows a column; change a use case\'s tier and the next system classified against it follows the new rule.',
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
                        title: 'Two things to know',
                        text: 'A tier added here appears on the triage board immediately, but the tier dropdown in the register\'s filter bar is a fixed list — it only grows when an editor adds it. And changing a use case\'s tier does not reclassify the systems already pointing at it: classification is a decision with a date on it, so it is re-made on the system, never rewritten underneath you.',
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
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sutab1',
                            type: 'tab',
                            props: { label: 'Risk tiers', icon: 'Layers' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sutiers',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_tiers01', sort: [{ field: 'position', dir: 'asc' }], limit: 24 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            // The key is NOT editable: every
                                            // system stores it, and there are no
                                            // joins to cascade a rename through.
                                            { key: 'key', label: 'Key', format: 'text', width: 130, sortable: true, filterable: true, editable: false },
                                            { key: 'label', label: 'Shown as', format: 'text', width: 150, sortable: false, filterable: false, editable: true },
                                            { key: 'color', label: 'Colour', format: 'badge', width: 110, sortable: false, filterable: false, editable: true },
                                            { key: 'permitted', label: 'May operate', format: 'boolean', width: 110, sortable: false, filterable: false, editable: true },
                                            { key: 'review_months', label: 'Review every (months)', format: 'number', width: 150, sortable: false, filterable: false, editable: true },
                                            { key: 'summary', label: 'In one line', format: 'text', width: 260, sortable: false, filterable: false, editable: true },
                                            { key: 'obligations', label: 'Obligations', format: 'text', width: 380, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No tiers configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sutsave',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab2',
                            type: 'tab',
                            props: { label: 'Use cases', icon: 'BookOpen' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sucases',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_usecase1', sort: [{ field: 'position', dir: 'asc' }], limit: 60 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Use case', format: 'text', width: 300, sortable: false, filterable: true, editable: true },
                                            { key: 'legal_reference', label: 'Legal reference', format: 'text', width: 160, sortable: true, filterable: true, editable: true },
                                            { key: 'area', label: 'Area', format: 'text', width: 150, sortable: true, filterable: true, editable: true },
                                            { key: 'default_tier', label: 'Triggers tier', format: 'badge', width: 130, sortable: true, filterable: true, editable: true },
                                            { key: 'description', label: 'Description', format: 'text', width: 360, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: true,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No use cases configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sucsave',
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_sunew',
            style: { padding: 4, gap: 3, background: 'surface' },
            children: [
                {
                    id: 'cmp_sutform',
                    type: 'form',
                    props: { name: 'newtier', submitLabel: 'Add tier', showReset: false, showSubmit: true },
                    style: { span: 6, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_sutier',
                    children: [
                        { id: 'cmp_sut1', type: 'input_text', props: { name: 'key', label: 'Key (stored on every system)', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                        { id: 'cmp_sut2', type: 'input_text', props: { name: 'label', label: 'Shown as', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                        {
                            id: 'cmp_sut3', type: 'input_select',
                            props: { name: 'color', label: 'Colour', required: true, options: COLOR_OPTIONS, defaultValue: 'neutral' },
                            style: { span: 6 }, visible: true,
                        },
                        { id: 'cmp_sut4', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 0, max: 99, step: 1, defaultValue: 9 }, style: { span: 6 }, visible: true },
                        { id: 'cmp_sut5', type: 'input_textarea', props: { name: 'obligations', label: 'What it obliges us to do', required: false, rows: 3 }, style: { span: 12 }, visible: true },
                    ],
                },
                {
                    id: 'cmp_sucform',
                    type: 'form',
                    props: { name: 'newusecase', submitLabel: 'Add use case', showReset: false, showSubmit: true },
                    style: { span: 6, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_sucase',
                    children: [
                        { id: 'cmp_suc1', type: 'input_text', props: { name: 'key', label: 'Key', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                        { id: 'cmp_suc2', type: 'input_text', props: { name: 'name', label: 'Use case', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                        { id: 'cmp_suc3', type: 'input_text', props: { name: 'legal_reference', label: 'Legal reference', required: false, inputType: 'text', placeholder: 'e.g. Annex III, 4(a)' }, style: { span: 6 }, visible: true },
                        { id: 'cmp_suc4', type: 'input_text', props: { name: 'area', label: 'Area', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                        {
                            id: 'cmp_suc5', type: 'input_select',
                            props: { name: 'default_tier', label: 'Triggers tier', required: true, options: TIER_FILTER_OPTIONS, defaultValue: 'high' },
                            style: { span: 6 }, visible: true,
                        },
                        { id: 'cmp_suc6', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 0, max: 99, step: 1, defaultValue: 90 }, style: { span: 6 }, visible: true },
                        { id: 'cmp_suc7', type: 'input_textarea', props: { name: 'description', label: 'Description', required: false, rows: 2 }, style: { span: 12 }, visible: true },
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
 * WHERE CONTEXT COMES FROM. A server step (create/update/delete_record) sees
 * `form`, `vars`, `item`, `value`, `currentUser`, `now` and `today` — and NOT
 * `screen`, `forms`, `actions` or `records`. So a write reads the event payload
 * (`form.*`, which for a grid row action is the whole row and for a card drag is
 * { item, value, lane, index, … }) or a variable an earlier client step set.
 * Nothing here reads `screen.params`: that resolves in preview and writes NULL
 * in production.
 *
 * WHY EVERY MUTATION ENDS IN `refresh`. Nothing invalidates a bound query after
 * a write, so without it a dragged system springs back to its old tier and a
 * newly filed incident does not appear. `refresh` names the table it dirtied.
 *
 * WHY THE DENORMALISED COPY IS ALWAYS WRITTEN IN THE SAME STEP. There are no
 * joins. Whenever an action sets `system_id` it also sets `system_name`, and
 * whenever it sets `use_case_id` it also sets `use_case_name` — one write, so
 * the copy cannot be forgotten and cannot lag.
 */
const actions = {
    // ── Register ───────────────────────────────────────────────────────────

    act_regopen: { kind: 'open_modal', modalId: 'cmp_regmodal' },

    /**
     * A new system enters the register UNCLASSIFIED, explicitly. The column
     * default would do the same thing, but writing it here makes the intent
     * unmissable to whoever reads this action next: registering is not
     * classifying, and the register is not allowed to pretend otherwise.
     */
    act_regcreate: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_aisys01',
                resultVar: 'createdSystem',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    purpose: { kind: 'formula', expr: 'form.purpose' },
                    department: { kind: 'formula', expr: 'form.department' },
                    business_owner: { kind: 'formula', expr: 'form.business_owner' },
                    business_owner_email: { kind: 'formula', expr: 'form.business_owner_email' },
                    provider_vendor: { kind: 'formula', expr: 'form.provider_vendor' },
                    model_or_service: { kind: 'formula', expr: 'form.model_or_service' },
                    hosting: { kind: 'formula', expr: 'form.hosting' },
                    operator_role: { kind: 'formula', expr: 'form.operator_role' },
                    status: { kind: 'formula', expr: 'form.status' },
                    in_service_date: { kind: 'formula', expr: 'form.in_service_date' },
                    personal_data: { kind: 'formula', expr: 'form.personal_data' },
                    general_purpose_model: { kind: 'formula', expr: 'form.general_purpose_model' },
                    risk_tier: { kind: 'static', value: 'unclassified' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_regmodal' },
            { kind: 'reset_form', form: 'newsystem' },
            { kind: 'refresh', tableId: 'tbl_aisys01' },
            { kind: 'toast', message: 'Registered — it is unclassified until someone triages it.', tone: 'info' },
        ],
    },

    /**
     * Inline grid edits. The grid is selectable:'none', so onRowSelect only ever
     * fires for a committed cell edit and carries the whole edited row.
     * `expectedUpdatedAt` refuses the write if someone else changed the row
     * since this grid loaded it — on a shared compliance record, silently
     * overwriting a colleague is the worst available outcome.
     */
    act_regsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_aisys01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    status: { kind: 'formula', expr: 'form.status' },
                    operator_role: { kind: 'formula', expr: 'form.operator_role' },
                    business_owner: { kind: 'formula', expr: 'form.business_owner' },
                    next_review_due: { kind: 'formula', expr: 'form.next_review_due' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_aisys01' },
        ],
    },

    /** A grid row action: remember which system, then show it in full. */
    act_regrow: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'system', value: { kind: 'formula', expr: 'item' } },
            { kind: 'navigate', screenId: 'scr_system' },
        ],
    },

    /**
     * The one place this app wants an automation: mailing the accountable roles
     * whose review date has passed. It ships UNSET on purpose — the app cannot
     * know which of the owner's automations does it, and inventing one would be
     * worse than asking. The toast says so out loud rather than failing quietly.
     */
    act_regremind: {
        kind: 'sequence',
        steps: [
            { kind: 'run_automation', automationId: null, resultVar: 'reminderRun' },
            { kind: 'toast', message: 'Pick the automation that sends the reminder under Automations — this button is wired to nothing until you do.', tone: 'info' },
        ],
    },

    // ── Triage ─────────────────────────────────────────────────────────────

    /** Read a tier's obligations. `item` is the clicked row. */
    act_trpick: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'tier', value: { kind: 'formula', expr: 'item' } }],
    },

    /**
     * The drag. `form.value` is the column the card landed in — which for this
     * board IS the tier key, because the columns come from risk_tiers and the
     * board groups by risk_tier. The board carries no rank: a register has no
     * meaningful order inside a tier, and inventing one would be a column
     * nobody maintains.
     */
    act_trmove: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_aisys01',
                recordId: { kind: 'formula', expr: 'form.item.id' },
                values: { risk_tier: { kind: 'formula', expr: 'form.value' } },
            },
            { kind: 'refresh', tableId: 'tbl_aisys01' },
            { kind: 'toast', message: 'Reclassified. Record why on the system, under Assessments.', tone: 'success' },
        ],
    },

    act_trcard: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'system', value: { kind: 'formula', expr: 'item' } },
            { kind: 'navigate', screenId: 'scr_system' },
        ],
    },

    // ── One system ─────────────────────────────────────────────────────────

    act_sysback: { kind: 'navigate', screenId: 'scr_register' },

    /**
     * CLASSIFY BY USE CASE. `item` is the clicked use case, so one step writes
     * the relation, its denormalised name AND the tier the use case triggers —
     * the classification rule living in the vocabulary rather than in here.
     * The screen's record_detail reads the system LIVE, so the tier field
     * changes under the cursor rather than after a navigation.
     */
    act_syscase: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_aisys01',
                recordId: { kind: 'formula', expr: 'vars.system.id' },
                values: {
                    use_case_id: { kind: 'formula', expr: 'item.id' },
                    use_case_name: { kind: 'formula', expr: 'item.name' },
                    risk_tier: { kind: 'formula', expr: 'item.default_tier' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_aisys01' },
            { kind: 'toast', message: 'Classified from the use case. Record the reasoning under Assessments.', tone: 'success' },
        ],
    },

    act_sysovadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_overs01',
                values: {
                    system_id: { kind: 'formula', expr: 'vars.system.id' },
                    // The display copy, written in the same step as the relation.
                    system_name: { kind: 'formula', expr: 'vars.system.name' },
                    reviewer: { kind: 'formula', expr: 'form.reviewer' },
                    reviewer_email: { kind: 'formula', expr: 'form.reviewer_email' },
                    authority: { kind: 'formula', expr: 'form.authority' },
                    frequency: { kind: 'formula', expr: 'form.frequency' },
                    procedure: { kind: 'formula', expr: 'form.procedure' },
                    trained: { kind: 'formula', expr: 'form.trained' },
                    last_confirmed_on: { kind: 'formula', expr: 'form.last_confirmed_on' },
                },
            },
            { kind: 'reset_form', form: 'newoversight' },
            { kind: 'refresh', tableId: 'tbl_overs01' },
            { kind: 'toast', message: 'Oversight arrangement recorded.', tone: 'success' },
        ],
    },

    act_sysovsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_overs01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    reviewer: { kind: 'formula', expr: 'form.reviewer' },
                    reviewer_email: { kind: 'formula', expr: 'form.reviewer_email' },
                    authority: { kind: 'formula', expr: 'form.authority' },
                    frequency: { kind: 'formula', expr: 'form.frequency' },
                    trained: { kind: 'formula', expr: 'form.trained' },
                    last_confirmed_on: { kind: 'formula', expr: 'form.last_confirmed_on' },
                    procedure: { kind: 'formula', expr: 'form.procedure' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_overs01' },
        ],
    },

    /**
     * THE STATUTORY DEADLINE (Article 73).
     *
     * Counted from `became_aware_on`, never from `occurred_on` — the Act starts
     * the clock at awareness, and an incident discovered months later is still
     * reportable within the deadline from the day it was found.
     *
     * Three offsets, because the Act has three: 2 days for a widespread
     * infringement or a serious and irreversible disruption of critical
     * infrastructure, 10 days where a person died, 15 days otherwise. A
     * non-serious incident gets no date at all, which is what makes
     * "report_due_on is not null AND reported_on is null" the exact set of
     * outstanding notifications on the incident screen.
     *
     * dateAdd returns a full ISO timestamp, so formatDate trims it back to the
     * YYYY-MM-DD a `date` column stores.
     */
    act_sysinadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_incid01',
                values: {
                    system_id: { kind: 'formula', expr: 'vars.system.id' },
                    system_name: { kind: 'formula', expr: 'vars.system.name' },
                    title: { kind: 'formula', expr: 'form.title' },
                    occurred_on: { kind: 'formula', expr: 'form.occurred_on' },
                    became_aware_on: { kind: 'formula', expr: 'form.became_aware_on' },
                    severity: { kind: 'formula', expr: 'form.severity' },
                    description: { kind: 'formula', expr: 'form.description' },
                    action_taken: { kind: 'formula', expr: 'form.action_taken' },
                    status: { kind: 'static', value: 'open' },
                    logged_by: { kind: 'formula', expr: 'currentUser.name' },
                    report_due_on: {
                        kind: 'formula',
                        expr: "form.severity == 'serious_infra' ? formatDate(dateAdd(form.became_aware_on, 2, 'day'), 'YYYY-MM-DD') : (form.severity == 'serious_death' ? formatDate(dateAdd(form.became_aware_on, 10, 'day'), 'YYYY-MM-DD') : (form.severity == 'serious' ? formatDate(dateAdd(form.became_aware_on, 15, 'day'), 'YYYY-MM-DD') : null))",
                    },
                },
            },
            { kind: 'reset_form', form: 'newincident' },
            { kind: 'refresh', tableId: 'tbl_incid01' },
            { kind: 'toast', message: 'Incident logged. If it is serious, the reporting deadline is on the Incidents screen.', tone: 'warning' },
        ],
    },

    /**
     * Only the status is editable inline. The dates and the severity are not:
     * they decide a statutory deadline, and a deadline that can be nudged from a
     * grid cell is not a deadline.
     */
    act_sysinsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_incid01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: { status: { kind: 'formula', expr: 'form.status' } },
            },
            { kind: 'refresh', tableId: 'tbl_incid01' },
        ],
    },

    act_sysasadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_asmnt01',
                values: {
                    system_id: { kind: 'formula', expr: 'vars.system.id' },
                    system_name: { kind: 'formula', expr: 'vars.system.name' },
                    assessment_type: { kind: 'formula', expr: 'form.assessment_type' },
                    performed_on: { kind: 'formula', expr: 'form.performed_on' },
                    performed_by: { kind: 'formula', expr: 'form.performed_by' },
                    outcome: { kind: 'formula', expr: 'form.outcome' },
                    findings: { kind: 'formula', expr: 'form.findings' },
                    next_due_on: { kind: 'formula', expr: 'form.next_due_on' },
                },
            },
            // An assessment is the event that moves the system's own review
            // dates, so the same submit writes both — otherwise the register
            // would say "never assessed" about a system just assessed.
            {
                kind: 'update_record',
                tableId: 'tbl_aisys01',
                recordId: { kind: 'formula', expr: 'vars.system.id' },
                values: {
                    last_assessed_on: { kind: 'formula', expr: 'form.performed_on' },
                    next_review_due: { kind: 'formula', expr: 'form.next_due_on' },
                },
            },
            { kind: 'reset_form', form: 'newassessment' },
            { kind: 'refresh', tableId: 'tbl_asmnt01' },
            { kind: 'refresh', tableId: 'tbl_aisys01' },
            { kind: 'toast', message: 'Assessment recorded, and the system\'s review dates moved with it.', tone: 'success' },
        ],
    },

    act_sysassave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_asmnt01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    outcome: { kind: 'formula', expr: 'form.outcome' },
                    performed_by: { kind: 'formula', expr: 'form.performed_by' },
                    next_due_on: { kind: 'formula', expr: 'form.next_due_on' },
                    findings: { kind: 'formula', expr: 'form.findings' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_asmnt01' },
        ],
    },

    // ── Incidents ──────────────────────────────────────────────────────────

    act_inopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'incident', value: { kind: 'formula', expr: 'item' } },
            { kind: 'open_modal', modalId: 'cmp_inmodal' },
        ],
    },

    /**
     * Filing the notification, from the grid row. `today` IS in the server's
     * scope, so the date the register records is the server's date rather than
     * whatever the browser's clock says — which matters when the number being
     * written is evidence of meeting a statutory deadline.
     *
     * BOTH WRITES ARE GUARDED ON `item.reported_on`, and they have to be. A
     * `rowActions` entry is { label, actionId } and nothing else — there is no
     * per-row `visible`, so this button is offered on EVERY row, including the
     * ones already notified. Unguarded, a misclick on a reported incident would
     * stamp today over the real notification date — turning an incident that met
     * its deadline into one that missed it by weeks — and drag its status back
     * from mitigated/closed to investigating. The dialog's version of this
     * button can hide itself and does; this one cannot, so it is made idempotent
     * instead: on an already-reported row both formulas write back what is
     * already there.
     */
    act_inreport: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_incid01',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: {
                    reported_on: { kind: 'formula', expr: 'item.reported_on ? item.reported_on : today' },
                    status: { kind: 'formula', expr: "item.reported_on ? item.status : 'investigating'" },
                },
            },
            { kind: 'refresh', tableId: 'tbl_incid01' },
            // Deliberately true of both paths: a toast message is a plain
            // string, so it cannot claim "notified today" on a row that was
            // notified in June and kept its original date.
            { kind: 'toast', message: 'Notification recorded. An incident already reported keeps the date it was reported on — add the authority\'s reference in the grid.', tone: 'success' },
        ],
    },

    /** The same thing from inside the dialog, where there is no clicked row. */
    act_inrepdlg: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_incid01',
                recordId: { kind: 'formula', expr: 'vars.incident.id' },
                values: {
                    reported_on: { kind: 'formula', expr: 'today' },
                    status: { kind: 'static', value: 'investigating' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_inmodal' },
            { kind: 'refresh', tableId: 'tbl_incid01' },
            { kind: 'toast', message: 'Recorded as notified today.', tone: 'success' },
        ],
    },

    act_insave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_incid01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    status: { kind: 'formula', expr: 'form.status' },
                    authority_reference: { kind: 'formula', expr: 'form.authority_reference' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_incid01' },
        ],
    },

    // ── Setup — the vocabulary ─────────────────────────────────────────────

    act_sutier: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_tiers01',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    label: { kind: 'formula', expr: 'form.label' },
                    color: { kind: 'formula', expr: 'form.color' },
                    position: { kind: 'formula', expr: 'form.position' },
                    obligations: { kind: 'formula', expr: 'form.obligations' },
                },
            },
            { kind: 'reset_form', form: 'newtier' },
            { kind: 'refresh', tableId: 'tbl_tiers01' },
            { kind: 'toast', message: 'Tier added — the triage board has a column for it now.', tone: 'success' },
        ],
    },

    act_sutsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_tiers01',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    label: { kind: 'formula', expr: 'form.label' },
                    color: { kind: 'formula', expr: 'form.color' },
                    permitted: { kind: 'formula', expr: 'form.permitted' },
                    review_months: { kind: 'formula', expr: 'form.review_months' },
                    summary: { kind: 'formula', expr: 'form.summary' },
                    obligations: { kind: 'formula', expr: 'form.obligations' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_tiers01' },
        ],
    },

    act_sucase: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_usecase1',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    legal_reference: { kind: 'formula', expr: 'form.legal_reference' },
                    area: { kind: 'formula', expr: 'form.area' },
                    default_tier: { kind: 'formula', expr: 'form.default_tier' },
                    description: { kind: 'formula', expr: 'form.description' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'reset_form', form: 'newusecase' },
            { kind: 'refresh', tableId: 'tbl_usecase1' },
            { kind: 'toast', message: 'Use case added.', tone: 'success' },
        ],
    },

    act_sucsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_usecase1',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    legal_reference: { kind: 'formula', expr: 'form.legal_reference' },
                    area: { kind: 'formula', expr: 'form.area' },
                    default_tier: { kind: 'formula', expr: 'form.default_tier' },
                    description: { kind: 'formula', expr: 'form.description' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_usecase1' },
        ],
    },
};

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'AI system register',
        description: 'The EU AI Act inventory: systems, risk tiers, oversight, incidents and assessments.',
        icon: 'ShieldCheck',
    },
    theme: { primary: '#047857', ...THEME_DEFAULTS, radius: 'lg' },
    // Identity: the "field" look — friendly emerald, General Sans, soft
    // surfaces — so the AI register reads as approachable governance, not as
    // another grey console. The preset id records provenance; the values are
    // materialized here (appDesignPresets.js precedent).
    design: { preset: 'field', font: 'general-sans', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
    nav: {
        style: 'sidebar',
        groups: [
            { id: 'nvg_register', label: 'Register', icon: 'Table', screens: ['scr_register', 'scr_triage'] },
            { id: 'nvg_evidence', label: 'Evidence', icon: 'AlertTriangle', screens: ['scr_incident'] },
            { id: 'nvg_setup', label: 'Setup', icon: 'Settings', screens: ['scr_setup'] },
        ],
    },
    roles: [
        { id: 'officer', name: 'Compliance officer' },
        { id: 'contributor', name: 'System owner' },
        { id: 'auditor', name: 'Auditor' },
    ],
    /**
     * `filters` is NOT declared — it is reserved, owned by filter_bar, which
     * republishes the whole object on every keystroke.
     */
    variables: [
        { name: 'system', label: 'Open system', type: 'record', default: null, description: 'The system opened from the register or the triage board. Supplies identity only — every screen reads the row itself live, so a write shows immediately.' },
        { name: 'tier', label: 'Selected tier', type: 'record', default: null, description: 'The tier whose obligations the triage screen is showing.' },
        { name: 'incident', label: 'Open incident', type: 'record', default: null, description: 'The incident the dialog on the Incidents screen is showing.' },
    ],
    homeScreenId: 'scr_register',
    screens: [
        SCREEN_REGISTER,
        SCREEN_TRIAGE,
        SCREEN_SYSTEM,
        SCREEN_INCIDENTS,
        SCREEN_SETUP,
    ],
    actions,
};

// ---------------------------------------------------------------------------
// Seed
//
// A register you can read on the first screen: five tiers, thirteen use cases
// covering the Annex III points that come up in an ordinary company plus the
// Article 50 transparency cases, ten systems, and the evidence hanging off
// them.
//
// NOBODY REAL IS IN HERE. Accountability is seeded as a ROLE — "HR operations
// lead", not a name — because a compliance register is precisely the document
// that must not ship pre-filled with something that reads like a real person's
// file. Vendors are invented; addresses are example.com. It is also better
// modelling: a role survives someone leaving.
//
// THREE SYSTEMS ARE SEEDED UNCLASSIFIED, and one of them has an overdue
// Article 73 notification against it. That is the state a real register is
// found in, and it is what makes the first screen tell the truth instead of
// congratulating the customer.
//
// `$id` is a LOCAL alias, never a column; { $ref } points at a row seeded
// EARLIER. templateInstall seeds parent tables first and rewrites the refs.
// ---------------------------------------------------------------------------

const seed = {
    // Position 0 for 'unclassified' so it is the FIRST column of the triage
    // board — the pile you look at before anything else. Red, along with
    // 'prohibited', because an unknown risk and a forbidden one are the two
    // states that need a decision this week.
    tbl_tiers01: [
        {
            key: 'unclassified', label: 'Unclassified', color: 'danger', position: 0, review_months: 1, permitted: true,
            summary: 'Nobody has decided yet — treat it as unknown risk.',
            obligations: 'No obligations are known, because no decision has been made — which is itself the problem.\n\n- Open the system and pick the use case it matches; the use case carries the tier it triggers.\n- If nothing fits, set the tier by hand on the triage board and write down why under Assessments.\n- Check Article 5 first: a prohibited practice is not a low tier, it is a stop.',
        },
        {
            key: 'prohibited', label: 'Prohibited', color: 'danger', position: 1, review_months: 1, permitted: false,
            summary: 'Article 5 — the practice may not be operated at all.',
            obligations: 'Stop the system and record the decision.\n\nArticle 5 forbids, among others: social scoring by or on behalf of public authorities, untargeted scraping of facial images, emotion inference in the workplace or in education, and certain biometric categorisation. No mitigation makes a prohibited practice lawful.',
        },
        {
            key: 'high', label: 'High risk', color: 'warning', position: 2, review_months: 6, permitted: true,
            summary: 'Annex III or a safety component — Chapter III applies.',
            obligations: 'The full Chapter III set:\n\n- Risk management system across the lifecycle\n- Data governance for training, validation and testing data\n- Technical documentation and automatically kept logs\n- Transparency towards the deployer, and instructions for use\n- Human oversight by someone with the competence and the authority to intervene\n- Accuracy, robustness and cybersecurity appropriate to the purpose\n- Registration in the EU database\n- As a deployer: a fundamental-rights impact assessment under Article 27 where it applies',
        },
        {
            key: 'limited', label: 'Limited risk', color: 'info', position: 3, review_months: 12, permitted: true,
            summary: 'Article 50 — people have to be told.',
            obligations: 'Transparency duties only:\n\n- Tell people they are interacting with an AI system, unless it is obvious\n- Mark synthetic audio, image, video or text as machine-generated\n- Disclose emotion-recognition or biometric categorisation to the people exposed to it',
        },
        {
            key: 'minimal', label: 'Minimal risk', color: 'success', position: 4, review_months: 24, permitted: true,
            summary: 'No specific AI Act duties beyond the ones you already have.',
            obligations: 'Nothing beyond existing law — but keep it on the register anyway. The tier is a judgement, and a judgement is worth a date and a name against it. Revisit it when the purpose of the system changes, which is the moment a minimal-risk tool quietly becomes something else.',
        },
    ],

    // The Annex III points an ordinary organisation actually meets, plus the
    // Article 50 transparency cases and one prohibited practice — because a
    // vocabulary that can only express "high risk" cannot classify the tool
    // that summarises meeting notes, and a register that cannot classify the
    // ordinary cases gets abandoned.
    tbl_usecase1: [
        { $id: 'biometric_id', key: 'biometric_id', name: 'Remote biometric identification of people', legal_reference: 'Annex III, 1(a)', area: 'Biometrics', default_tier: 'high', position: 10, description: 'Identifying people at a distance by face, gait or voice.' },
        { $id: 'critical_infra', key: 'critical_infra', name: 'Safety component of critical infrastructure', legal_reference: 'Annex III, 2', area: 'Critical infrastructure', default_tier: 'high', position: 20, description: 'Traffic, water, gas, heating, electricity or digital infrastructure where failure endangers people.' },
        { $id: 'education', key: 'education', name: 'Admission, evaluation or proctoring in education', legal_reference: 'Annex III, 3', area: 'Education', default_tier: 'high', position: 30, description: 'Deciding who gets in, what grade they get, or watching them during an exam.' },
        { $id: 'recruitment', key: 'recruitment', name: 'Recruitment, selection and screening of applicants', legal_reference: 'Annex III, 4(a)', area: 'Employment', default_tier: 'high', position: 40, description: 'Advertising vacancies, filtering applications, ranking or scoring candidates.' },
        { $id: 'worker_mgmt', key: 'worker_mgmt', name: 'Decisions on promotion, task allocation or termination', legal_reference: 'Annex III, 4(b)', area: 'Employment', default_tier: 'high', position: 50, description: 'Allocating work, evaluating performance or ending a working relationship.' },
        { $id: 'essential_services', key: 'essential_services', name: 'Eligibility for public benefits or essential services', legal_reference: 'Annex III, 5(a)', area: 'Essential services', default_tier: 'high', position: 60, description: 'Granting, reducing or reclaiming public assistance and essential public services.' },
        { $id: 'creditworthiness', key: 'creditworthiness', name: 'Creditworthiness scoring of natural persons', legal_reference: 'Annex III, 5(b)', area: 'Essential services', default_tier: 'high', position: 70, description: 'Evaluating a person\'s credit score, other than to detect financial fraud.' },
        { $id: 'insurance_pricing', key: 'insurance_pricing', name: 'Risk assessment and pricing in life and health insurance', legal_reference: 'Annex III, 5(c)', area: 'Essential services', default_tier: 'high', position: 80, description: 'Assessing risk or setting a price for a natural person\'s life or health cover.' },
        { $id: 'law_enforcement', key: 'law_enforcement', name: 'Assessing the risk of offending or of becoming a victim', legal_reference: 'Annex III, 6', area: 'Law enforcement', default_tier: 'high', position: 90, description: 'Predictive assessment about a natural person by or for a law-enforcement authority.' },
        { $id: 'justice', key: 'justice', name: 'Assisting a judicial authority with facts and law', legal_reference: 'Annex III, 8(a)', area: 'Justice', default_tier: 'high', position: 100, description: 'Researching, interpreting or applying the law to a concrete set of facts.' },
        { $id: 'public_chatbot', key: 'public_chatbot', name: 'Chatbot or assistant that talks to people', legal_reference: 'Article 50(1)', area: 'Transparency', default_tier: 'limited', position: 110, description: 'Anything a person converses with and could mistake for a human.' },
        { $id: 'content_generation', key: 'content_generation', name: 'Generates or edits text, image, audio or video', legal_reference: 'Article 50(2)', area: 'Transparency', default_tier: 'limited', position: 120, description: 'Synthetic output that leaves the building has to be machine-readable as synthetic.' },
        { $id: 'internal_assist', key: 'internal_assist', name: 'Internal assistance with a person in the loop', legal_reference: '—', area: 'Internal', default_tier: 'minimal', position: 130, description: 'Summarising, drafting or searching, where a colleague reads the result before it does anything.' },
        { $id: 'emotion_at_work', key: 'emotion_at_work', name: 'Emotion inference in the workplace or in education', legal_reference: 'Article 5(1)(f)', area: 'Prohibited', default_tier: 'prohibited', position: 140, description: 'Inferring emotions of workers or students. Prohibited outside narrow medical and safety uses.' },
    ],

    tbl_aisys01: [
        {
            $id: 'sys_cv', name: 'CV pre-screening assistant',
            purpose: 'Ranks incoming applications against the vacancy profile so a recruiter reads the strongest ones first.',
            business_owner: 'HR operations lead', business_owner_email: 'hr-ops@example.com', department: 'People',
            provider_vendor: 'Kestrel HR Suite', model_or_service: 'Vendor scoring API', hosting: 'external_eu',
            operator_role: 'deployer', status: 'in_use', in_service_date: '2025-11-03',
            risk_tier: 'high', use_case_id: { $ref: 'recruitment' }, use_case_name: 'Recruitment, selection and screening of applicants',
            transparency_notice: true, general_purpose_model: false, personal_data: true,
            last_assessed_on: '2026-03-10', next_review_due: '2026-06-30',
            notes: 'Recruiters see the full application, never only the score. The ranking is advisory and the rejection is always a human decision.',
        },
        {
            $id: 'sys_chat', name: 'Customer support chatbot',
            purpose: 'Answers first-line product questions on the public website and hands over to an agent on request.',
            business_owner: 'Support team lead', business_owner_email: 'support-lead@example.com', department: 'Customer service',
            provider_vendor: 'In-house', model_or_service: 'Self-hosted open-weight LLM (8B) behind our own API', hosting: 'self_hosted',
            operator_role: 'provider', status: 'in_use', in_service_date: '2026-01-15',
            risk_tier: 'limited', use_case_id: { $ref: 'public_chatbot' }, use_case_name: 'Chatbot or assistant that talks to people',
            transparency_notice: true, general_purpose_model: true, personal_data: true,
            last_assessed_on: '2026-06-01', next_review_due: '2027-06-01',
            notes: 'The first message states it is an automated assistant. Transcripts are kept 30 days.',
        },
        {
            $id: 'sys_note', name: 'Meeting note summariser',
            purpose: 'Turns an internal meeting transcript into a summary and a list of actions, which the chair edits before sending.',
            business_owner: 'Operations lead', business_owner_email: 'operations@example.com', department: 'Operations',
            provider_vendor: 'In-house', model_or_service: 'Self-hosted open-weight LLM', hosting: 'self_hosted',
            operator_role: 'deployer', status: 'in_use', in_service_date: '2025-09-01',
            risk_tier: 'minimal', use_case_id: { $ref: 'internal_assist' }, use_case_name: 'Internal assistance with a person in the loop',
            transparency_notice: false, general_purpose_model: true, personal_data: true,
            last_assessed_on: '2026-01-15', next_review_due: '2028-01-15',
            notes: 'Nothing leaves our own infrastructure. Participants are told at the start of the meeting.',
        },
        {
            $id: 'sys_trans', name: 'Meeting transcription service',
            purpose: 'Speech-to-text with speaker separation for internal meetings and recorded customer calls.',
            business_owner: 'Operations lead', business_owner_email: 'operations@example.com', department: 'Operations',
            provider_vendor: 'In-house', model_or_service: 'Self-hosted speech-to-text with diarisation', hosting: 'self_hosted',
            operator_role: 'deployer', status: 'in_use', in_service_date: '2025-09-01',
            risk_tier: 'minimal', use_case_id: { $ref: 'internal_assist' }, use_case_name: 'Internal assistance with a person in the loop',
            transparency_notice: true, general_purpose_model: false, personal_data: true,
            last_assessed_on: '2026-01-15', next_review_due: '2028-01-15',
        },
        {
            $id: 'sys_credit', name: 'Credit limit recommendation',
            purpose: 'Proposes a payment-on-account limit for a new business customer, which a credit controller confirms or overrides.',
            business_owner: 'Credit control lead', business_owner_email: 'credit-control@example.com', department: 'Finance',
            provider_vendor: 'In-house', model_or_service: 'Gradient-boosted model on our own ledger data', hosting: 'self_hosted',
            operator_role: 'provider', status: 'in_use', in_service_date: '2025-04-20',
            risk_tier: 'high', use_case_id: { $ref: 'creditworthiness' }, use_case_name: 'Creditworthiness scoring of natural persons',
            transparency_notice: true, general_purpose_model: false, personal_data: true,
            last_assessed_on: '2026-02-20', next_review_due: '2026-08-20',
            notes: 'Sole traders are natural persons, which is what puts this in Annex III 5(b) — the classification everyone gets wrong first.',
        },
        {
            $id: 'sys_doc', name: 'Contract clause extractor',
            purpose: 'Pulls the parties, term and notice period out of an incoming contract so legal can triage it faster.',
            business_owner: 'Legal counsel', business_owner_email: 'legal@example.com', department: 'Legal',
            provider_vendor: 'In-house', model_or_service: 'Self-hosted open-weight LLM with retrieval', hosting: 'self_hosted',
            operator_role: 'deployer', status: 'in_use', in_service_date: '2026-02-01',
            risk_tier: 'minimal', use_case_id: { $ref: 'internal_assist' }, use_case_name: 'Internal assistance with a person in the loop',
            transparency_notice: false, general_purpose_model: true, personal_data: false,
            last_assessed_on: '2026-02-05', next_review_due: '2028-02-05',
        },
        {
            $id: 'sys_mood', name: 'Call-centre tone monitor',
            purpose: 'Scores the emotional tone of support agents during customer calls and reports it to team leads.',
            business_owner: 'Support team lead', business_owner_email: 'support-lead@example.com', department: 'Customer service',
            provider_vendor: 'Halcyon Speech Labs', model_or_service: 'Vendor emotion-recognition API', hosting: 'external_other',
            operator_role: 'deployer', status: 'paused', in_service_date: '2026-02-10',
            risk_tier: 'prohibited', use_case_id: { $ref: 'emotion_at_work' }, use_case_name: 'Emotion inference in the workplace or in education',
            transparency_notice: false, general_purpose_model: false, personal_data: true,
            last_assessed_on: '2026-07-05', next_review_due: '2026-09-05',
            notes: 'Paused on 5 July pending removal. Article 5(1)(f) prohibits inferring emotions of workers; no consent or notice makes it lawful.',
        },
        // ── The three nobody has looked at. ────────────────────────────────
        {
            $id: 'sys_fraud', name: 'Payment anomaly scoring',
            purpose: 'Flags outgoing payments that look unlike our usual pattern so finance can hold them for a check.',
            business_owner: 'Finance operations lead', business_owner_email: 'finance-ops@example.com', department: 'Finance',
            provider_vendor: 'Orinoco Analytics', model_or_service: 'Vendor anomaly-scoring API', hosting: 'external_other',
            operator_role: 'deployer', status: 'in_use', in_service_date: '2025-06-12',
            // Written out rather than left to the column default. The seed is
            // the install, and a tier that only exists as a DDL default is a
            // tier nothing in this file can be tested against.
            risk_tier: 'unclassified',
            transparency_notice: false, general_purpose_model: false, personal_data: true,
            notes: 'Arrived with the payments platform. Nobody has decided whether fraud detection here is the Annex III 5(b) exemption or something else.',
        },
        {
            $id: 'sys_cam', name: 'Entrance camera people counter',
            purpose: 'Counts visitors entering the building for facilities planning.',
            business_owner: 'Facilities lead', business_owner_email: 'facilities@example.com', department: 'Facilities',
            provider_vendor: 'Nimbus Vision BV', model_or_service: 'Vendor edge vision appliance', hosting: 'external_other',
            operator_role: 'deployer', status: 'planned', in_service_date: '2026-09-01',
            risk_tier: 'unclassified',
            transparency_notice: false, general_purpose_model: false, personal_data: true,
            notes: 'Sold as anonymous counting. Nobody has confirmed what the appliance actually stores, which is the question that decides whether this is biometric identification.',
        },
        {
            $id: 'sys_route', name: 'Support ticket router',
            purpose: 'Chooses which support queue an incoming ticket lands in.',
            business_owner: 'Support team lead', business_owner_email: 'support-lead@example.com', department: 'Customer service',
            provider_vendor: 'In-house', model_or_service: 'Text classifier trained on our own tickets', hosting: 'self_hosted',
            operator_role: 'provider', status: 'planned',
            risk_tier: 'unclassified',
            transparency_notice: false, general_purpose_model: false, personal_data: true,
            notes: 'Built in a hackathon and never classified.',
        },
    ],

    tbl_overs01: [
        {
            system_id: { $ref: 'sys_cv' }, system_name: 'CV pre-screening assistant',
            reviewer: 'Recruitment team lead', reviewer_email: 'recruitment-lead@example.com',
            authority: 'override_output', frequency: 'continuous', trained: true, last_confirmed_on: '2026-07-01',
            procedure: 'Every shortlist is opened in full; the recruiter reads the applications the model ranked lowest before anyone is rejected.',
        },
        {
            system_id: { $ref: 'sys_cv' }, system_name: 'CV pre-screening assistant',
            reviewer: 'HR compliance officer', reviewer_email: 'hr-compliance@example.com',
            authority: 'stop_system', frequency: 'monthly', trained: true, last_confirmed_on: '2026-07-01',
            procedure: 'Monthly sample of 20 rejections re-read by hand, plus a distribution check across age and gender bands.',
        },
        {
            system_id: { $ref: 'sys_chat' }, system_name: 'Customer support chatbot',
            reviewer: 'Support duty lead', reviewer_email: 'support-lead@example.com',
            authority: 'stop_system', frequency: 'daily', trained: true, last_confirmed_on: '2026-06-02',
            procedure: 'Daily read of every conversation the bot escalated, plus anything a customer rated badly.',
        },
        {
            system_id: { $ref: 'sys_credit' }, system_name: 'Credit limit recommendation',
            reviewer: 'Credit controller', reviewer_email: 'credit-control@example.com',
            authority: 'override_output', frequency: 'continuous', trained: true, last_confirmed_on: '2026-02-20',
            procedure: 'No limit is issued without a controller confirming it; the proposal is shown next to the ledger history it was derived from.',
        },
        {
            system_id: { $ref: 'sys_mood' }, system_name: 'Call-centre tone monitor',
            reviewer: 'Works council representative', reviewer_email: 'works-council@example.com',
            authority: 'stop_system', frequency: 'monthly', trained: false, last_confirmed_on: '2026-07-05',
            procedure: 'Raised the practice with the board; the system was paused the same week.',
        },
        {
            system_id: { $ref: 'sys_note' }, system_name: 'Meeting note summariser',
            reviewer: 'Meeting chair', reviewer_email: 'operations@example.com',
            authority: 'override_output', frequency: 'continuous', trained: true, last_confirmed_on: '2026-01-15',
            procedure: 'The chair edits the summary before it is circulated. Nothing is sent unread.',
        },
    ],

    // Deadlines are exactly became_aware_on + the statutory offset for the
    // severity — 15 days as a rule, 10 for a death, 2 for critical
    // infrastructure. The template's own test recomputes every one of them.
    tbl_incid01: [
        {
            system_id: { $ref: 'sys_cv' }, system_name: 'CV pre-screening assistant',
            title: 'Shortlists skewed against applicants with a gap in employment',
            occurred_on: '2026-06-02', became_aware_on: '2026-06-09', severity: 'serious',
            description: 'A quarterly distribution check showed applicants with more than a twelve-month employment gap were ranked in the bottom decile far more often than the base rate. The feature was a proxy the vendor had not documented.',
            action_taken: 'Ranking suspended for four days; the vendor removed the feature; the 60 affected applications were re-read by hand.',
            status: 'mitigated', report_due_on: '2026-06-24', reported_on: '2026-06-18',
            authority_reference: 'MSA-2026-0417', logged_by: 'HR compliance officer',
        },
        {
            system_id: { $ref: 'sys_chat' }, system_name: 'Customer support chatbot',
            title: 'Bot quoted a refund amount that does not exist',
            occurred_on: '2026-07-11', became_aware_on: '2026-07-11', severity: 'minor',
            description: 'The assistant invented a goodwill refund policy when asked about a late delivery. One customer quoted it back to an agent.',
            action_taken: 'Refund questions now hand over to an agent instead of being answered.',
            status: 'closed', logged_by: 'Support duty lead',
        },
        {
            system_id: { $ref: 'sys_fraud' }, system_name: 'Payment anomaly scoring',
            title: 'Bulk false positives froze forty legitimate supplier payments',
            occurred_on: '2026-07-28', became_aware_on: '2026-07-29', severity: 'significant',
            description: 'A change in the vendor model on 28 July flagged the whole month-end payment run. Payments were held for a day.',
            action_taken: 'Threshold restored by the vendor; a manual release path was added for month-end runs.',
            status: 'investigating', logged_by: 'Finance operations lead',
        },
        {
            // The overdue one. Its system is also the unclassified one, which is
            // exactly how this goes in practice.
            system_id: { $ref: 'sys_fraud' }, system_name: 'Payment anomaly scoring',
            title: 'Blocked payments for a hospital supplier for three days',
            occurred_on: '2026-07-15', became_aware_on: '2026-07-16', severity: 'serious',
            description: 'Scoring held payments to a medical-supplies wholesaler across three runs. The supplier suspended deliveries to two care homes before anyone noticed.',
            action_taken: 'Payments released by hand; the supplier was put on an exemption list while the cause is investigated.',
            status: 'investigating', report_due_on: '2026-07-31',
            logged_by: 'Finance operations lead',
        },
        {
            system_id: { $ref: 'sys_cam' }, system_name: 'Entrance camera people counter',
            title: 'Counting appliance was found to store face crops',
            occurred_on: '2026-08-01', became_aware_on: '2026-08-05', severity: 'serious',
            description: 'A pre-deployment inspection of the appliance found cropped face images retained on the device for 30 days, contrary to the datasheet.',
            action_taken: 'Rollout halted. The vendor has been asked for the retention configuration in writing.',
            status: 'open', report_due_on: '2026-08-20', logged_by: 'Facilities lead',
        },
        {
            system_id: { $ref: 'sys_mood' }, system_name: 'Call-centre tone monitor',
            title: 'Agents were scored on emotional tone without being told',
            occurred_on: '2026-04-14', became_aware_on: '2026-07-02', severity: 'serious',
            description: 'Tone scores had been reported to team leads since February. Agents were not informed, and the works council had not been consulted.',
            action_taken: 'System paused. Scores deleted. The practice falls under the Article 5(1)(f) prohibition, so it is being removed rather than fixed.',
            status: 'closed', report_due_on: '2026-07-17', reported_on: '2026-07-10',
            authority_reference: 'MSA-2026-0502', logged_by: 'Compliance officer',
        },
        {
            system_id: { $ref: 'sys_credit' }, system_name: 'Credit limit recommendation',
            title: 'Model unavailable for six hours, manual fallback used',
            occurred_on: '2026-05-20', became_aware_on: '2026-05-20', severity: 'minor',
            description: 'A failed deployment took the scoring service down for an afternoon. Controllers set limits from the ledger by hand, as the procedure provides for.',
            action_taken: 'Health check added to the deployment pipeline.',
            status: 'closed', logged_by: 'Credit control lead',
        },
    ],

    tbl_asmnt01: [
        {
            system_id: { $ref: 'sys_cv' }, system_name: 'CV pre-screening assistant',
            assessment_type: 'fria', performed_on: '2026-03-10', performed_by: 'Compliance office with HR',
            outcome: 'passed_with_actions', next_due_on: '2026-09-10',
            findings: 'Deployer FRIA under Article 27. Actions: quarterly distribution check across protected characteristics, and the vendor to document every feature used in the ranking.',
        },
        {
            system_id: { $ref: 'sys_cv' }, system_name: 'CV pre-screening assistant',
            assessment_type: 'dpia', performed_on: '2026-03-12', performed_by: 'Data protection officer',
            outcome: 'passed', next_due_on: '2027-03-12',
            findings: 'Lawful basis and retention confirmed; applications are deleted after six months.',
        },
        {
            system_id: { $ref: 'sys_credit' }, system_name: 'Credit limit recommendation',
            assessment_type: 'fria', performed_on: '2026-02-20', performed_by: 'Compliance office with Finance',
            outcome: 'passed_with_actions', next_due_on: '2026-08-20',
            findings: 'Sole traders are natural persons, so Annex III 5(b) applies. Actions: written explanation of the recommendation shown to the controller, and an appeal route for the customer.',
        },
        {
            system_id: { $ref: 'sys_chat' }, system_name: 'Customer support chatbot',
            assessment_type: 'periodic', performed_on: '2026-06-01', performed_by: 'Compliance office',
            outcome: 'passed', next_due_on: '2027-06-01',
            findings: 'Article 50 disclosure present in the opening message and in the widget label. No change of purpose since launch.',
        },
        {
            system_id: { $ref: 'sys_mood' }, system_name: 'Call-centre tone monitor',
            assessment_type: 'fria', performed_on: '2026-07-05', performed_by: 'Compliance office with the works council',
            outcome: 'failed',
            findings: 'Emotion inference about workers is prohibited under Article 5(1)(f). No mitigation makes it lawful; the recommendation is removal, not restriction.',
        },
        {
            system_id: { $ref: 'sys_note' }, system_name: 'Meeting note summariser',
            assessment_type: 'periodic', performed_on: '2026-01-15', performed_by: 'Operations lead',
            outcome: 'passed', next_due_on: '2028-01-15',
            findings: 'Self-hosted, human in the loop, no external transfer. Minimal risk confirmed.',
        },
    ],
};

module.exports = {
    id: 'app-ai-act-register',
    version: 1,
    title: 'AI system register',
    description: 'The EU AI Act inventory, self-hosted: which AI systems you operate, which risk tier each falls in, who exercises human oversight, what went wrong and when it must be reported. Risk tiers and Annex III use cases are data your compliance officer edits, and a system nobody has classified is impossible to miss.',
    category: 'Compliance',
    icon: 'ShieldCheck',
    tags: ['ai act', 'compliance', 'risk', 'register', 'governance', 'incidents', 'eu'],
    definition,
    dataModel,
    seed,
};
