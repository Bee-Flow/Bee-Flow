/**
 * App Studio template — Knowledge base governance.
 *
 * The register for what an AI assistant is allowed to repeat. A RAG knowledge
 * base quietly becomes the most sensitive store an organisation has: whatever
 * went into it, an assistant will say back to whoever may ask. This app records
 * what went in, who supplied it, on what legal basis, who approved it, when it
 * must come out again, what a personal-data scan found in it, and which
 * assistants may read it.
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS ────────────────────────────────
 *
 * A source's fitness to answer is THREE INDEPENDENT COLUMNS, never one status.
 *
 *   review_state  — what a human decided about it   (customer vocabulary)
 *   index_state   — where the retrieval pipeline has it (platform vocabulary)
 *   review_due    — when that decision expires        (a date, not a state)
 *
 * Every product that gets this wrong collapses them into one `status` field,
 * and the moment it does, the failures this register exists to catch become
 * inexpressible. `approved` cannot also say "and it is four months past its
 * review date". `retired` cannot also say "and it is still in the index,
 * answering". The dangerous rows are not states — they are DISAGREEMENTS
 * between the three, and you can only query a disagreement between columns that
 * are allowed to disagree.
 *
 * So every screen here is a query over that disagreement, and the Register
 * screen leads with the worst one: live + indexed + past its review date. A
 * source still answering questions on material nobody has re-checked.
 *
 * The split between the two vocabularies is deliberate and runs through the
 * whole file:
 *
 *   • `review_state` and `legal_basis` are TEXT KEYS into config tables, so the
 *     customer owns the words. A regulated organisation's approval ladder is
 *     its own — some have a DPO gate, some a four-eyes step, some a
 *     "conditionally approved with redactions" rung. A `select` field's options
 *     live in the DATA MODEL, which only the builder can change, so shipping
 *     them as options would mean a developer editing a live schema every time
 *     the policy moves. With keys, a steward adds a row on Setup — which is why
 *     that screen carries an Add control for each of the three config tables
 *     and not only the inline-editable grids. An argument for keys over options
 *     that leaves the customer opening the builder to add a rung is not an
 *     argument, it is a diagram.
 *
 *   • `index_state` and a finding's `category` are `select` fields with fixed
 *     options, because they are NOT the customer's to invent. `indexed` is a
 *     fact about the retrieval pipeline, and the PII categories are the labels
 *     the detector actually emits (Bee Flow ships guard-service for this). A
 *     customer inventing a fourth index state would be describing a state the
 *     product cannot be in.
 *
 * The approval control follows from this: the Source screen's state picker is a
 * `list` BOUND TO the review_states table, not a dropdown of authored options.
 * The ladder the customer configured IS the set of buttons.
 *
 * ── CONSTRAINTS THAT SHAPED THIS FILE (none of them obvious) ────────────────
 *
 *  • NO JOINS. Every read compiles to `FROM <one table>`; a filter or sort may
 *    only name the bound table's own columns. Three consequences here:
 *      – `base_name` is DENORMALISED onto sources, findings, grants and
 *        retirements, because a grid cannot follow `base_id` to fetch a label.
 *      – `source_title` is denormalised onto findings and retirements.
 *      – `review_stage` is a denormalised copy of the chosen state's CATEGORY.
 *        The review queue wants "everything not yet decided", which is a
 *        property of the state row, not of the source — and there is no join to
 *        reach it. So `act_setstate` writes both the key and its category, and
 *        every screen that means "live" or "closed" filters the copy. Rename a
 *        state on Setup and the copy survives; re-categorise one and the
 *        already-classified sources keep their old stage until someone sets
 *        their state again. That is the honest cost, and it is the reason the
 *        test file asserts the two agree across the whole seed.
 *
 *  • A BINDING FILTER FORMULA may only read currentUser / vars / forms /
 *    screen / today. Reading form.*, item.*, records.* or now makes the fetch
 *    layer and the read-side cache key diverge and the component loads forever.
 *    Every dynamic filter here goes through `vars` — or through `today`, which
 *    is what turns "past its review date" into a query instead of a batch job.
 *
 *  • THE SERVER'S formula scope is a strict subset of the browser's: `screen`,
 *    `forms`, `actions`, `records` and `datasets` are all empty in a server
 *    step. Nothing here reads `screen.params`: it resolves in preview and
 *    writes NULL in production, which for an audit register is the worst kind
 *    of wrong — a retirement row with no source on it is worse than no row.
 *
 *  • THE OPEN RECORD IS RE-READ, NOT REMEMBERED. `vars.source` is a snapshot
 *    taken when the row was clicked, and a snapshot goes stale the instant an
 *    action writes to it — `update_record` returns { id, updated, changes }, not
 *    the row, so nothing can refresh it in place. The Source screen therefore
 *    binds its detail panel to a LIVE query (`id == vars.source.id`) and uses
 *    the variable only to carry the id. Approve a source and the panel is
 *    correct on the next paint, because `refresh` invalidated the query it
 *    reads. A `record_detail` bound to `vars.source` would still be showing the
 *    old state — on the one screen where the state is the whole point.
 *
 *  • AN OPTIONAL FILTER whose formula resolves to null is OMITTED entirely.
 *    That is how one grid serves both "the whole register" and "just this
 *    base": `base_id` is optional everywhere it is a facet, so first open with
 *    nothing selected shows EVERYTHING rather than nothing. `required:true` is
 *    reserved for filters scoped to an OPEN RECORD, where showing everything
 *    would be showing another source's findings under this source's title.
 *
 *  • `filter_bar` publishes to ONE hardcoded variable, `vars.filters`. One per
 *    screen, and `filters` is never declared as a variable.
 *
 *  • A `height:'fill'` section stretches its FIRST grid row only. Every screen
 *    is one auto-height header section, then one fill section whose children
 *    are a single 12-column row.
 *
 *  • An aggregate binding with no explicit `limit` is silently capped at 50.
 *
 * ── WHAT THIS TEMPLATE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * It does not store a computed "risk score". A number that summarises the three
 * columns would be stale the day after it was written and would give a false
 * all-clear, which is the exact failure this register exists to prevent. The
 * counts on every screen are aggregates evaluated at read time.
 *
 * It does not run the personal-data scan itself. The scan button fires a
 * routine the customer wires up (Bee Flow's guard-service is the intended one),
 * and the screen says so in plain words rather than pretending the findings
 * appear by magic. A source admitted with `scanned_on` empty is not an error —
 * it is the gap, and the Review queue puts it next to the approve button.
 *
 * It requires no Nextcloud. Published into a Nextcloud page it resolves the
 * signed-in NC user as `currentUser`, which is what makes "approved by" and
 * "decided by" true without a second identity model — but standalone it is the
 * Bee Flow account, and nothing else changes.
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
// Three roles, and the split is the one a governance register actually needs.
// `default:'role'` inverts the default to deny, so every grant below is a
// decision rather than an oversight. The owner is never listed — resolveScope
// short-circuits them to full access.
//
// The auditor role is the point of the whole exercise: a DPO or an external
// assessor must be able to read every row of this register and change none of
// it. Read-everything/write-nothing is not a degraded steward, it is a distinct
// and necessary seat.
// ---------------------------------------------------------------------------

/** Bases, the review ladder and the legal bases: the steward's to change. */
const ACCESS_REGISTRY = {
    default: 'role',
    roles: {
        steward: { read: 'all', create: true, update: 'all', delete: 'all' },
        contributor: { read: 'all', create: false, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * Sources. Anyone may propose one — a knowledge base that only stewards can
 * feed is a knowledge base nobody feeds — but a contributor may only revise
 * what they themselves submitted, and only a steward may approve or delete.
 * `update:'own'` is what stops a contributor walking their own source up the
 * ladder after someone else reviewed it.
 */
const ACCESS_SOURCES = {
    default: 'role',
    roles: {
        steward: { read: 'all', create: true, update: 'all', delete: 'all' },
        contributor: { read: 'all', create: true, update: 'own', delete: 'own' },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * Personal-data findings. Only a steward decides one, because "accepted" here
 * is a statement about lawfulness, not a preference. Nobody may delete a
 * finding — deleting the evidence that a scan flagged something is precisely
 * the act this register exists to make impossible.
 */
const ACCESS_FINDINGS = {
    default: 'role',
    roles: {
        steward: { read: 'all', create: true, update: 'all', delete: false },
        contributor: { read: 'all', create: false, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/** Who may ask a base. The steward's alone — this is the breach surface. */
const ACCESS_GRANTS = {
    default: 'role',
    roles: {
        steward: { read: 'all', create: true, update: 'all', delete: 'all' },
        contributor: { read: 'all', create: false, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * The removal log. Append-only by design: a contributor may REQUEST a removal
 * and a steward confirms it, but no role may delete the record of one. An audit
 * trail you can edit away is not an audit trail.
 */
const ACCESS_RETIREMENTS = {
    default: 'role',
    roles: {
        steward: { read: 'all', create: true, update: 'all', delete: false },
        contributor: { read: 'all', create: true, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

// ---------------------------------------------------------------------------
// Vocabularies
//
// Two kinds, and which kind a thing is decides whether it is a config table or
// a select field. See the module header.
// ---------------------------------------------------------------------------

const COLOR_OPTIONS = [
    { value: 'primary', label: 'Primary' },
    { value: 'neutral', label: 'Neutral' },
    { value: 'success', label: 'Green' },
    { value: 'warning', label: 'Amber' },
    { value: 'danger', label: 'Red' },
    { value: 'info', label: 'Blue' },
];

/**
 * What a review state COUNTS AS. Four rungs, and the app reasons in these — not
 * in the state keys — so a customer can rename or insert states without any
 * screen going blank. `live` is the only stage that may answer; `closed` must
 * not be in the index.
 */
const STAGE_OPTIONS = [
    { value: 'intake', label: 'Intake — submitted' },
    { value: 'in_review', label: 'In review' },
    { value: 'live', label: 'Live — may answer' },
    { value: 'closed', label: 'Closed — must not answer' },
];

/** The classification the base carries, and every source in it inherits. */
const CLASSIFICATION_OPTIONS = [
    { value: 'public', label: 'Public' },
    { value: 'internal', label: 'Internal' },
    { value: 'confidential', label: 'Confidential' },
    { value: 'special', label: 'Special category (GDPR Art. 9)' },
];

/**
 * Where the retrieval pipeline actually has this source. PLATFORM vocabulary —
 * a fixed select, because these are the states the product can be in, not
 * states a customer may invent. `removal_pending` is the honest gap between
 * deciding to remove something and the index having dropped it.
 */
const INDEX_OPTIONS = [
    { value: 'not_indexed', label: 'Not indexed' },
    { value: 'indexed', label: 'Indexed — answering now' },
    { value: 'removal_pending', label: 'Removal pending' },
    { value: 'failed', label: 'Indexing failed' },
];

const SOURCE_KIND_OPTIONS = [
    { value: 'document', label: 'Document' },
    { value: 'web_page', label: 'Web page' },
    { value: 'feed', label: 'Synced feed' },
    { value: 'mailbox', label: 'Mailbox export' },
    { value: 'export', label: 'System export' },
    { value: 'manual_note', label: 'Hand-written note' },
];

/**
 * The detector's labels, not the customer's. These mirror what a PII scan
 * emits, which is why they are a fixed select: renaming them here would not
 * rename them in the scanner, and the two would silently disagree.
 */
const PII_CATEGORY_OPTIONS = [
    { value: 'name', label: 'Name' },
    { value: 'contact', label: 'Contact details' },
    { value: 'national_id', label: 'National identifier' },
    { value: 'financial', label: 'Financial details' },
    { value: 'health', label: 'Health data (Art. 9)' },
    { value: 'biometric', label: 'Biometric data (Art. 9)' },
    { value: 'location', label: 'Location' },
    { value: 'credential', label: 'Credential or secret' },
    { value: 'other', label: 'Other' },
];

const SEVERITY_OPTIONS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
];

/** What was decided about a finding. `open` is the only one that is not a decision. */
const DECISION_OPTIONS = [
    { value: 'open', label: 'Open — not yet decided' },
    { value: 'redacted', label: 'Redacted in the source' },
    { value: 'accepted', label: 'Accepted — lawful and necessary' },
    { value: 'removed', label: 'Source removed' },
];

/** Who is asking. An assistant and a person are different risks. */
const GRANTEE_OPTIONS = [
    { value: 'assistant', label: 'Assistant' },
    { value: 'agent', label: 'Automated agent' },
    { value: 'group', label: 'Group' },
    { value: 'user', label: 'Person' },
];

const RETIRE_REASON_OPTIONS = [
    { value: 'review_overdue', label: 'Review overdue' },
    { value: 'permission_withdrawn', label: 'Permission withdrawn' },
    { value: 'superseded', label: 'Superseded by a newer source' },
    { value: 'pii_unresolved', label: 'Unresolved personal data' },
    { value: 'duplicate', label: 'Duplicate' },
    { value: 'other', label: 'Other' },
];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const dataModel = {
    modelVersion: 1,
    roles: [
        { key: 'steward', label: 'Knowledge steward' },
        { key: 'contributor', label: 'Contributor' },
        { key: 'auditor', label: 'Auditor / DPO' },
    ],
    // A new colleague lands as a contributor: they can propose material and read
    // the register, and they cannot approve anything.
    roleMapping: { default: 'contributor', byGroup: {} },
    tables: [
        // ── Configuration ──────────────────────────────────────────────────
        {
            id: 'tbl_kbases1',
            key: 'knowledge_bases',
            name: 'Knowledge bases',
            icon: 'BookOpen',
            access: ACCESS_REGISTRY,
            fields: [
                { id: 'fld_kbname1', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_kbpurp1', key: 'purpose', type: 'text', required: false, unique: false },
                // A base without a named owner is a base nobody reviews. The
                // e-mail is the identity a viewer is matched against — the same
                // string embedded in Nextcloud and standalone.
                { id: 'fld_kbownn1', key: 'owner_name', type: 'text', required: false, unique: false },
                { id: 'fld_kbowne1', key: 'owner_email', type: 'text', required: false, unique: false },
                {
                    id: 'fld_kbclas1', key: 'classification', type: 'select', required: true, unique: false,
                    options: CLASSIFICATION_OPTIONS, default: 'internal',
                },
                // Free text, because "where does this actually live" is a
                // sentence ("EU — Frankfurt, self-hosted") more often than it is
                // an enum, and a wrong enum here reads as an assurance.
                { id: 'fld_kbresi1', key: 'data_residency', type: 'text', required: false, unique: false },
                { id: 'fld_kbactv1', key: 'is_active', type: 'bool', required: false, unique: false, default: true },
                { id: 'fld_kbpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_rstate1',
            key: 'review_states',
            name: 'Review states',
            icon: 'ListChecks',
            access: ACCESS_REGISTRY,
            fields: [
                // The KEY is what a source stores. Unique, because two states
                // sharing a key would merge two rungs of the approval ladder.
                { id: 'fld_rskey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_rsname1', key: 'name', type: 'text', required: true, unique: false },
                // The rung this state counts as. Every screen reasons in these,
                // never in the key — see the module header.
                {
                    id: 'fld_rscat01', key: 'category', type: 'select', required: true, unique: false,
                    options: STAGE_OPTIONS, default: 'intake',
                },
                {
                    id: 'fld_rscol01', key: 'color', type: 'select', required: false, unique: false,
                    options: COLOR_OPTIONS, default: 'neutral',
                },
                // The policy statement, in data: may a source in this state be
                // in the retrieval index at all? The Retirements screen exists
                // because this is routinely true in the register and false in
                // the pipeline, or the other way round.
                { id: 'fld_rsidx01', key: 'may_be_indexed', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_rspos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_lbasis1',
            key: 'legal_bases',
            name: 'Legal bases',
            icon: 'ShieldCheck',
            access: ACCESS_REGISTRY,
            fields: [
                { id: 'fld_lbkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_lbname1', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_lbdesc1', key: 'description', type: 'text', required: false, unique: false },
                // Some bases need a document behind them (a consent record, a
                // licence). Flagging which is a policy the customer sets, not a
                // rule the app should presume.
                { id: 'fld_lbevd01', key: 'requires_evidence', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_lbpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },

        // ── The register ───────────────────────────────────────────────────
        {
            id: 'tbl_source1',
            key: 'sources',
            name: 'Sources',
            icon: 'FileCheck',
            access: ACCESS_SOURCES,
            fields: [
                { id: 'fld_srtitl1', key: 'title', type: 'text', required: true, unique: false },
                { id: 'fld_srbase1', key: 'base_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_kbases1' } },
                // DENORMALISED label. No joins, so a grid that shows which base
                // a source belongs to has to read a column the row carries.
                { id: 'fld_srbasn1', key: 'base_name', type: 'text', required: false, unique: false },
                { id: 'fld_srorig1', key: 'origin', type: 'text', required: false, unique: false },
                {
                    id: 'fld_srkind1', key: 'source_kind', type: 'select', required: false, unique: false,
                    options: SOURCE_KIND_OPTIONS, default: 'document',
                },
                { id: 'fld_srsupn1', key: 'supplied_by', type: 'text', required: false, unique: false },
                { id: 'fld_srsupe1', key: 'supplied_by_email', type: 'text', required: false, unique: false },
                { id: 'fld_sradd01', key: 'added_on', type: 'date', required: false, unique: false },

                // ── The permission to use it at all ────────────────────────
                // A key into legal_bases — text, not select, so the customer
                // owns the list.
                { id: 'fld_srlbas1', key: 'legal_basis', type: 'text', required: false, unique: false },
                { id: 'fld_srperm1', key: 'permission_note', type: 'text', required: false, unique: false },

                // ── The three columns that must be allowed to disagree ─────
                { id: 'fld_srstat1', key: 'review_state', type: 'text', required: false, unique: false, default: 'submitted' },
                // Denormalised copy of the chosen state's CATEGORY. The queue,
                // the register and every "is this live" filter read this,
                // because the category lives on another table and there are no
                // joins. act_setstate writes both, always together.
                { id: 'fld_srstag1', key: 'review_stage', type: 'text', required: false, unique: false, default: 'intake' },
                {
                    id: 'fld_sridx01', key: 'index_state', type: 'select', required: false, unique: false,
                    options: INDEX_OPTIONS, default: 'not_indexed',
                },
                { id: 'fld_srdue01', key: 'review_due', type: 'date', required: false, unique: false },

                // Empty means NEVER SCANNED, and that is the interesting gap —
                // not a zero, not a default. A source admitted to a base with
                // this blank has never been checked for personal data.
                { id: 'fld_srscan1', key: 'scanned_on', type: 'date', required: false, unique: false },
                { id: 'fld_srpers1', key: 'contains_personal_data', type: 'bool', required: false, unique: false, default: false },

                { id: 'fld_srmon01', key: 'retention_months', type: 'number', subtype: 'integer', required: false, unique: false, default: 12 },
                { id: 'fld_srappn1', key: 'approved_by', type: 'text', required: false, unique: false },
                { id: 'fld_srappd1', key: 'approved_on', type: 'date', required: false, unique: false },
                { id: 'fld_srnote1', key: 'notes', type: 'richtext', required: false, unique: false },
                { id: 'fld_srfile1', key: 'evidence', type: 'file', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_finds01',
            key: 'pii_findings',
            name: 'Personal-data findings',
            icon: 'AlertTriangle',
            access: ACCESS_FINDINGS,
            fields: [
                { id: 'fld_pfsrc01', key: 'source_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_source1' } },
                // Denormalised so the triage grid reads as sentences without a
                // join, and so a finding stays legible after its source moves.
                { id: 'fld_pfstit1', key: 'source_title', type: 'text', required: false, unique: false },
                { id: 'fld_pfbasn1', key: 'base_name', type: 'text', required: false, unique: false },
                {
                    id: 'fld_pfcat01', key: 'category', type: 'select', required: true, unique: false,
                    options: PII_CATEGORY_OPTIONS, default: 'contact',
                },
                {
                    id: 'fld_pfsev01', key: 'severity', type: 'select', required: false, unique: false,
                    options: SEVERITY_OPTIONS, default: 'medium',
                },
                // WHAT was found, never the value itself. A register that quotes
                // the personal data it flagged has become a second copy of it.
                { id: 'fld_pfwhat1', key: 'finding', type: 'text', required: true, unique: false },
                { id: 'fld_pfloc01', key: 'location', type: 'text', required: false, unique: false },
                { id: 'fld_pfdet01', key: 'detected_on', type: 'date', required: false, unique: false },
                { id: 'fld_pfspec1', key: 'is_special_category', type: 'bool', required: false, unique: false, default: false },
                {
                    id: 'fld_pfdec01', key: 'decision', type: 'select', required: false, unique: false,
                    options: DECISION_OPTIONS, default: 'open',
                },
                { id: 'fld_pfdecn1', key: 'decided_by', type: 'text', required: false, unique: false },
                { id: 'fld_pfdecd1', key: 'decided_on', type: 'date', required: false, unique: false },
                { id: 'fld_pfrat01', key: 'rationale', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_grant01',
            key: 'access_grants',
            name: 'Access grants',
            icon: 'UserCheck',
            access: ACCESS_GRANTS,
            fields: [
                { id: 'fld_agbase1', key: 'base_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_kbases1' } },
                { id: 'fld_agbasn1', key: 'base_name', type: 'text', required: false, unique: false },
                {
                    id: 'fld_agkind1', key: 'grantee_kind', type: 'select', required: true, unique: false,
                    options: GRANTEE_OPTIONS, default: 'assistant',
                },
                { id: 'fld_agname1', key: 'grantee_name', type: 'text', required: true, unique: false },
                // Purpose limitation, in a column. A grant with no stated
                // purpose is the one nobody can defend later.
                { id: 'fld_agpurp1', key: 'purpose', type: 'text', required: false, unique: false },
                { id: 'fld_aggby01', key: 'granted_by', type: 'text', required: false, unique: false },
                { id: 'fld_aggon01', key: 'granted_on', type: 'date', required: false, unique: false },
                { id: 'fld_agexp01', key: 'expires_on', type: 'date', required: false, unique: false },
                // Reading a base to answer a question and being able to hand the
                // whole document back are different permissions.
                { id: 'fld_agexpt1', key: 'can_export', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_agactv1', key: 'is_active', type: 'bool', required: false, unique: false, default: true },
            ],
        },
        {
            id: 'tbl_retire1',
            key: 'retirements',
            name: 'Retirements',
            icon: 'History',
            access: ACCESS_RETIREMENTS,
            fields: [
                { id: 'fld_rtsrc01', key: 'source_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_source1' } },
                { id: 'fld_rtstit1', key: 'source_title', type: 'text', required: false, unique: false },
                { id: 'fld_rtbasn1', key: 'base_name', type: 'text', required: false, unique: false },
                {
                    id: 'fld_rtrsn01', key: 'reason', type: 'select', required: true, unique: false,
                    options: RETIRE_REASON_OPTIONS, default: 'review_overdue',
                },
                { id: 'fld_rtreqb1', key: 'requested_by', type: 'text', required: false, unique: false },
                { id: 'fld_rtreqd1', key: 'requested_on', type: 'date', required: false, unique: false },
                // THE column this whole table exists for. Deciding to remove
                // something and the index having dropped it are two events, and
                // the gap between them is where an organisation keeps answering
                // from material it has already said it must not use.
                { id: 'fld_rtidx01', key: 'index_removed', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_rtremd1', key: 'removed_on', type: 'date', required: false, unique: false },
                { id: 'fld_rtnote1', key: 'note', type: 'text', required: false, unique: false },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Shared vocabularies for the SCREENS.
//
// `filter_bar.options`, `data_grid.columns` and `input_select.options` are
// author-time lists, not bindings. So a review state added on Setup appears in
// the Source screen's state picker (which IS bound to the table) and in every
// grid cell, but not in the filter bar's dropdown until an editor adds it.
// That is a platform limit rather than a modelling choice, and the Setup screen
// says so rather than leaving it to be discovered.
// ---------------------------------------------------------------------------

/** The four rungs, with tone. Screens reason in these, not in state keys. */
const STAGE_TONES = [
    { value: 'intake', label: 'Intake', tone: 'neutral' },
    { value: 'in_review', label: 'In review', tone: 'info' },
    { value: 'live', label: 'Live', tone: 'success' },
    { value: 'closed', label: 'Closed', tone: 'neutral' },
];

const INDEX_TONES = [
    { value: 'indexed', label: 'Indexed', tone: 'primary' },
    { value: 'removal_pending', label: 'Removal pending', tone: 'warning' },
    { value: 'not_indexed', label: 'Not indexed', tone: 'neutral' },
    { value: 'failed', label: 'Failed', tone: 'danger' },
];

const CLASSIFICATION_TONES = [
    { value: 'public', label: 'Public', tone: 'neutral' },
    { value: 'internal', label: 'Internal', tone: 'info' },
    { value: 'confidential', label: 'Confidential', tone: 'warning' },
    { value: 'special', label: 'Art. 9', tone: 'danger' },
];

const STAGE_FILTER_OPTIONS = STAGE_OPTIONS.map((s) => ({ value: s.value, label: s.label }));
const INDEX_FILTER_OPTIONS = INDEX_OPTIONS.map((s) => ({ value: s.value, label: s.label }));

/**
 * THE DANGEROUS ROW, as three clauses on one table.
 *
 * Live (a human said it may answer) + indexed (the pipeline has it) + review
 * date already gone. Each is a column of `sources`, which is the only reason
 * this is expressible at all — see the module header. `base_id` is optional, so
 * with no base selected this is the whole organisation, which is exactly what
 * somebody opening the app cold should be shown.
 */
const OVERDUE_FILTER = [
    { field: 'review_stage', op: 'eq', value: 'live' },
    { field: 'index_state', op: 'eq', value: 'indexed' },
    { field: 'review_due', op: 'lt', value: { kind: 'formula', expr: 'today' } },
    { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
];

/** Retired (or otherwise closed) and still in the index. The other disagreement. */
const ZOMBIE_FILTER = [
    { field: 'review_stage', op: 'eq', value: 'closed' },
    { field: 'index_state', op: 'eq', value: 'indexed' },
    { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
];

/** Indexed, answering questions, and never once checked for personal data. */
const UNSCANNED_FILTER = [
    { field: 'index_state', op: 'eq', value: 'indexed' },
    { field: 'scanned_on', op: 'isNull' },
    { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
];

/** The base list every screen picks its scope from. */
const BASES_BINDING = {
    kind: 'records',
    tableId: 'tbl_kbases1',
    sort: [{ field: 'position', dir: 'asc' }],
    limit: 50,
};

const basesList = (id, span) => ({
    id,
    type: 'list',
    props: {
        source: BASES_BINDING,
        titleKey: 'name',
        subtitleKey: 'purpose',
        metaKey: 'owner_name',
        timestampKey: null,
        badgeKey: 'classification',
        badgeToneMap: CLASSIFICATION_TONES,
        unreadKey: null,
        selectedWhen: 'item.id == vars.base.id',
        icon: 'BookOpen',
        emptyText: 'No knowledge bases yet — add one on Setup.',
    },
    style: { span, height: 'fill' },
    visible: true,
    onRowClick: 'act_pickbase',
});

/** Count of `sources` matching a filter. Aggregates cap at 50 without a limit. */
const sourceCount = (filter) => ({
    kind: 'aggregate',
    tableId: 'tbl_source1',
    aggregates: [{ fn: 'count', field: '*', as: 'n' }],
    filter,
    limit: 1,
});

// ==================================================================
// REGISTER — what is answering right now, and what should not be.
// ==================================================================
const SCREEN_REGISTER = {
    id: 'scr_register',
    name: 'Register',
    icon: 'ShieldCheck',
    showInNav: true,
    maxWidth: 'full',
    description: 'What the assistants can read, and what is past its review date.',
    sections: [
        {
            id: 'sec_rgtop',
            // The home screen opens on the soft primary gradient wash — the
            // "cloud" hero band the accent-edged KPI tiles sit on.
            style: { padding: 4, gap: 3, background: 'gradient' },
            children: [
                {
                    id: 'cmp_rghdr',
                    type: 'page_header',
                    props: {
                        title: 'Knowledge register',
                        subtitle: 'Every source an assistant may repeat. Pick a base to narrow the numbers; with none picked these are the whole organisation.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'ShieldCheck',
                        showDivider: false,
                        look: 'split',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_rgclr',
                            type: 'button',
                            props: { label: 'All bases', variant: 'ghost', iconLeft: 'X', role: 'button' },
                            style: { span: 3 },
                            visible: { kind: 'formula', expr: 'vars.base.id' },
                            onClick: 'act_clearbase',
                        },
                    ],
                },
                {
                    id: 'cmp_rgstat1',
                    type: 'stat',
                    props: {
                        label: 'Answering now',
                        value: sourceCount([
                            { field: 'index_state', op: 'eq', value: 'indexed' },
                            { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                        ]),
                        caption: 'sources in the retrieval index',
                        look: 'accent',
                        icon: 'BookOpen',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    // The headline number of the whole app.
                    id: 'cmp_rgstat2',
                    type: 'stat',
                    props: {
                        label: 'Past review, still answering',
                        value: sourceCount(OVERDUE_FILTER),
                        caption: 'approved once, never re-checked',
                        look: 'accent',
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
                    id: 'cmp_rgstat3',
                    type: 'stat',
                    props: {
                        label: 'Never scanned',
                        value: sourceCount(UNSCANNED_FILTER),
                        caption: 'indexed without a personal-data scan',
                        look: 'accent',
                        icon: 'Search',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3, color: 'warning' },
                    visible: true,
                },
                {
                    id: 'cmp_rgstat4',
                    type: 'stat',
                    props: {
                        label: 'Retired but indexed',
                        value: sourceCount(ZOMBIE_FILTER),
                        caption: 'closed in the register, live in the index',
                        look: 'accent',
                        icon: 'History',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_rgwarn',
                    type: 'callout',
                    props: {
                        title: 'Why this list is the point',
                        text: 'A source below is **approved**, **in the index** and **past its review date**. Nothing is broken and no alarm has fired — it is simply still answering questions on material nobody has re-checked. Open one to re-review it, or request its removal.',
                        tone: 'danger',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            // One row of children: a fill section stretches its first row only.
            id: 'sec_rgmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                basesList('cmp_rgbases', 4),
                {
                    id: 'cmp_rggrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_source1',
                            filter: OVERDUE_FILTER,
                            // Longest overdue first: the oldest unreviewed answer
                            // is the one that has been wrong for longest.
                            sort: [{ field: 'review_due', dir: 'asc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'title', label: 'Source', format: 'text', width: 300, sortable: true, filterable: true, editable: false },
                            { key: 'base_name', label: 'Base', format: 'text', width: 170, sortable: true, filterable: true, editable: false },
                            { key: 'review_due', label: 'Review was due', format: 'date', width: 140, sortable: true, filterable: false, editable: false },
                            { key: 'legal_basis', label: 'Legal basis', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'approved_by', label: 'Approved by', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [
                            { label: 'Open', actionId: 'act_opensource' },
                            { label: 'Request removal', actionId: 'act_reqretire' },
                        ],
                        density: 'compact',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'Nothing is answering past its review date. That is the state this register is for.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// SOURCES — everything in the register, editable where it should be.
// ==================================================================
const SCREEN_SOURCES = {
    id: 'scr_sources',
    name: 'Sources',
    icon: 'FileCheck',
    showInNav: true,
    maxWidth: 'full',
    description: 'Every document and feed inside a base, and how it got there.',
    sections: [
        {
            id: 'sec_sctop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_schdr',
                    type: 'page_header',
                    props: {
                        title: 'Sources',
                        subtitle: 'Origin, legal basis and review date are editable inline — click a cell. Changing what a source COUNTS AS happens on its own screen.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'FileCheck',
                        showDivider: false,
                        look: 'split',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_scnew',
                            type: 'button',
                            props: { label: 'Add a source', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_scopen',
                        },
                    ],
                },
                {
                    // ONE filter_bar per screen — it publishes to the reserved
                    // vars.filters, which is never declared as a variable.
                    id: 'cmp_scfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search titles', type: 'search', options: [] },
                            { name: 'stage', label: 'Stage', type: 'select', options: STAGE_FILTER_OPTIONS },
                            { name: 'index_state', label: 'In the index', type: 'select', options: INDEX_FILTER_OPTIONS },
                            { name: 'overdue', label: 'Past review date', type: 'toggle', options: [] },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_scmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                basesList('cmp_scbases', 3),
                {
                    id: 'cmp_scgrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_source1',
                            filter: [
                                { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                                { field: 'title', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                { field: 'review_stage', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.stage' }, required: false },
                                { field: 'index_state', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.index_state' }, required: false },
                                // A toggle that is OFF must not mean "due today".
                                // It resolves to null and the clause drops out
                                // entirely — the same trick that lets one grid be
                                // both the full register and the overdue list.
                                { field: 'review_due', op: 'lt', value: { kind: 'formula', expr: 'vars.filters.overdue ? today : null' }, required: false },
                                // There is deliberately no "never scanned" toggle
                                // here: `isNull` takes no value, so it cannot be
                                // switched off by resolving to null the way the
                                // clause above can. A toggle that silently did
                                // nothing would be worse than no toggle — that
                                // query lives on the Review queue and the Register,
                                // where it is always on.
                            ],
                            sort: [{ field: 'review_due', dir: 'asc' }],
                            limit: 300,
                        },
                        columns: [
                            { key: 'title', label: 'Source', format: 'text', width: 280, sortable: true, filterable: true, editable: true },
                            { key: 'base_name', label: 'Base', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'source_kind', label: 'Kind', format: 'badge', width: 120, sortable: true, filterable: true, editable: true },
                            { key: 'origin', label: 'Origin', format: 'text', width: 230, sortable: false, filterable: true, editable: true },
                            { key: 'legal_basis', label: 'Legal basis', format: 'badge', width: 140, sortable: true, filterable: true, editable: true },
                            { key: 'review_state', label: 'State', format: 'badge', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'index_state', label: 'Index', format: 'badge', width: 140, sortable: true, filterable: true, editable: true },
                            { key: 'review_due', label: 'Review due', format: 'date', width: 130, sortable: true, filterable: false, editable: true },
                            // Editable, and it has to be: the scan is a routine
                            // the customer wires up, so until they do, "we
                            // looked and found nothing" has nowhere else to be
                            // recorded and every "never scanned" count on every
                            // screen would be stuck for good.
                            { key: 'scanned_on', label: 'Scanned', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                            { key: 'supplied_by', label: 'Supplied by', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 50,
                        // Inline editing requires selectable:'none' — with a
                        // selection mode, onRowSelect fires with { selected }
                        // instead of the edited row and every save would write
                        // nothing.
                        selectable: 'none',
                        searchable: true,
                        rowActions: [
                            { label: 'Open', actionId: 'act_opensource' },
                            { label: 'Request removal', actionId: 'act_reqretire' },
                        ],
                        density: 'compact',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'No sources match. Clear the filters, or add the first source to this base.',
                    },
                    style: { span: 9, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_scsave',
                },
            ],
        },
        {
            id: 'sec_scdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_scmodal',
                    type: 'modal',
                    props: { title: 'Add a source to this base', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_scform',
                            type: 'form',
                            props: { name: 'newsource', submitLabel: 'Submit for review', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sccreate',
                            children: [
                                { id: 'cmp_scf1', type: 'input_text', props: { name: 'title', label: 'Title', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                {
                                    id: 'cmp_scf2',
                                    type: 'input_select',
                                    props: { name: 'source_kind', label: 'Kind', required: false, options: SOURCE_KIND_OPTIONS, defaultValue: 'document', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                    style: { span: 4 },
                                    visible: true,
                                },
                                { id: 'cmp_scf3', type: 'input_text', props: { name: 'origin', label: 'Where it came from', placeholder: 'A path, a URL or the system it was exported from', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_scf4', type: 'input_text', props: { name: 'supplied_by', label: 'Supplied by', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_scf5', type: 'input_text', props: { name: 'supplied_by_email', label: 'Their e-mail', required: false, inputType: 'email' }, style: { span: 6 }, visible: true },
                                // The legal basis list is author-time here; the
                                // authoritative list is the legal_bases table on
                                // Setup, and the Setup screen says so.
                                {
                                    id: 'cmp_scf6',
                                    type: 'input_select',
                                    props: {
                                        name: 'legal_basis',
                                        label: 'Legal basis or permission to use it',
                                        required: true,
                                        options: [
                                            { value: 'consent', label: 'Consent (Art. 6(1)(a))' },
                                            { value: 'contract', label: 'Contract (Art. 6(1)(b))' },
                                            { value: 'legal_obligation', label: 'Legal obligation (Art. 6(1)(c))' },
                                            { value: 'legitimate_interest', label: 'Legitimate interests (Art. 6(1)(f))' },
                                            { value: 'licence', label: 'Licensed content' },
                                            { value: 'own_work', label: 'Own material' },
                                        ],
                                        defaultValue: 'own_work',
                                        placeholder: null,
                                        valueFrom: { kind: 'static', value: null },
                                    },
                                    style: { span: 6 },
                                    visible: true,
                                },
                                { id: 'cmp_scf7', type: 'input_date', props: { name: 'review_due', label: 'Review or retention date', required: true, defaultValue: null }, style: { span: 6 }, visible: true },
                                { id: 'cmp_scf8', type: 'input_text', props: { name: 'permission_note', label: 'What the permission actually says', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_scf9', type: 'input_checkbox', props: { name: 'contains_personal_data', label: 'I know this contains personal data', defaultChecked: false }, style: { span: 12 }, visible: true },
                                { id: 'cmp_scf10', type: 'input_textarea', props: { name: 'notes', label: 'Anything a reviewer should know', required: false, rows: 3 }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// SOURCE — one record, its findings, its removal history, and the
// approval ladder the customer configured.
// ==================================================================
const SCREEN_SOURCE = {
    id: 'scr_source',
    name: 'Source',
    icon: 'FileText',
    showInNav: false,
    maxWidth: 'wide',
    description: 'One source in full, with the decision that let it answer.',
    sections: [
        {
            id: 'sec_sotop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_sohdr',
                    type: 'page_header',
                    props: {
                        title: 'Source',
                        subtitle: null,
                        titleFrom: { kind: 'formula', expr: 'vars.source.title' },
                        subtitleFrom: { kind: 'formula', expr: 'vars.source.base_name' },
                        icon: 'FileText',
                        showDivider: true,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_soback',
                            type: 'button',
                            props: { label: 'Back to sources', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_gosources',
                        },
                    ],
                },
                // These three read 1 or 0 for THIS source. They are aggregates
                // rather than a formula over `vars.source`, because the variable
                // is a snapshot from the moment the row was clicked and would
                // still show the old answer after an approval — on the one
                // screen where the answer is the whole point.
                {
                    id: 'cmp_sostat1',
                    type: 'stat',
                    props: {
                        label: 'Open findings',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_finds01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'source_id', op: 'eq', value: { kind: 'formula', expr: 'vars.source.id' }, required: true },
                                { field: 'decision', op: 'eq', value: 'open' },
                            ],
                            limit: 1,
                        },
                        caption: 'personal data nobody has ruled on',
                        look: 'accent',
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
                    id: 'cmp_sostat2',
                    type: 'stat',
                    props: {
                        label: 'Answering past its review date',
                        value: sourceCount([
                            { field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.source.id' }, required: true },
                            { field: 'review_stage', op: 'eq', value: 'live' },
                            { field: 'index_state', op: 'eq', value: 'indexed' },
                            { field: 'review_due', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                        ]),
                        caption: '1 means this source is the problem',
                        look: 'accent',
                        icon: 'CalendarClock',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_sostat3',
                    type: 'stat',
                    props: {
                        label: 'Closed but still indexed',
                        value: sourceCount([
                            { field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.source.id' }, required: true },
                            { field: 'review_stage', op: 'eq', value: 'closed' },
                            { field: 'index_state', op: 'eq', value: 'indexed' },
                        ]),
                        caption: '1 means it is still being retrieved',
                        look: 'accent',
                        icon: 'History',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_sodet',
                    type: 'record_detail',
                    props: {
                        // A LIVE read of the open record, not `vars.source`. The
                        // variable carries the id; the panel re-reads the row, so
                        // an approval is visible on the next paint because
                        // act_setstate refreshed this table.
                        source: {
                            kind: 'records',
                            tableId: 'tbl_source1',
                            filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.source.id' }, required: true }],
                            limit: 1,
                        },
                        columns: 3,
                        fields: [
                            { key: 'review_state', label: 'State', format: 'badge' },
                            { key: 'review_stage', label: 'Counts as', format: 'badge' },
                            { key: 'index_state', label: 'In the index', format: 'badge' },
                            { key: 'review_due', label: 'Review due', format: 'date' },
                            { key: 'scanned_on', label: 'Last personal-data scan', format: 'date' },
                            { key: 'retention_months', label: 'Retention (months)', format: 'number' },
                            { key: 'legal_basis', label: 'Legal basis', format: 'badge' },
                            { key: 'permission_note', label: 'Permission', format: 'text' },
                            { key: 'origin', label: 'Origin', format: 'text' },
                            { key: 'supplied_by', label: 'Supplied by', format: 'text' },
                            { key: 'added_on', label: 'Added', format: 'date' },
                            { key: 'approved_by', label: 'Approved by', format: 'text' },
                            { key: 'approved_on', label: 'Approved on', format: 'date' },
                            { key: 'base_name', label: 'Knowledge base', format: 'text' },
                            { key: 'notes', label: 'Notes', format: 'markdown' },
                        ],
                        emptyText: 'Open a source from the Register or the Sources screen.',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_somain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    // THE APPROVAL CONTROL IS THE CONFIG TABLE. Not a dropdown of
                    // authored options: the rungs the customer put on Setup are
                    // literally the buttons here, in their order, with their
                    // colours. Add a "DPO sign-off" rung and it appears.
                    id: 'cmp_sostates',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_rstate1',
                            sort: [{ field: 'position', dir: 'asc' }],
                            limit: 24,
                        },
                        titleKey: 'name',
                        subtitleKey: 'key',
                        metaKey: null,
                        timestampKey: null,
                        badgeKey: 'category',
                        badgeToneMap: STAGE_TONES,
                        unreadKey: null,
                        // selectedWhen is type formula — a BARE STRING, never a
                        // { kind:'formula' } wrapper.
                        selectedWhen: 'item.key == vars.source.review_state',
                        icon: 'ListChecks',
                        emptyText: 'No review states configured — add them on Setup.',
                    },
                    style: { span: 3, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_setstate',
                },
                {
                    id: 'cmp_sofinds',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_finds01',
                            // required:true — scoped to the OPEN RECORD. Without
                            // it, an unopened source would list every finding in
                            // the workspace under this source's title.
                            filter: [{ field: 'source_id', op: 'eq', value: { kind: 'formula', expr: 'vars.source.id' }, required: true }],
                            sort: [{ field: 'detected_on', dir: 'desc' }],
                            limit: 100,
                        },
                        columns: [
                            { key: 'category', label: 'Category', format: 'badge', width: 140, sortable: true, filterable: true, editable: false },
                            { key: 'finding', label: 'What was flagged', format: 'text', width: 260, sortable: false, filterable: true, editable: false },
                            { key: 'severity', label: 'Severity', format: 'badge', width: 110, sortable: true, filterable: true, editable: false },
                            { key: 'decision', label: 'Decision', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 10,
                        selectable: 'none',
                        searchable: false,
                        rowActions: [],
                        density: 'compact',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'No personal-data findings recorded. If the scan date above is empty, that means nobody has looked.',
                    },
                    style: { span: 5, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_sohist',
                    type: 'timeline',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_retire1',
                            filter: [{ field: 'source_id', op: 'eq', value: { kind: 'formula', expr: 'vars.source.id' }, required: true }],
                            sort: [{ field: 'requested_on', dir: 'desc' }],
                            limit: 50,
                        },
                        titleKey: 'reason',
                        dateKey: 'requested_on',
                        descriptionKey: 'note',
                        icon: 'History',
                        rowLimit: 25,
                        emptyText: 'Never proposed for removal.',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_sorq',
            style: { padding: 4, gap: 3, background: 'surface' },
            children: [
                {
                    id: 'cmp_sorform',
                    type: 'form',
                    props: { name: 'retirereq', submitLabel: 'Propose removal', showReset: false, showSubmit: true },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_soretire',
                    children: [
                        {
                            id: 'cmp_sorf1',
                            type: 'input_select',
                            props: { name: 'reason', label: 'Reason for removal', required: true, options: RETIRE_REASON_OPTIONS, defaultValue: 'review_overdue', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 4 },
                            visible: true,
                        },
                        { id: 'cmp_sorf2', type: 'input_text', props: { name: 'note', label: 'What changed', required: false, inputType: 'text' }, style: { span: 8 }, visible: true },
                    ],
                },
                {
                    id: 'cmp_sorhint',
                    type: 'text',
                    props: {
                        text: 'Proposing a removal marks the source **removal pending** and logs it. It is not gone from the index until somebody confirms that on the Retirements screen — which is the gap this register exists to close.',
                        muted: true,
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        // Recording a finding by hand. The scan is a routine the customer wires
        // up, and it ships unset — so without this the findings table can only
        // ever be read, and the Personal-data screen's promise that "findings
        // are entered by hand until then" would be a promise no control keeps.
        // It lives HERE, not on the Personal-data screen, for the same reason
        // the retirement request does: a finding has to name the source it was
        // found in, `source_title` and `base_name` are denormalised copies of
        // that row, and this is the only screen where the open source is known.
        {
            id: 'sec_sofd',
            style: { padding: 4, gap: 3, background: 'surface' },
            children: [
                {
                    id: 'cmp_sofform',
                    type: 'form',
                    props: { name: 'newfinding', submitLabel: 'Record finding', showReset: false, showSubmit: true },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_pifcreate',
                    children: [
                        {
                            id: 'cmp_soff1',
                            type: 'input_select',
                            props: { name: 'category', label: 'What kind of personal data', required: true, options: PII_CATEGORY_OPTIONS, defaultValue: 'contact', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 3 },
                            visible: true,
                        },
                        {
                            id: 'cmp_soff2',
                            type: 'input_select',
                            props: { name: 'severity', label: 'Severity', required: false, options: SEVERITY_OPTIONS, defaultValue: 'medium', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 2 },
                            visible: true,
                        },
                        { id: 'cmp_soff3', type: 'input_text', props: { name: 'finding', label: 'What was flagged — describe it, never paste it', required: true, inputType: 'text' }, style: { span: 4 }, visible: true },
                        { id: 'cmp_soff4', type: 'input_text', props: { name: 'location', label: 'Where in the source', required: false, inputType: 'text' }, style: { span: 3 }, visible: true },
                        { id: 'cmp_soff5', type: 'input_checkbox', props: { name: 'is_special_category', label: 'Special category (Art. 9) — beliefs, union membership, sex life, ethnicity', defaultChecked: false }, style: { span: 12 }, visible: true },
                    ],
                },
                {
                    id: 'cmp_sofhint',
                    type: 'text',
                    props: {
                        text: 'A finding says WHAT was found and WHERE — never the value itself, or this register becomes a second copy of the data it is meant to police. Health and biometric findings are marked Art. 9 whether or not the box is ticked. Recording one does not mean the whole source has been checked: set **Scanned** on the Sources screen once it has.',
                        muted: true,
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// REVIEW QUEUE — what is waiting for a decision, next to the reason
// you should not make it yet.
// ==================================================================
const SCREEN_QUEUE = {
    id: 'scr_queue',
    name: 'Review queue',
    icon: 'Inbox',
    showInNav: true,
    maxWidth: 'full',
    description: 'Sources submitted or in review, waiting for a decision.',
    sections: [
        {
            id: 'sec_qutop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_quhdr',
                    type: 'page_header',
                    props: {
                        title: 'Review queue',
                        subtitle: 'Everything a human still has to decide about. Open a source to move it up the ladder — approval is a decision, so it happens on the record, not from a row menu.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'Inbox',
                        showDivider: false,
                        look: 'split',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_qustat1',
                    type: 'stat',
                    props: {
                        label: 'Waiting for a decision',
                        value: sourceCount([
                            { field: 'review_stage', op: 'in', value: ['intake', 'in_review'] },
                            { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                        ]),
                        caption: 'submitted or under review',
                        look: 'accent',
                        icon: 'Inbox',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_qustat2',
                    type: 'stat',
                    props: {
                        label: 'Waiting, never scanned',
                        value: sourceCount([
                            { field: 'review_stage', op: 'in', value: ['intake', 'in_review'] },
                            { field: 'scanned_on', op: 'isNull' },
                            { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                        ]),
                        caption: 'approving one of these is the risk',
                        look: 'accent',
                        icon: 'Search',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'warning' },
                    visible: true,
                },
                {
                    id: 'cmp_qustat3',
                    type: 'stat',
                    props: {
                        label: 'Waiting, no legal basis',
                        value: sourceCount([
                            { field: 'review_stage', op: 'in', value: ['intake', 'in_review'] },
                            { field: 'legal_basis', op: 'isNull' },
                            { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                        ]),
                        caption: 'nobody said why we may use it',
                        look: 'accent',
                        icon: 'ShieldCheck',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'warning' },
                    visible: true,
                },
                {
                    id: 'cmp_quwarn',
                    type: 'callout',
                    props: {
                        title: 'Before you approve',
                        text: 'The list on the right is everything in this queue that has **never been scanned for personal data**. Approving one of those puts unchecked material in front of every assistant that may read the base.',
                        tone: 'warning',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_qumain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_qugrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_source1',
                            filter: [
                                // `review_stage` is the denormalised copy of the
                                // state's category — the queue means "not decided
                                // yet", which is a property of the state row, and
                                // there is no join to reach it.
                                { field: 'review_stage', op: 'in', value: ['intake', 'in_review'] },
                                { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                            ],
                            // Oldest submission first: a queue that is not FIFO is
                            // a queue where the awkward source never gets looked at.
                            sort: [{ field: 'added_on', dir: 'asc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'title', label: 'Source', format: 'text', width: 280, sortable: true, filterable: true, editable: false },
                            { key: 'base_name', label: 'Base', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                            { key: 'review_state', label: 'State', format: 'badge', width: 140, sortable: true, filterable: true, editable: false },
                            { key: 'legal_basis', label: 'Legal basis', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'supplied_by', label: 'Supplied by', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                            { key: 'added_on', label: 'Submitted', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                            { key: 'scanned_on', label: 'Scanned', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Open to review', actionId: 'act_opensource' }],
                        density: 'compact',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'Nothing is waiting. Every source has been decided about.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_quunsc',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_source1',
                            filter: [
                                { field: 'review_stage', op: 'in', value: ['intake', 'in_review'] },
                                { field: 'scanned_on', op: 'isNull' },
                                { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                            ],
                            sort: [{ field: 'added_on', dir: 'asc' }],
                            limit: 100,
                        },
                        titleKey: 'title',
                        subtitleKey: 'base_name',
                        metaKey: 'supplied_by',
                        timestampKey: null,
                        badgeKey: 'review_stage',
                        badgeToneMap: STAGE_TONES,
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'Search',
                        emptyText: 'Everything in the queue has been scanned.',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_opensource',
                },
            ],
        },
    ],
};

// ==================================================================
// REVIEW CALENDAR — when each approval expires.
// ==================================================================
const SCREEN_RETENTION = {
    id: 'scr_reten',
    name: 'Review calendar',
    icon: 'CalendarClock',
    showInNav: true,
    maxWidth: 'full',
    description: 'When each approval expires, and what already has.',
    sections: [
        {
            id: 'sec_rttop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rthdr',
                    type: 'page_header',
                    props: {
                        title: 'Review calendar',
                        subtitle: 'An approval is a decision about a moment in time. This is when each of them runs out.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'CalendarClock',
                        showDivider: false,
                        look: 'split',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_rtstat1',
                    type: 'stat',
                    props: {
                        label: 'Already overdue',
                        value: sourceCount([
                            { field: 'review_due', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                            { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                        ]),
                        caption: 'review date has passed',
                        look: 'accent',
                        icon: 'AlertTriangle',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_rtstat2',
                    type: 'stat',
                    props: {
                        // No review date at all is a quieter failure than an
                        // overdue one: nothing will ever bring it back.
                        label: 'No review date set',
                        value: sourceCount([
                            { field: 'review_due', op: 'isNull' },
                            { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                        ]),
                        caption: 'these will never come up again',
                        look: 'accent',
                        icon: 'CalendarDays',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'warning' },
                    visible: true,
                },
                {
                    id: 'cmp_rtstat3',
                    type: 'stat',
                    props: {
                        label: 'Sources in the register',
                        value: sourceCount([
                            { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                        ]),
                        caption: 'across every state',
                        look: 'accent',
                        icon: 'FileCheck',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 4 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_rtmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_rtcal',
                    type: 'calendar',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_source1',
                            filter: [
                                { field: 'review_due', op: 'isNotNull' },
                                { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                            ],
                            sort: [{ field: 'review_due', dir: 'asc' }],
                            limit: 300,
                        },
                        dateKey: 'review_due',
                        endDateKey: null,
                        titleKey: 'title',
                        // Coloured by where the pipeline has it, so a cluster of
                        // indexed sources falling due in one week is visible as a
                        // block rather than a list.
                        colorKey: 'index_state',
                        view: 'month',
                        emptyText: 'No source has a review date yet.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_opensource',
                },
                {
                    id: 'cmp_rtover',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_source1',
                            filter: [
                                { field: 'review_due', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                                { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                            ],
                            sort: [{ field: 'review_due', dir: 'asc' }],
                            limit: 100,
                        },
                        titleKey: 'title',
                        subtitleKey: 'base_name',
                        metaKey: 'review_due',
                        timestampKey: null,
                        badgeKey: 'index_state',
                        badgeToneMap: INDEX_TONES,
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'AlertTriangle',
                        emptyText: 'Nothing is overdue.',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_opensource',
                },
            ],
        },
    ],
};

// ==================================================================
// PERSONAL DATA — what a scan flagged, and what was decided about it.
// ==================================================================
const SCREEN_PII = {
    id: 'scr_findings',
    name: 'Personal data',
    icon: 'AlertTriangle',
    showInNav: true,
    maxWidth: 'full',
    description: 'What a scan flagged inside a source, and the ruling on it.',
    sections: [
        {
            id: 'sec_pitop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_pihdr',
                    type: 'page_header',
                    props: {
                        title: 'Personal-data findings',
                        subtitle: 'Decision and rationale are editable inline. A finding is never deleted — an accepted one is a decision on the record, not an absence.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'AlertTriangle',
                        showDivider: false,
                        look: 'split',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_piscan',
                            type: 'button',
                            props: { label: 'Run the scan', variant: 'secondary', iconLeft: 'RefreshCw', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_runscan',
                        },
                    ],
                },
                {
                    id: 'cmp_pistat1',
                    type: 'stat',
                    props: {
                        label: 'Open findings',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_finds01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'decision', op: 'eq', value: 'open' }],
                            limit: 1,
                        },
                        caption: 'flagged, nobody has ruled',
                        look: 'accent',
                        icon: 'Inbox',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_pistat2',
                    type: 'stat',
                    props: {
                        label: 'Special category, open',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_finds01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'is_special_category', op: 'eq', value: true },
                                { field: 'decision', op: 'eq', value: 'open' },
                            ],
                            limit: 1,
                        },
                        caption: 'health, biometric and the like (Art. 9)',
                        look: 'accent',
                        icon: 'ShieldCheck',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_pistat3',
                    type: 'stat',
                    props: {
                        label: 'Indexed, never scanned',
                        value: sourceCount(UNSCANNED_FILTER),
                        caption: 'the gap these findings cannot describe',
                        look: 'accent',
                        icon: 'Search',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'warning' },
                    visible: true,
                },
                {
                    id: 'cmp_pinote',
                    type: 'callout',
                    props: {
                        title: 'The scan is a routine you wire up',
                        text: 'This app records findings; it does not detect them. **Run the scan** fires an automation which is not connected yet — point it at your PII detection service (Bee Flow ships one) in Automations, and its results land in this table. Until then, open a source and record findings by hand at the bottom of its screen; the "never scanned" number above is the honest picture, and the Scanned date is yours to set on the Sources screen.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
                {
                    id: 'cmp_pifilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search findings', type: 'search', options: [] },
                            { name: 'category', label: 'Category', type: 'select', options: PII_CATEGORY_OPTIONS },
                            { name: 'decision', label: 'Decision', type: 'select', options: DECISION_OPTIONS },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_pimain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_pigrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_finds01',
                            filter: [
                                { field: 'finding', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                { field: 'category', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.category' }, required: false },
                                { field: 'decision', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.decision' }, required: false },
                            ],
                            // Open first, then most recent — triage order.
                            sort: [{ field: 'decision', dir: 'asc' }, { field: 'detected_on', dir: 'desc' }],
                            limit: 300,
                        },
                        columns: [
                            { key: 'source_title', label: 'Source', format: 'text', width: 240, sortable: true, filterable: true, editable: false },
                            { key: 'base_name', label: 'Base', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'category', label: 'Category', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'finding', label: 'What was flagged', format: 'text', width: 280, sortable: false, filterable: true, editable: false },
                            { key: 'location', label: 'Where', format: 'text', width: 160, sortable: false, filterable: false, editable: false },
                            { key: 'severity', label: 'Severity', format: 'badge', width: 110, sortable: true, filterable: true, editable: true },
                            { key: 'is_special_category', label: 'Art. 9', format: 'boolean', width: 90, sortable: true, filterable: true, editable: false },
                            { key: 'decision', label: 'Decision', format: 'badge', width: 170, sortable: true, filterable: true, editable: true },
                            { key: 'rationale', label: 'Rationale', format: 'text', width: 260, sortable: false, filterable: false, editable: true },
                            { key: 'decided_by', label: 'Decided by', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 50,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [],
                        density: 'compact',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'No findings recorded. That is either good news or nobody has scanned anything — the third number above tells you which.',
                    },
                    style: { span: 12, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_pisave',
                },
            ],
        },
    ],
};

// ==================================================================
// ACCESS — who may ask this base a question.
// ==================================================================
const SCREEN_ACCESS = {
    id: 'scr_access',
    name: 'Access',
    icon: 'UserCheck',
    showInNav: true,
    maxWidth: 'full',
    description: 'Which assistants, agents and groups may read which base.',
    sections: [
        {
            id: 'sec_actop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_achdr',
                    type: 'page_header',
                    props: {
                        title: 'Who may ask',
                        subtitle: 'A knowledge base becomes a breach at the moment somebody is granted access to it who should not have been. Every grant here says who, why, and until when.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'UserCheck',
                        showDivider: false,
                        look: 'split',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_acnew',
                            type: 'button',
                            props: { label: 'Grant access', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_agopen',
                        },
                    ],
                },
                {
                    id: 'cmp_acstat1',
                    type: 'stat',
                    props: {
                        label: 'Active grants',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_grant01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'is_active', op: 'eq', value: true },
                                { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                            ],
                            limit: 1,
                        },
                        caption: 'can ask right now',
                        look: 'accent',
                        icon: 'Users',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_acstat2',
                    type: 'stat',
                    props: {
                        // Expired on paper, still switched on. The access-side
                        // twin of "retired but still indexed".
                        label: 'Expired but still active',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_grant01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'is_active', op: 'eq', value: true },
                                { field: 'expires_on', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                                { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                            ],
                            limit: 1,
                        },
                        caption: 'past their end date and never revoked',
                        look: 'accent',
                        icon: 'AlertTriangle',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_acstat3',
                    type: 'stat',
                    props: {
                        label: 'May hand back the document',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_grant01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [
                                { field: 'is_active', op: 'eq', value: true },
                                { field: 'can_export', op: 'eq', value: true },
                                { field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false },
                            ],
                            limit: 1,
                        },
                        caption: 'not just answer from it',
                        look: 'accent',
                        icon: 'ExternalLink',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'warning' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_acmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                basesList('cmp_acbases', 3),
                {
                    id: 'cmp_acgrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_grant01',
                            filter: [{ field: 'base_id', op: 'eq', value: { kind: 'formula', expr: 'vars.base.id' }, required: false }],
                            sort: [{ field: 'expires_on', dir: 'asc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'grantee_name', label: 'Who', format: 'text', width: 210, sortable: true, filterable: true, editable: true },
                            { key: 'grantee_kind', label: 'Kind', format: 'badge', width: 130, sortable: true, filterable: true, editable: true },
                            { key: 'base_name', label: 'May read', format: 'text', width: 180, sortable: true, filterable: true, editable: false },
                            { key: 'purpose', label: 'For what', format: 'text', width: 280, sortable: false, filterable: true, editable: true },
                            { key: 'expires_on', label: 'Until', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                            { key: 'can_export', label: 'May export', format: 'boolean', width: 110, sortable: true, filterable: true, editable: true },
                            { key: 'is_active', label: 'Active', format: 'boolean', width: 90, sortable: true, filterable: true, editable: true },
                            { key: 'granted_by', label: 'Granted by', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 50,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Revoke', actionId: 'act_agrevoke' }],
                        density: 'compact',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'Nobody has been granted access to this base yet.',
                    },
                    style: { span: 9, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_agsave',
                },
            ],
        },
        {
            id: 'sec_acdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_acmodal',
                    type: 'modal',
                    props: { title: 'Grant access to this base', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_acform',
                            type: 'form',
                            props: { name: 'newgrant', submitLabel: 'Grant access', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_agcreate',
                            children: [
                                { id: 'cmp_acf1', type: 'input_text', props: { name: 'grantee_name', label: 'Assistant, agent, group or person', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                {
                                    id: 'cmp_acf2',
                                    type: 'input_select',
                                    props: { name: 'grantee_kind', label: 'Kind', required: true, options: GRANTEE_OPTIONS, defaultValue: 'assistant', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                    style: { span: 4 },
                                    visible: true,
                                },
                                { id: 'cmp_acf3', type: 'input_text', props: { name: 'purpose', label: 'What they need it for', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_acf4', type: 'input_date', props: { name: 'expires_on', label: 'Access ends on', required: true, defaultValue: null }, style: { span: 6 }, visible: true },
                                { id: 'cmp_acf5', type: 'input_checkbox', props: { name: 'can_export', label: 'May hand back whole documents, not just answers', defaultChecked: false }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// RETIREMENTS — the audit trail, and the gap it exists to close.
// ==================================================================
const SCREEN_RETIRE = {
    id: 'scr_retire',
    name: 'Retirements',
    icon: 'History',
    showInNav: true,
    maxWidth: 'full',
    description: 'What was removed, why, and whether the index actually dropped it.',
    sections: [
        {
            id: 'sec_rrtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rrhdr',
                    type: 'page_header',
                    props: {
                        title: 'Retirements',
                        subtitle: 'Deciding to remove a source and the index having dropped it are two events. Confirm the second one here.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'History',
                        showDivider: false,
                        look: 'split',
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_rrstat1',
                    type: 'stat',
                    props: {
                        label: 'Awaiting removal',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_retire1',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'index_removed', op: 'eq', value: false }],
                            limit: 1,
                        },
                        caption: 'decided, not yet out of the index',
                        look: 'accent',
                        icon: 'AlertTriangle',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_rrstat2',
                    type: 'stat',
                    props: {
                        label: 'Removed',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_retire1',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'index_removed', op: 'eq', value: true }],
                            limit: 1,
                        },
                        caption: 'confirmed out of the index',
                        look: 'accent',
                        icon: 'CheckCircle2',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_rrstat3',
                    type: 'stat',
                    props: {
                        // Read from the SOURCES side, not the retirements side:
                        // a source can be closed and indexed without anyone ever
                        // having logged a retirement for it.
                        label: 'Closed but still indexed',
                        value: sourceCount(ZOMBIE_FILTER),
                        caption: 'sources, however they got there',
                        look: 'accent',
                        icon: 'BookOpen',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 4, color: 'danger' },
                    visible: true,
                },
                {
                    id: 'cmp_rrwarn',
                    type: 'callout',
                    props: {
                        title: 'A retired source that is still indexed is the failure this register exists to prevent',
                        text: 'Confirming a removal here marks the log entry **removed**, and sets the source back to **not indexed** so no screen claims it is still answering. Do it only once the retrieval index has genuinely dropped the material.',
                        tone: 'danger',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_rrmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_rrgrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_retire1',
                            // Unconfirmed first, then newest — the work is at the top.
                            sort: [{ field: 'index_removed', dir: 'asc' }, { field: 'requested_on', dir: 'desc' }],
                            limit: 300,
                        },
                        columns: [
                            { key: 'source_title', label: 'Source', format: 'text', width: 280, sortable: true, filterable: true, editable: false },
                            { key: 'base_name', label: 'Base', format: 'text', width: 170, sortable: true, filterable: true, editable: false },
                            { key: 'reason', label: 'Why', format: 'badge', width: 200, sortable: true, filterable: true, editable: false },
                            { key: 'note', label: 'What changed', format: 'text', width: 280, sortable: false, filterable: true, editable: false },
                            { key: 'requested_by', label: 'Requested by', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                            { key: 'requested_on', label: 'Requested', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                            { key: 'index_removed', label: 'Out of the index', format: 'boolean', width: 140, sortable: true, filterable: true, editable: false },
                            { key: 'removed_on', label: 'Confirmed', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                        ],
                        pageSize: 50,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Confirm removed from index', actionId: 'act_confirmrm' }],
                        density: 'compact',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'Nothing has been proposed for removal. Propose one from a source, or from the Register.',
                    },
                    style: { span: 12, height: 'fill' },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// SETUP — the vocabularies that make the register the customer's own.
// ==================================================================
const SCREEN_SETUP = {
    id: 'scr_setup',
    name: 'Setup',
    icon: 'TableProperties',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Bases, the review ladder and the legal bases you recognise.',
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
                        subtitle: 'The approval ladder and the legal bases are data, not code — add a rung here and it appears as a control on every source.',
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
                        title: 'Three things to know',
                        text: '**Counts as** is what the app reasons in — only `live` may answer, and `closed` must not be in the index. Rename a state freely; change what it counts as and sources already in it keep their old rung until someone sets their state again.\n\nThe Stage and Legal basis dropdowns in the filter bars and the add-a-source form are fixed lists. A rung or a basis you add here shows up on every source and in every grid, but not in those dropdowns until an editor adds it there too.\n\nA rung or a legal basis can be deleted — sources keep the key they already store, so nothing moves screens. A knowledge base cannot: its sources, grants and findings carry its name as a copy, and deleting it would leave them answering with nothing to reach them by. Untick **Active** instead.',
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
                    // tabs accepts span + gap + padding, never height.
                    id: 'cmp_sutabs',
                    type: 'tabs',
                    props: {},
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sutab1',
                            type: 'tab',
                            props: { label: 'Knowledge bases', icon: 'BookOpen' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sukb',
                                    type: 'data_grid',
                                    props: {
                                        source: BASES_BINDING,
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'name', label: 'Name', format: 'text', width: 200, sortable: true, filterable: true, editable: true },
                                            { key: 'purpose', label: 'What it is for', format: 'text', width: 280, sortable: false, filterable: false, editable: true },
                                            { key: 'classification', label: 'Classification', format: 'badge', width: 190, sortable: true, filterable: true, editable: true },
                                            { key: 'owner_name', label: 'Owner', format: 'text', width: 160, sortable: true, filterable: true, editable: true },
                                            { key: 'owner_email', label: 'Owner e-mail', format: 'text', width: 220, sortable: false, filterable: false, editable: true },
                                            { key: 'data_residency', label: 'Where it lives', format: 'text', width: 180, sortable: false, filterable: false, editable: true },
                                            { key: 'is_active', label: 'Active', format: 'boolean', width: 90, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No knowledge bases yet — add one below.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sukbsave',
                                },
                                // NO Delete row action here, and that is a
                                // decision rather than an omission. Sources,
                                // grants, findings and retirements all carry
                                // base_id plus a denormalised base_name, and
                                // there are no joins — so nothing on this row
                                // can tell whether the base still holds
                                // anything. Deleting one that does would leave
                                // its sources in place, still indexed, still
                                // answering, attached to a base no list can
                                // reach: precisely the "answering with nobody
                                // watching" failure the register exists to
                                // catch. `is_active` above is the reversible
                                // way to mark a base closed, and a base that
                                // genuinely has to go can be emptied source by
                                // source first.
                                {
                                    id: 'cmp_sukbadd',
                                    type: 'button',
                                    props: { label: 'Add knowledge base', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 4 },
                                    visible: true,
                                    onClick: 'act_sukbopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab2',
                            type: 'tab',
                            props: { label: 'Review ladder', icon: 'ListChecks' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_surs',
                                    type: 'data_grid',
                                    props: {
                                        source: {
                                            kind: 'records',
                                            tableId: 'tbl_rstate1',
                                            sort: [{ field: 'position', dir: 'asc' }],
                                            limit: 50,
                                        },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            // The key is NOT editable: sources
                                            // store it, and there are no joins to
                                            // cascade a rename through.
                                            { key: 'key', label: 'Key', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Shown as', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'category', label: 'Counts as', format: 'badge', width: 200, sortable: true, filterable: true, editable: true },
                                            { key: 'may_be_indexed', label: 'May be indexed', format: 'boolean', width: 140, sortable: false, filterable: false, editable: true },
                                            { key: 'color', label: 'Colour', format: 'badge', width: 120, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        // Safe to delete, unlike a base: a
                                        // source keeps the key AND the stage it
                                        // was last given, so removing a rung
                                        // changes nothing about which screen a
                                        // source appears on — it only takes the
                                        // rung off the ladder.
                                        rowActions: [{ label: 'Delete', actionId: 'act_sursdel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No review states configured — add one below.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_surssave',
                                },
                                {
                                    id: 'cmp_sursadd',
                                    type: 'button',
                                    props: { label: 'Add review state', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 4 },
                                    visible: true,
                                    onClick: 'act_sursopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab3',
                            type: 'tab',
                            props: { label: 'Legal bases', icon: 'ShieldCheck' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sulb',
                                    type: 'data_grid',
                                    props: {
                                        source: {
                                            kind: 'records',
                                            tableId: 'tbl_lbasis1',
                                            sort: [{ field: 'position', dir: 'asc' }],
                                            limit: 50,
                                        },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 180, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Shown as', format: 'text', width: 240, sortable: false, filterable: false, editable: true },
                                            { key: 'description', label: 'What it covers', format: 'text', width: 320, sortable: false, filterable: false, editable: true },
                                            { key: 'requires_evidence', label: 'Needs evidence', format: 'boolean', width: 140, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        // Same reasoning as the ladder: a source
                                        // stores the KEY, so deleting the row
                                        // takes a ground off the list of ones
                                        // you recognise without altering what
                                        // any source already claims.
                                        rowActions: [{ label: 'Delete', actionId: 'act_sulbdel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No legal bases configured — add one below.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sulbsave',
                                },
                                {
                                    id: 'cmp_sulbadd',
                                    type: 'button',
                                    props: { label: 'Add legal basis', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 4 },
                                    visible: true,
                                    onClick: 'act_sulbopen',
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            /**
             * THE ADD DIALOGS, HOISTED OUT OF THE TABS.
             *
             * Not a stylistic choice. Inside a tab, a dialog is section → tabs
             * → tab → modal → form → input: six levels, which is EXACTLY
             * MAX_DEPTH. It validates, and it has no room left — one wrapper
             * around a pair of fields, one grouping container, and every input
             * below it is `shape.too_deep`. Hoisted, each dialog is section →
             * modal → form → input with two levels spare, and `open_modal`
             * finds it by id wherever it sits in the tree.
             */
            id: 'sec_sudlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_sukbmod',
                    type: 'modal',
                    props: { title: 'Add a knowledge base', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sukbfrm',
                            type: 'form',
                            props: { name: 'newbase', submitLabel: 'Create base', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sukbadd',
                            children: [
                                { id: 'cmp_sukbf1', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_sukbf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_sukbf3', type: 'input_text', props: { name: 'purpose', label: 'What it is for', placeholder: 'What an assistant is meant to answer from it', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                // The classification the base carries and every
                                // source in it inherits, so it is required here
                                // rather than defaulted silently.
                                {
                                    id: 'cmp_sukbf4',
                                    type: 'input_select',
                                    props: { name: 'classification', label: 'Classification', required: true, options: CLASSIFICATION_OPTIONS, defaultValue: 'internal', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                    style: { span: 6 },
                                    visible: true,
                                },
                                { id: 'cmp_sukbf5', type: 'input_text', props: { name: 'data_residency', label: 'Where it lives', placeholder: 'EU — self-hosted, Frankfurt', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                // A base without a named owner is a base nobody
                                // reviews; the e-mail is the identity a viewer
                                // is matched against.
                                { id: 'cmp_sukbf6', type: 'input_text', props: { name: 'owner_name', label: 'Owner', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sukbf7', type: 'input_text', props: { name: 'owner_email', label: 'Owner e-mail', required: false, inputType: 'email' }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_sursmod',
                    type: 'modal',
                    props: { title: 'Add a rung to the review ladder', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sursfrm',
                            type: 'form',
                            props: { name: 'newstate', submitLabel: 'Add state', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sursadd',
                            children: [
                                // The key is what a source stores, and it is not
                                // editable in the grid afterwards — no joins, so
                                // nothing could cascade a rename. Typing it is
                                // the one moment it is chosen.
                                { id: 'cmp_sursf1', type: 'input_text', props: { name: 'key', label: 'Key (what a source stores, e.g. dpo_signoff)', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_sursf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_sursf3', type: 'input_text', props: { name: 'name', label: 'Shown as', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                // THE consequential field: every screen reasons
                                // in the rung, never in the key.
                                {
                                    id: 'cmp_sursf4',
                                    type: 'input_select',
                                    props: { name: 'category', label: 'Counts as', required: true, options: STAGE_OPTIONS, defaultValue: 'intake', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                    style: { span: 6 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_sursf5',
                                    type: 'input_select',
                                    props: { name: 'color', label: 'Colour', required: false, options: COLOR_OPTIONS, defaultValue: 'neutral', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                    style: { span: 6 },
                                    visible: true,
                                },
                                { id: 'cmp_sursf6', type: 'input_checkbox', props: { name: 'may_be_indexed', label: 'A source in this state may be in the retrieval index', defaultChecked: false }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_sulbmod',
                    type: 'modal',
                    props: { title: 'Add a legal basis', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sulbfrm',
                            type: 'form',
                            props: { name: 'newbasis', submitLabel: 'Add legal basis', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sulbadd',
                            children: [
                                { id: 'cmp_sulbf1', type: 'input_text', props: { name: 'key', label: 'Key (what a source stores, e.g. vital_interests)', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_sulbf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_sulbf3', type: 'input_text', props: { name: 'name', label: 'Shown as', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_sulbf4', type: 'input_text', props: { name: 'description', label: 'What it covers', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_sulbf5', type: 'input_checkbox', props: { name: 'requires_evidence', label: 'A source on this basis needs a document behind it', defaultChecked: false }, style: { span: 12 }, visible: true },
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
 * WHERE CONTEXT COMES FROM. A server step (create/update/delete_record) sees
 * `form`, `vars`, `item`, `value`, `currentUser`, `now` and `today` — and NOT
 * `screen`, `forms`, `actions`, `records` or `datasets`. So a write reads the
 * event payload (`form.*`, or for a grid row action `item.*`, which carries the
 * whole row) or a variable an earlier client step put there. Nothing here reads
 * `screen.params`: it resolves in preview and writes NULL in production.
 *
 * WHY EVERY MUTATION ENDS IN `refresh`. Nothing invalidates a bound query after
 * a write, so without it an approved source keeps showing its old state until
 * something else happens to refetch — and on this app, a screen showing a stale
 * governance state is worse than a screen showing nothing.
 *
 * WHY DENORMALISED COPIES ARE WRITTEN BY THE SAME STEP AS THE REAL VALUE. There
 * are no joins, so `base_name`, `source_title` and `review_stage` are display
 * and query copies. Any action that sets the underlying relation or key sets the
 * copy in the same step, never in a second one — a half-applied pair is a row
 * that lies on every screen that reads it.
 */
const actions = {
    // ── Scope ──────────────────────────────────────────────────────────────

    /** Narrow every screen to one base. `item` is the clicked row. */
    act_pickbase: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'base', value: { kind: 'formula', expr: 'item' } }],
    },

    /**
     * Back to the whole organisation. Every base filter in the app is OPTIONAL,
     * so clearing the variable widens each of them instead of emptying it.
     */
    act_clearbase: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'base', value: { kind: 'static', value: null } }],
    },

    /** Open a source in full. Fired from a grid row action, a list and the calendar. */
    act_opensource: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'source', value: { kind: 'formula', expr: 'item' } },
            { kind: 'navigate', screenId: 'scr_source' },
        ],
    },

    act_gosources: { kind: 'navigate', screenId: 'scr_sources' },

    // ── Sources ────────────────────────────────────────────────────────────

    act_scopen: { kind: 'open_modal', modalId: 'cmp_scmodal' },

    /**
     * Submit a new source into the selected base.
     *
     * The condition is not defensive plumbing: a source with no base is a source
     * no assistant reads and no steward reviews, and creating one silently would
     * be a row that quietly does nothing forever. `base_name` is written
     * alongside `base_id` because nothing can join to fetch it later.
     *
     * It lands at the bottom of the ladder — `submitted` / `intake` — whatever
     * the person filling the form thinks. Only the review screen moves it up.
     */
    act_sccreate: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.base.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_source1',
                        values: {
                            title: { kind: 'formula', expr: 'form.title' },
                            source_kind: { kind: 'formula', expr: 'form.source_kind' },
                            origin: { kind: 'formula', expr: 'form.origin' },
                            supplied_by: { kind: 'formula', expr: 'form.supplied_by' },
                            supplied_by_email: { kind: 'formula', expr: 'form.supplied_by_email' },
                            legal_basis: { kind: 'formula', expr: 'form.legal_basis' },
                            permission_note: { kind: 'formula', expr: 'form.permission_note' },
                            review_due: { kind: 'formula', expr: 'form.review_due' },
                            contains_personal_data: { kind: 'formula', expr: 'form.contains_personal_data' },
                            notes: { kind: 'formula', expr: 'form.notes' },
                            base_id: { kind: 'formula', expr: 'vars.base.id' },
                            base_name: { kind: 'formula', expr: 'vars.base.name' },
                            added_on: { kind: 'formula', expr: 'today' },
                            review_state: { kind: 'static', value: 'submitted' },
                            review_stage: { kind: 'static', value: 'intake' },
                            index_state: { kind: 'static', value: 'not_indexed' },
                        },
                    },
                    { kind: 'close_modal', modalId: 'cmp_scmodal' },
                    { kind: 'reset_form', form: 'newsource' },
                    { kind: 'refresh', tableId: 'tbl_source1' },
                    { kind: 'toast', message: 'Submitted for review. It is not in the index until a steward approves it.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Pick the knowledge base on the left first — a source has to live in one. If that list is empty, add a base on Setup.', tone: 'info' },
                ],
            },
        ],
    },

    /**
     * Inline grid edits. The grid is selectable:'none', so onRowSelect only ever
     * fires for a committed cell edit and carries the whole edited row.
     *
     * `review_state` is NOT here even though the grid shows it: moving a source
     * up the ladder also has to write `review_stage` and the approval stamp, and
     * a cell edit cannot do the pair. It is read-only in the grid for exactly
     * that reason.
     */
    act_scsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_source1',
                recordId: { kind: 'formula', expr: 'form.id' },
                // Compare-and-set: refuse the write if somebody else changed the
                // row since this grid loaded it. On a governance register,
                // silently overwriting another steward is not acceptable.
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    title: { kind: 'formula', expr: 'form.title' },
                    source_kind: { kind: 'formula', expr: 'form.source_kind' },
                    origin: { kind: 'formula', expr: 'form.origin' },
                    legal_basis: { kind: 'formula', expr: 'form.legal_basis' },
                    index_state: { kind: 'formula', expr: 'form.index_state' },
                    review_due: { kind: 'formula', expr: 'form.review_due' },
                    scanned_on: { kind: 'formula', expr: 'form.scanned_on' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_source1' },
        ],
    },

    /**
     * Move a source along the ladder the customer configured. `item` is the
     * clicked REVIEW STATE row, so the key and its category both come from the
     * same row — which is what keeps the denormalised `review_stage` honest.
     *
     * The `live` branch stamps who approved it and when. That stamp is the
     * answer to "who said this may be repeated", and an approval without it is
     * a decision with nobody behind it.
     */
    act_setstate: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'item.category == "live"',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_source1',
                        recordId: { kind: 'formula', expr: 'vars.source.id' },
                        values: {
                            review_state: { kind: 'formula', expr: 'item.key' },
                            review_stage: { kind: 'formula', expr: 'item.category' },
                            approved_by: { kind: 'formula', expr: 'currentUser.name' },
                            approved_on: { kind: 'formula', expr: 'today' },
                        },
                    },
                ],
                else: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_source1',
                        recordId: { kind: 'formula', expr: 'vars.source.id' },
                        values: {
                            review_state: { kind: 'formula', expr: 'item.key' },
                            review_stage: { kind: 'formula', expr: 'item.category' },
                        },
                    },
                ],
            },
            // The detail panel above is a live query on this table, so this is
            // what makes the new state appear without leaving the screen.
            { kind: 'refresh', tableId: 'tbl_source1' },
            { kind: 'toast', message: 'State updated. If it is now closed, remember the index still has it until a removal is confirmed.', tone: 'success' },
        ],
    },

    /**
     * Propose a removal from a grid row action. `item` is the SOURCE row, so the
     * denormalised title and base come straight off it.
     *
     * The source is marked `removal_pending` rather than not-indexed: the
     * material is still being retrieved until somebody confirms otherwise, and
     * claiming otherwise here would be the register telling a comfortable lie.
     */
    act_reqretire: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_retire1',
                values: {
                    source_id: { kind: 'formula', expr: 'item.id' },
                    source_title: { kind: 'formula', expr: 'item.title' },
                    base_name: { kind: 'formula', expr: 'item.base_name' },
                    reason: { kind: 'static', value: 'review_overdue' },
                    requested_by: { kind: 'formula', expr: 'currentUser.name' },
                    requested_on: { kind: 'formula', expr: 'today' },
                    index_removed: { kind: 'static', value: false },
                    note: { kind: 'static', value: 'Requested from the register — past its review date.' },
                },
            },
            {
                kind: 'update_record',
                tableId: 'tbl_source1',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: { index_state: { kind: 'static', value: 'removal_pending' } },
            },
            { kind: 'refresh', tableId: 'tbl_retire1' },
            { kind: 'refresh', tableId: 'tbl_source1' },
            { kind: 'toast', message: 'Logged. It is still in the index until somebody confirms removal on the Retirements screen.', tone: 'warning' },
        ],
    },

    /** The same proposal from the source's own screen, with a stated reason. */
    act_soretire: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_retire1',
                values: {
                    source_id: { kind: 'formula', expr: 'vars.source.id' },
                    source_title: { kind: 'formula', expr: 'vars.source.title' },
                    base_name: { kind: 'formula', expr: 'vars.source.base_name' },
                    reason: { kind: 'formula', expr: 'form.reason' },
                    note: { kind: 'formula', expr: 'form.note' },
                    requested_by: { kind: 'formula', expr: 'currentUser.name' },
                    requested_on: { kind: 'formula', expr: 'today' },
                    index_removed: { kind: 'static', value: false },
                },
            },
            {
                kind: 'update_record',
                tableId: 'tbl_source1',
                recordId: { kind: 'formula', expr: 'vars.source.id' },
                values: { index_state: { kind: 'static', value: 'removal_pending' } },
            },
            { kind: 'reset_form', form: 'retirereq' },
            { kind: 'refresh', tableId: 'tbl_retire1' },
            { kind: 'refresh', tableId: 'tbl_source1' },
            { kind: 'toast', message: 'Removal proposed. Confirm it on the Retirements screen once the index has dropped it.', tone: 'warning' },
        ],
    },

    // ── Retirements ────────────────────────────────────────────────────────

    /**
     * THE LOOP-CLOSING ACTION. `item` is the retirement row, and `item.source_id`
     * is the relation's stored record id — which is how one row action can write
     * to two tables without a join.
     *
     * Both writes belong together: confirming the log entry without clearing the
     * source's index_state would leave every screen still reporting it as
     * answering, which is the precise failure this register exists to prevent.
     */
    act_confirmrm: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_retire1',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: {
                    index_removed: { kind: 'static', value: true },
                    removed_on: { kind: 'formula', expr: 'today' },
                },
            },
            {
                kind: 'update_record',
                tableId: 'tbl_source1',
                recordId: { kind: 'formula', expr: 'item.source_id' },
                values: { index_state: { kind: 'static', value: 'not_indexed' } },
            },
            { kind: 'refresh', tableId: 'tbl_retire1' },
            { kind: 'refresh', tableId: 'tbl_source1' },
            { kind: 'toast', message: 'Confirmed out of the index.', tone: 'success' },
        ],
    },

    // ── Personal data ──────────────────────────────────────────────────────

    /**
     * The only run_automation in the app, and it ships UNSET on purpose — the
     * scan is the customer's own detection service (Bee Flow's guard-service is
     * the intended one) and no template can guess its id. The Personal data
     * screen says so in plain words rather than letting the button fail quietly.
     */
    act_runscan: {
        kind: 'sequence',
        steps: [
            { kind: 'run_automation', automationId: null, resultVar: 'scanResult' },
            { kind: 'refresh', tableId: 'tbl_finds01' },
            { kind: 'toast', message: 'Scan requested. If nothing appears, connect the routine in Automations first.', tone: 'info' },
        ],
    },

    /**
     * Ruling on a finding. The stamp goes on with the edit, because on this
     * table an edit IS the decision — there is no separate "save" a steward
     * could make without deciding something.
     */
    act_pisave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_finds01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    severity: { kind: 'formula', expr: 'form.severity' },
                    decision: { kind: 'formula', expr: 'form.decision' },
                    rationale: { kind: 'formula', expr: 'form.rationale' },
                    decided_by: { kind: 'formula', expr: 'currentUser.name' },
                    decided_on: { kind: 'formula', expr: 'today' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_finds01' },
        ],
    },

    /**
     * Recording a finding by hand, from the Source screen — the degradation
     * path for a scan routine nobody has wired up yet.
     *
     * The two branches exist for one reason: `is_special_category` is not a
     * preference. Health and biometric material IS Art. 9 whether or not the
     * person typing remembered to tick the box, and every screen that counts
     * special-category findings reads that column. So those two categories
     * write `true` regardless, and the checkbox only decides the cases the
     * category cannot settle by itself — beliefs, union membership, ethnicity.
     *
     * `source_title` and `base_name` are the usual denormalised copies, taken
     * from the open source in the same step as the id, so they cannot disagree
     * with it. The finding lands `open`: recording is not deciding.
     */
    act_pifcreate: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'form.category == "health" || form.category == "biometric"',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_finds01',
                        values: {
                            source_id: { kind: 'formula', expr: 'vars.source.id' },
                            source_title: { kind: 'formula', expr: 'vars.source.title' },
                            base_name: { kind: 'formula', expr: 'vars.source.base_name' },
                            category: { kind: 'formula', expr: 'form.category' },
                            severity: { kind: 'formula', expr: 'form.severity' },
                            finding: { kind: 'formula', expr: 'form.finding' },
                            location: { kind: 'formula', expr: 'form.location' },
                            detected_on: { kind: 'formula', expr: 'today' },
                            is_special_category: { kind: 'static', value: true },
                            decision: { kind: 'static', value: 'open' },
                        },
                    },
                ],
                else: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_finds01',
                        values: {
                            source_id: { kind: 'formula', expr: 'vars.source.id' },
                            source_title: { kind: 'formula', expr: 'vars.source.title' },
                            base_name: { kind: 'formula', expr: 'vars.source.base_name' },
                            category: { kind: 'formula', expr: 'form.category' },
                            severity: { kind: 'formula', expr: 'form.severity' },
                            finding: { kind: 'formula', expr: 'form.finding' },
                            location: { kind: 'formula', expr: 'form.location' },
                            detected_on: { kind: 'formula', expr: 'today' },
                            is_special_category: { kind: 'formula', expr: 'form.is_special_category' },
                            decision: { kind: 'static', value: 'open' },
                        },
                    },
                ],
            },
            { kind: 'reset_form', form: 'newfinding' },
            { kind: 'refresh', tableId: 'tbl_finds01' },
            { kind: 'toast', message: 'Recorded, and open for a decision. Set the scan date on the Sources screen once the whole source has been checked.', tone: 'success' },
        ],
    },

    // ── Access ─────────────────────────────────────────────────────────────

    act_agopen: { kind: 'open_modal', modalId: 'cmp_acmodal' },

    /** A grant always names a base, so the same guard as a new source. */
    act_agcreate: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.base.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_grant01',
                        values: {
                            grantee_name: { kind: 'formula', expr: 'form.grantee_name' },
                            grantee_kind: { kind: 'formula', expr: 'form.grantee_kind' },
                            purpose: { kind: 'formula', expr: 'form.purpose' },
                            expires_on: { kind: 'formula', expr: 'form.expires_on' },
                            can_export: { kind: 'formula', expr: 'form.can_export' },
                            base_id: { kind: 'formula', expr: 'vars.base.id' },
                            base_name: { kind: 'formula', expr: 'vars.base.name' },
                            granted_by: { kind: 'formula', expr: 'currentUser.name' },
                            granted_on: { kind: 'formula', expr: 'today' },
                            is_active: { kind: 'static', value: true },
                        },
                    },
                    { kind: 'close_modal', modalId: 'cmp_acmodal' },
                    { kind: 'reset_form', form: 'newgrant' },
                    { kind: 'refresh', tableId: 'tbl_grant01' },
                    { kind: 'toast', message: 'Access granted, and logged against your name.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Pick the knowledge base on the left first — a grant is always to one base. If that list is empty, add a base on Setup.', tone: 'info' },
                ],
            },
        ],
    },

    act_agsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_grant01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    grantee_name: { kind: 'formula', expr: 'form.grantee_name' },
                    grantee_kind: { kind: 'formula', expr: 'form.grantee_kind' },
                    purpose: { kind: 'formula', expr: 'form.purpose' },
                    expires_on: { kind: 'formula', expr: 'form.expires_on' },
                    can_export: { kind: 'formula', expr: 'form.can_export' },
                    is_active: { kind: 'formula', expr: 'form.is_active' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_grant01' },
        ],
    },

    /**
     * Revoke rather than delete. Who could ask what, and until when, is the
     * question an auditor asks about LAST year — a deleted grant cannot answer
     * it, so the row stays and goes inactive.
     */
    act_agrevoke: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Revoke this access? The grant stays in the register as a record that it once existed.', title: 'Revoke access', confirmLabel: 'Revoke', cancelLabel: 'Keep' },
            {
                kind: 'update_record',
                tableId: 'tbl_grant01',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: {
                    is_active: { kind: 'static', value: false },
                    expires_on: { kind: 'formula', expr: 'today' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_grant01' },
            { kind: 'toast', message: 'Revoked.', tone: 'success' },
        ],
    },

    // ── Setup — inline edits, and adding to the configuration tables ────────

    act_sukbsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_kbases1',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    purpose: { kind: 'formula', expr: 'form.purpose' },
                    classification: { kind: 'formula', expr: 'form.classification' },
                    owner_name: { kind: 'formula', expr: 'form.owner_name' },
                    owner_email: { kind: 'formula', expr: 'form.owner_email' },
                    data_residency: { kind: 'formula', expr: 'form.data_residency' },
                    is_active: { kind: 'formula', expr: 'form.is_active' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_kbases1' },
        ],
    },

    act_surssave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_rstate1',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    category: { kind: 'formula', expr: 'form.category' },
                    may_be_indexed: { kind: 'formula', expr: 'form.may_be_indexed' },
                    color: { kind: 'formula', expr: 'form.color' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_rstate1' },
        ],
    },

    act_sulbsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_lbasis1',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    description: { kind: 'formula', expr: 'form.description' },
                    requires_evidence: { kind: 'formula', expr: 'form.requires_evidence' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_lbasis1' },
        ],
    },

    /**
     * ── ADDING A ROW TO EACH CONFIG TABLE ──────────────────────────────────
     *
     * This is what makes the central argument of this template true rather
     * than merely stated. `review_state` and `legal_basis` are TEXT KEYS
     * instead of `select` options so that the customer owns the vocabulary
     * without a developer editing a live schema — and that only holds if a
     * steward can actually add one. Without these, adding a rung still meant
     * opening the builder, which is the exact thing the choice was made to
     * avoid.
     *
     * Knowledge bases are here for a second reason. `act_sccreate` and
     * `act_agcreate` both refuse to write without `vars.base.id`, so an
     * organisation that deleted its last base had "Add a source" permanently
     * greyed out with no way back inside the app. Now there is one.
     *
     * Each is the same shape: a button opens a hoisted dialog, the form
     * creates the row, the dialog closes, the form resets, and the table it
     * wrote is refreshed — nothing invalidates a bound query on its own, so
     * without the refresh the new rung would be missing from the ladder on the
     * Source screen until something else happened to refetch.
     */
    act_sukbopen: { kind: 'open_modal', modalId: 'cmp_sukbmod' },
    act_sukbadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_kbases1',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    purpose: { kind: 'formula', expr: 'form.purpose' },
                    classification: { kind: 'formula', expr: 'form.classification' },
                    owner_name: { kind: 'formula', expr: 'form.owner_name' },
                    owner_email: { kind: 'formula', expr: 'form.owner_email' },
                    data_residency: { kind: 'formula', expr: 'form.data_residency' },
                    position: { kind: 'formula', expr: 'form.position' },
                    is_active: { kind: 'static', value: true },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_sukbmod' },
            { kind: 'reset_form', form: 'newbase' },
            { kind: 'refresh', tableId: 'tbl_kbases1' },
            { kind: 'toast', message: 'Base created. Pick it on the Sources screen to start admitting material to it.', tone: 'success' },
        ],
    },

    act_sursopen: { kind: 'open_modal', modalId: 'cmp_sursmod' },
    act_sursadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_rstate1',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    category: { kind: 'formula', expr: 'form.category' },
                    color: { kind: 'formula', expr: 'form.color' },
                    may_be_indexed: { kind: 'formula', expr: 'form.may_be_indexed' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_sursmod' },
            { kind: 'reset_form', form: 'newstate' },
            { kind: 'refresh', tableId: 'tbl_rstate1' },
            { kind: 'toast', message: 'Rung added — it is a button on every source now.', tone: 'success' },
        ],
    },
    /**
     * Removing a rung is safe in a way that removing a BASE is not, and the
     * difference is the denormalised copy. A source carries both the state key
     * and `review_stage`, so a source in a deleted rung keeps the stage it was
     * last given and stays on exactly the screens it was already on. What is
     * lost is the ability to put a source INTO that state again — which is why
     * the confirm says so instead of promising nothing happens.
     */
    act_sursdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this rung? Sources already in it keep their state and stay on the screens they are on — but nothing can be moved into it again until you add it back.', title: 'Delete review state', confirmLabel: 'Delete', cancelLabel: 'Keep' },
            { kind: 'delete_record', tableId: 'tbl_rstate1', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_rstate1' },
        ],
    },

    act_sulbopen: { kind: 'open_modal', modalId: 'cmp_sulbmod' },
    act_sulbadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_lbasis1',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    description: { kind: 'formula', expr: 'form.description' },
                    requires_evidence: { kind: 'formula', expr: 'form.requires_evidence' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_sulbmod' },
            { kind: 'reset_form', form: 'newbasis' },
            { kind: 'refresh', tableId: 'tbl_lbasis1' },
            { kind: 'toast', message: 'Legal basis added. Sources record its key, so it reads back on every source that cites it.', tone: 'success' },
        ],
    },
    /**
     * A legal basis is a vocabulary entry, not evidence: the source keeps the
     * key it cites, and `permission_note` — the sentence about what the
     * permission actually says — lives on the source itself. So removing one
     * takes a ground off the list you recognise without editing away any
     * claim already made. (Findings and retirements are the append-only
     * tables; nothing anywhere may delete one of those.)
     */
    act_sulbdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this legal basis? Sources that cite it keep the key and their permission note — you are removing it from the list of grounds you recognise, not from the sources.', title: 'Delete legal basis', confirmLabel: 'Delete', cancelLabel: 'Keep' },
            { kind: 'delete_record', tableId: 'tbl_lbasis1', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_lbasis1' },
        ],
    },
};

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'Knowledge base governance',
        description: 'The register for what your assistants are allowed to repeat.',
        icon: 'ShieldCheck',
    },
    theme: { ...THEME_DEFAULTS, primary: '#0369A1', radius: 'lg' },
    // The cloud identity in the inter face: light, airy B2B SaaS. Nine screens
    // is exactly where a flat tab row stops telling anyone anything, so the
    // top bar's groups open as MEGA panels — each screen shown with the
    // one-line description it already carries.
    design: { preset: 'cloud', font: 'inter', surface: 'soft', motion: 'full', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
    nav: {
        style: 'mega',
        groups: [
            { id: 'nvg_know', label: 'Knowledge', icon: 'BookOpen', screens: ['scr_register', 'scr_sources'] },
            { id: 'nvg_review', label: 'Reviews', icon: 'ListChecks', screens: ['scr_queue', 'scr_reten'] },
            { id: 'nvg_comply', label: 'Compliance', icon: 'ShieldCheck', screens: ['scr_findings', 'scr_access', 'scr_retire'] },
            { id: 'nvg_admin', label: 'Admin', icon: 'TableProperties', screens: ['scr_setup'] },
        ],
    },
    roles: [
        { id: 'steward', name: 'Knowledge steward' },
        { id: 'contributor', name: 'Contributor' },
        { id: 'auditor', name: 'Auditor / DPO' },
    ],
    /**
     * `filters` is NOT declared — it is a reserved name owned by filter_bar,
     * which publishes into it directly.
     *
     * Two variables, and they mean different things on purpose. `base` is a
     * FACET: every filter that reads it is optional, so null means "everything".
     * `source` is an OPEN RECORD: the filters that read it are required, so null
     * means "nothing to show yet" rather than "somebody else's findings".
     */
    variables: [
        { name: 'base', label: 'Selected knowledge base', type: 'record', default: null, description: 'Optional facet. When null every screen shows the whole register; picking one narrows the numbers and the lists to that base.' },
        { name: 'source', label: 'Open source', type: 'record', default: null, description: 'Carries the id of the source being reviewed. The Source screen re-reads the row itself rather than trusting this snapshot.' },
        { name: 'scanResult', label: 'Last scan result', type: 'any', default: null, description: 'What the personal-data scan routine returned, if one is wired up.' },
    ],
    homeScreenId: 'scr_register',
    screens: [
        SCREEN_REGISTER,
        SCREEN_SOURCES,
        SCREEN_SOURCE,
        SCREEN_QUEUE,
        SCREEN_RETENTION,
        SCREEN_PII,
        SCREEN_ACCESS,
        SCREEN_RETIRE,
        SCREEN_SETUP,
    ],
    actions,
};

// ---------------------------------------------------------------------------
// Seed
//
// A register you can read on first open, and which is honestly imperfect —
// because a seed where everything is in order teaches the customer nothing. Four
// fictional bases at four classifications, and sources deliberately spread
// across every disagreement the app is built to surface:
//
//   • three approved + indexed + past their review date (the Register's list);
//   • two closed in the register but still indexed (the Retirements gap);
//   • three indexed with no scan date at all (the "nobody looked" gap);
//   • a queue with something in it, including one nobody has scanned;
//   • one grant expired months ago and never switched off.
//
// `$id` is a LOCAL alias, never a column; { $ref } points at a row seeded
// EARLIER — templateInstall seeds parent tables first and rewrites the refs to
// real record ids.
//
// Every organisation, person and document below is invented. Dates sit around
// mid-2026 so "overdue" and "upcoming" both have members on install.
// ---------------------------------------------------------------------------

const seed = {
    tbl_kbases1: [
        { $id: 'kb_hr', name: 'HR handbook', purpose: 'Policies, leave rules and onboarding material the staff assistant answers from.', owner_name: 'Mira Halvorsen', owner_email: 'mira.halvorsen@example.com', classification: 'internal', data_residency: 'EU — self-hosted, Frankfurt', is_active: true, position: 1 },
        { $id: 'kb_supp', name: 'Support knowledge', purpose: 'Product articles and resolved tickets behind the customer-facing assistant.', owner_name: 'Joost Bakker', owner_email: 'joost.bakker@example.com', classification: 'internal', data_residency: 'EU — self-hosted, Frankfurt', is_active: true, position: 2 },
        { $id: 'kb_legal', name: 'Contracts and DPAs', purpose: 'Signed agreements and data-processing addenda, for the legal team only.', owner_name: 'Nadia Ferreira', owner_email: 'nadia.ferreira@example.com', classification: 'confidential', data_residency: 'EU — self-hosted, Frankfurt', is_active: true, position: 3 },
        { $id: 'kb_occ', name: 'Occupational health guidance', purpose: 'Workplace health guidance. Contains special-category material and is deliberately narrow.', owner_name: 'Ruben Castell', owner_email: 'ruben.castell@example.com', classification: 'special', data_residency: 'EU — self-hosted, Frankfurt', is_active: true, position: 4 },
    ],

    // Five rungs, not four: "approved with redactions" is the rung that a real
    // approval ladder grows and that a fixed enum could never have anticipated.
    tbl_rstate1: [
        { key: 'submitted', name: 'Submitted', category: 'intake', color: 'neutral', may_be_indexed: false, position: 1 },
        { key: 'in_review', name: 'In review', category: 'in_review', color: 'info', may_be_indexed: false, position: 2 },
        { key: 'approved', name: 'Approved', category: 'live', color: 'success', may_be_indexed: true, position: 3 },
        { key: 'conditional', name: 'Approved with redactions', category: 'live', color: 'warning', may_be_indexed: true, position: 4 },
        { key: 'retired', name: 'Retired', category: 'closed', color: 'danger', may_be_indexed: false, position: 5 },
    ],

    tbl_lbasis1: [
        { key: 'consent', name: 'Consent (Art. 6(1)(a))', description: 'The people in the material agreed to this use, and the agreement is on file.', requires_evidence: true, position: 1 },
        { key: 'contract', name: 'Contract (Art. 6(1)(b))', description: 'Necessary to perform a contract with the person concerned.', requires_evidence: false, position: 2 },
        { key: 'legal_obligation', name: 'Legal obligation (Art. 6(1)(c))', description: 'We are required to hold or process it.', requires_evidence: false, position: 3 },
        { key: 'legitimate_interest', name: 'Legitimate interests (Art. 6(1)(f))', description: 'Balanced against the rights of the people concerned; the assessment is on file.', requires_evidence: true, position: 4 },
        { key: 'licence', name: 'Licensed content', description: 'Third-party material we hold a licence to use, including for AI retrieval.', requires_evidence: true, position: 5 },
        { key: 'own_work', name: 'Own material', description: 'Written by us, about us, with no third-party rights attached.', requires_evidence: false, position: 6 },
    ],

    tbl_source1: [
        // ── HR handbook ────────────────────────────────────────────────────
        // The three headline rows: approved, indexed, and long past review.
        { $id: 'sr_leave', title: 'Leave and absence policy 2024', base_id: { $ref: 'kb_hr' }, base_name: 'HR handbook', origin: 'intranet/hr/policies/leave-2024.pdf', source_kind: 'document', supplied_by: 'Mira Halvorsen', supplied_by_email: 'mira.halvorsen@example.com', added_on: '2024-11-04', legal_basis: 'own_work', permission_note: 'Written in-house by HR.', review_state: 'approved', review_stage: 'live', index_state: 'indexed', review_due: '2026-05-01', scanned_on: '2024-11-06', contains_personal_data: false, retention_months: 18, approved_by: 'Mira Halvorsen', approved_on: '2024-11-08', notes: 'Superseded in practice by the 2026 policy, but never taken out of the index.' },
        { $id: 'sr_onbo', title: 'Onboarding checklist for new joiners', base_id: { $ref: 'kb_hr' }, base_name: 'HR handbook', origin: 'intranet/hr/onboarding/checklist.docx', source_kind: 'document', supplied_by: 'Mira Halvorsen', supplied_by_email: 'mira.halvorsen@example.com', added_on: '2025-02-17', legal_basis: 'own_work', permission_note: 'Written in-house by HR.', review_state: 'approved', review_stage: 'live', index_state: 'indexed', review_due: '2026-06-30', scanned_on: '2025-02-18', contains_personal_data: false, retention_months: 12, approved_by: 'Mira Halvorsen', approved_on: '2025-02-20' },
        { $id: 'sr_expen', title: 'Expenses and travel rules', base_id: { $ref: 'kb_hr' }, base_name: 'HR handbook', origin: 'intranet/finance/expenses.md', source_kind: 'document', supplied_by: 'Joost Bakker', supplied_by_email: 'joost.bakker@example.com', added_on: '2025-06-02', legal_basis: 'own_work', permission_note: 'Written in-house by Finance.', review_state: 'approved', review_stage: 'live', index_state: 'indexed', review_due: '2026-12-01', scanned_on: '2025-06-03', contains_personal_data: false, retention_months: 18, approved_by: 'Mira Halvorsen', approved_on: '2025-06-05' },
        // Retired on paper, still answering. The gap the Retirements screen closes.
        { $id: 'sr_oldhb', title: 'Staff handbook 2022 (withdrawn)', base_id: { $ref: 'kb_hr' }, base_name: 'HR handbook', origin: 'intranet/hr/archive/handbook-2022.pdf', source_kind: 'document', supplied_by: 'Mira Halvorsen', supplied_by_email: 'mira.halvorsen@example.com', added_on: '2023-01-09', legal_basis: 'own_work', permission_note: 'Written in-house by HR.', review_state: 'retired', review_stage: 'closed', index_state: 'indexed', review_due: '2025-12-31', scanned_on: '2023-01-10', contains_personal_data: false, retention_months: 24, approved_by: 'Mira Halvorsen', approved_on: '2023-01-12', notes: 'Withdrawn when the 2024 handbook landed. Nobody confirmed it had left the index.' },
        // In the queue, and never scanned — the pairing the queue screen is built around.
        { $id: 'sr_perf', title: 'Performance review notes, sample set', base_id: { $ref: 'kb_hr' }, base_name: 'HR handbook', origin: 'export from the HR system, Q1 2026', source_kind: 'export', supplied_by: 'Sanne Vermeer', supplied_by_email: 'sanne.vermeer@example.com', added_on: '2026-07-28', legal_basis: 'legitimate_interest', permission_note: 'Balancing test not yet written.', review_state: 'submitted', review_stage: 'intake', index_state: 'not_indexed', retention_months: 6, contains_personal_data: true, notes: 'Proposed so the assistant can answer questions about the review process. Contains real appraisal text.' },

        // ── Support knowledge ──────────────────────────────────────────────
        { $id: 'sr_faq', title: 'Product FAQ, current release', base_id: { $ref: 'kb_supp' }, base_name: 'Support knowledge', origin: 'docs site export', source_kind: 'feed', supplied_by: 'Joost Bakker', supplied_by_email: 'joost.bakker@example.com', added_on: '2026-01-15', legal_basis: 'own_work', permission_note: 'Our own documentation.', review_state: 'approved', review_stage: 'live', index_state: 'indexed', review_due: '2026-10-15', scanned_on: '2026-01-16', contains_personal_data: false, retention_months: 9, approved_by: 'Joost Bakker', approved_on: '2026-01-17' },
        // Indexed, answering, never scanned. Nobody looked.
        { $id: 'sr_tick', title: 'Resolved tickets, 2025 archive', base_id: { $ref: 'kb_supp' }, base_name: 'Support knowledge', origin: 'export from the ticketing system', source_kind: 'export', supplied_by: 'Joost Bakker', supplied_by_email: 'joost.bakker@example.com', added_on: '2026-02-03', legal_basis: 'legitimate_interest', permission_note: 'Assessment on file; customer identifiers were meant to be stripped before import.', review_state: 'approved', review_stage: 'live', index_state: 'indexed', review_due: '2026-08-03', contains_personal_data: true, retention_months: 6, approved_by: 'Joost Bakker', approved_on: '2026-02-04', notes: 'Approved on the assumption that the export was already anonymised. Nobody has scanned it.' },
        { $id: 'sr_vend', title: 'Vendor integration guide (licensed)', base_id: { $ref: 'kb_supp' }, base_name: 'Support knowledge', origin: 'supplied by the vendor under NDA', source_kind: 'document', supplied_by: 'Ilse Grootveld', supplied_by_email: 'ilse.grootveld@example.com', added_on: '2025-09-11', legal_basis: 'licence', permission_note: 'Licence permits internal use; silent on AI retrieval. Counsel asked to confirm.', review_state: 'conditional', review_stage: 'live', index_state: 'indexed', review_due: '2026-07-01', scanned_on: '2025-09-12', contains_personal_data: false, retention_months: 12, approved_by: 'Nadia Ferreira', approved_on: '2025-09-15', notes: 'Approved with redactions: the pricing appendix was removed before indexing.' },
        { $id: 'sr_relnt', title: 'Release notes, last four versions', base_id: { $ref: 'kb_supp' }, base_name: 'Support knowledge', origin: 'docs site export', source_kind: 'feed', supplied_by: 'Joost Bakker', supplied_by_email: 'joost.bakker@example.com', added_on: '2026-06-20', legal_basis: 'own_work', permission_note: 'Our own documentation.', review_state: 'in_review', review_stage: 'in_review', index_state: 'not_indexed', review_due: '2027-06-20', scanned_on: '2026-06-21', contains_personal_data: false, retention_months: 12 },
        { $id: 'sr_forum', title: 'Community forum threads, scraped', base_id: { $ref: 'kb_supp' }, base_name: 'Support knowledge', origin: 'https://forum.example.com — crawl of the public boards', source_kind: 'web_page', supplied_by: 'Ilse Grootveld', supplied_by_email: 'ilse.grootveld@example.com', added_on: '2026-07-14', legal_basis: 'legitimate_interest', permission_note: 'Public, but the posts carry usernames and signatures. Balancing test outstanding.', review_state: 'submitted', review_stage: 'intake', index_state: 'not_indexed', retention_months: 6, contains_personal_data: true },

        // ── Contracts and DPAs ─────────────────────────────────────────────
        { $id: 'sr_dpa', title: 'Standard data-processing addendum, v4', base_id: { $ref: 'kb_legal' }, base_name: 'Contracts and DPAs', origin: 'legal/templates/dpa-v4.pdf', source_kind: 'document', supplied_by: 'Nadia Ferreira', supplied_by_email: 'nadia.ferreira@example.com', added_on: '2025-10-01', legal_basis: 'own_work', permission_note: 'Our own template.', review_state: 'approved', review_stage: 'live', index_state: 'indexed', review_due: '2026-04-01', scanned_on: '2025-10-02', contains_personal_data: false, retention_months: 6, approved_by: 'Nadia Ferreira', approved_on: '2025-10-03', notes: 'Six months overdue for review, and legal changed the template in February.' },
        { $id: 'sr_msa', title: 'Signed agreements, 2025 batch', base_id: { $ref: 'kb_legal' }, base_name: 'Contracts and DPAs', origin: 'legal/signed/2025/', source_kind: 'document', supplied_by: 'Nadia Ferreira', supplied_by_email: 'nadia.ferreira@example.com', added_on: '2026-03-12', legal_basis: 'contract', permission_note: 'Counterparty signatures and contact blocks are in scope of the contract itself.', review_state: 'conditional', review_stage: 'live', index_state: 'indexed', review_due: '2026-09-12', scanned_on: '2026-03-14', contains_personal_data: true, retention_months: 6, approved_by: 'Nadia Ferreira', approved_on: '2026-03-15', notes: 'Approved with redactions: signature blocks masked before indexing.' },
        { $id: 'sr_nda', title: 'Expired NDAs, 2019-2021', base_id: { $ref: 'kb_legal' }, base_name: 'Contracts and DPAs', origin: 'legal/archive/nda/', source_kind: 'document', supplied_by: 'Nadia Ferreira', supplied_by_email: 'nadia.ferreira@example.com', added_on: '2024-05-08', legal_basis: 'contract', permission_note: 'The agreements have all expired.', review_state: 'retired', review_stage: 'closed', index_state: 'indexed', review_due: '2026-02-01', scanned_on: '2024-05-09', contains_personal_data: true, retention_months: 24, approved_by: 'Nadia Ferreira', approved_on: '2024-05-10', notes: 'Retired in February. Still in the index — the second half of the removal never happened.' },

        // ── Occupational health ────────────────────────────────────────────
        { $id: 'sr_occg', title: 'Workplace adjustment guidance', base_id: { $ref: 'kb_occ' }, base_name: 'Occupational health guidance', origin: 'occupational-health/guidance/adjustments.pdf', source_kind: 'document', supplied_by: 'Ruben Castell', supplied_by_email: 'ruben.castell@example.com', added_on: '2026-04-22', legal_basis: 'legal_obligation', permission_note: 'Held to meet employer duties; access limited to the occupational health assistant.', review_state: 'approved', review_stage: 'live', index_state: 'indexed', review_due: '2026-10-22', scanned_on: '2026-04-23', contains_personal_data: true, retention_months: 6, approved_by: 'Ruben Castell', approved_on: '2026-04-25' },
        { $id: 'sr_occc', title: 'Anonymised case summaries', base_id: { $ref: 'kb_occ' }, base_name: 'Occupational health guidance', origin: 'occupational-health/cases/2025-summaries.docx', source_kind: 'document', supplied_by: 'Ruben Castell', supplied_by_email: 'ruben.castell@example.com', added_on: '2026-05-30', legal_basis: 'consent', permission_note: 'Written consent from each person, held by occupational health.', review_state: 'in_review', review_stage: 'in_review', index_state: 'not_indexed', review_due: '2026-11-30', scanned_on: '2026-06-01', contains_personal_data: true, retention_months: 6, notes: 'Held back from the index until the health references are ruled on.' },
        // ── Properly retired, and out of the index ─────────────────────────
        // The good path, seeded so the customer can see what "done" looks like:
        // closed in the register AND not_indexed, with a confirmed removal in
        // the log. Without these two rows every retirement on install would be
        // a failure, and the screen would read as if the loop never closes.
        { $id: 'sr_leaveold', title: 'Leave and absence policy 2023', base_id: { $ref: 'kb_hr' }, base_name: 'HR handbook', origin: 'intranet/hr/archive/leave-2023.pdf', source_kind: 'document', supplied_by: 'Mira Halvorsen', supplied_by_email: 'mira.halvorsen@example.com', added_on: '2023-02-14', legal_basis: 'own_work', permission_note: 'Written in-house by HR.', review_state: 'retired', review_stage: 'closed', index_state: 'not_indexed', review_due: '2025-11-01', scanned_on: '2023-02-15', contains_personal_data: false, retention_months: 18, approved_by: 'Mira Halvorsen', approved_on: '2023-02-16', notes: 'Replaced by the 2024 policy and confirmed out of the index the same week.' },
        { $id: 'sr_vend1', title: 'Vendor integration guide, v1', base_id: { $ref: 'kb_supp' }, base_name: 'Support knowledge', origin: 'supplied by the vendor under NDA', source_kind: 'document', supplied_by: 'Ilse Grootveld', supplied_by_email: 'ilse.grootveld@example.com', added_on: '2025-03-04', legal_basis: 'licence', permission_note: 'Superseded edition; the licence covers the current one.', review_state: 'retired', review_stage: 'closed', index_state: 'not_indexed', review_due: '2026-03-04', scanned_on: '2025-03-05', contains_personal_data: false, retention_months: 12, approved_by: 'Nadia Ferreira', approved_on: '2025-03-06', notes: 'Withdrawn when the vendor issued a corrected edition.' },

        { $id: 'sr_erg', title: 'Ergonomics assessment template', base_id: { $ref: 'kb_occ' }, base_name: 'Occupational health guidance', origin: 'occupational-health/templates/ergonomics.docx', source_kind: 'document', supplied_by: 'Sanne Vermeer', supplied_by_email: 'sanne.vermeer@example.com', added_on: '2026-08-02', legal_basis: 'own_work', permission_note: 'Blank template, no case data.', review_state: 'submitted', review_stage: 'intake', index_state: 'not_indexed', review_due: '2027-08-02', retention_months: 12, contains_personal_data: false },
    ],

    tbl_finds01: [
        // The findings describe WHAT was flagged, never the value — a governance
        // register that quotes the personal data it found has become a copy of it.
        { source_id: { $ref: 'sr_msa' }, source_title: 'Signed agreements, 2025 batch', base_name: 'Contracts and DPAs', category: 'name', severity: 'medium', finding: 'Counterparty signatory names throughout the signature blocks', location: 'Final page of each agreement', detected_on: '2026-03-14', is_special_category: false, decision: 'redacted', decided_by: 'Nadia Ferreira', decided_on: '2026-03-15', rationale: 'Signature blocks masked before indexing; the body text carries no names.' },
        { source_id: { $ref: 'sr_msa' }, source_title: 'Signed agreements, 2025 batch', base_name: 'Contracts and DPAs', category: 'contact', severity: 'low', finding: 'Business contact details in the notices clause', location: 'Notices clause', detected_on: '2026-03-14', is_special_category: false, decision: 'accepted', decided_by: 'Nadia Ferreira', decided_on: '2026-03-15', rationale: 'Business contact points, necessary to answer questions about the agreement itself.' },
        { source_id: { $ref: 'sr_nda' }, source_title: 'Expired NDAs, 2019-2021', base_name: 'Contracts and DPAs', category: 'name', severity: 'medium', finding: 'Names of individuals at counterparties that no longer exist', location: 'Throughout', detected_on: '2026-01-20', is_special_category: false, decision: 'removed', decided_by: 'Nadia Ferreira', decided_on: '2026-02-01', rationale: 'Agreements expired; the whole source was retired rather than redacted.' },
        { source_id: { $ref: 'sr_occg' }, source_title: 'Workplace adjustment guidance', base_name: 'Occupational health guidance', category: 'health', severity: 'high', finding: 'Health conditions named as worked examples in the guidance', location: 'Section 3, worked examples', detected_on: '2026-04-23', is_special_category: true, decision: 'accepted', decided_by: 'Ruben Castell', decided_on: '2026-04-25', rationale: 'Illustrative conditions, not tied to any individual. Access restricted to the occupational health assistant.' },
        { source_id: { $ref: 'sr_occc' }, source_title: 'Anonymised case summaries', base_name: 'Occupational health guidance', category: 'health', severity: 'high', finding: 'Health details that could re-identify a person when combined with department and dates', location: 'Case summaries 4, 9 and 11', detected_on: '2026-06-01', is_special_category: true, decision: 'open', rationale: null },
        { source_id: { $ref: 'sr_occc' }, source_title: 'Anonymised case summaries', base_name: 'Occupational health guidance', category: 'location', severity: 'medium', finding: 'Site and department named alongside each case', location: 'Header of each summary', detected_on: '2026-06-01', is_special_category: false, decision: 'open', rationale: null },
        { source_id: { $ref: 'sr_forum' }, source_title: 'Community forum threads, scraped', base_name: 'Support knowledge', category: 'contact', severity: 'medium', finding: 'Personal e-mail addresses left in user signatures', location: 'Post signatures', detected_on: '2026-07-15', is_special_category: false, decision: 'open', rationale: null },
        { source_id: { $ref: 'sr_forum' }, source_title: 'Community forum threads, scraped', base_name: 'Support knowledge', category: 'credential', severity: 'high', finding: 'An API token pasted into a troubleshooting thread', location: 'Thread 8812, third reply', detected_on: '2026-07-15', is_special_category: false, decision: 'open', rationale: null },
        { source_id: { $ref: 'sr_perf' }, source_title: 'Performance review notes, sample set', base_name: 'HR handbook', category: 'name', severity: 'high', finding: 'Employee names attached to appraisal text', location: 'Every record in the export', detected_on: '2026-07-29', is_special_category: false, decision: 'open', rationale: null },
        { source_id: { $ref: 'sr_vend' }, source_title: 'Vendor integration guide (licensed)', base_name: 'Support knowledge', category: 'other', severity: 'low', finding: 'Vendor pricing appendix, commercially restricted rather than personal', location: 'Appendix B', detected_on: '2025-09-12', is_special_category: false, decision: 'redacted', decided_by: 'Nadia Ferreira', decided_on: '2025-09-15', rationale: 'Appendix removed before indexing under the licence terms.' },
    ],

    tbl_grant01: [
        { base_id: { $ref: 'kb_hr' }, base_name: 'HR handbook', grantee_kind: 'assistant', grantee_name: 'Staff assistant', purpose: 'Answer employee questions about leave, expenses and onboarding.', granted_by: 'Mira Halvorsen', granted_on: '2025-01-08', expires_on: '2027-01-08', can_export: false, is_active: true },
        { base_id: { $ref: 'kb_hr' }, base_name: 'HR handbook', grantee_kind: 'group', grantee_name: 'HR team', purpose: 'Direct search over the handbook while drafting policy updates.', granted_by: 'Mira Halvorsen', granted_on: '2025-01-08', expires_on: '2027-01-08', can_export: true, is_active: true },
        { base_id: { $ref: 'kb_supp' }, base_name: 'Support knowledge', grantee_kind: 'assistant', grantee_name: 'Customer support copilot', purpose: 'Draft replies to customer tickets from product documentation.', granted_by: 'Joost Bakker', granted_on: '2026-01-20', expires_on: '2027-01-20', can_export: false, is_active: true },
        // Expired in April and never switched off. The access-side twin of the
        // retired-but-indexed source.
        { base_id: { $ref: 'kb_supp' }, base_name: 'Support knowledge', grantee_kind: 'agent', grantee_name: 'Nightly ticket-triage agent', purpose: 'Pilot: classify incoming tickets against known issues.', granted_by: 'Joost Bakker', granted_on: '2025-10-01', expires_on: '2026-04-01', can_export: false, is_active: true },
        { base_id: { $ref: 'kb_legal' }, base_name: 'Contracts and DPAs', grantee_kind: 'group', grantee_name: 'Legal team', purpose: 'Search signed agreements while answering counterparty questions.', granted_by: 'Nadia Ferreira', granted_on: '2025-10-03', expires_on: '2027-10-03', can_export: true, is_active: true },
        { base_id: { $ref: 'kb_legal' }, base_name: 'Contracts and DPAs', grantee_kind: 'assistant', grantee_name: 'Contract assistant', purpose: 'Summarise clauses on request. Answers only, no document hand-back.', granted_by: 'Nadia Ferreira', granted_on: '2026-02-11', expires_on: '2027-02-11', can_export: false, is_active: true },
        // Revoked, and kept as a record that it once existed.
        { base_id: { $ref: 'kb_legal' }, base_name: 'Contracts and DPAs', grantee_kind: 'user', grantee_name: 'External counsel — engagement 2025-114', purpose: 'Time-boxed review of the 2025 agreement batch.', granted_by: 'Nadia Ferreira', granted_on: '2025-11-02', expires_on: '2026-01-31', can_export: true, is_active: false },
        { base_id: { $ref: 'kb_occ' }, base_name: 'Occupational health guidance', grantee_kind: 'assistant', grantee_name: 'Occupational health assistant', purpose: 'Answer managers\' questions about workplace adjustments. Special-category material, narrow audience.', granted_by: 'Ruben Castell', granted_on: '2026-04-25', expires_on: '2026-10-25', can_export: false, is_active: true },
    ],

    tbl_retire1: [
        // Confirmed: logged AND out of the index.
        { source_id: { $ref: 'sr_leaveold' }, source_title: 'Leave and absence policy 2023', base_name: 'HR handbook', reason: 'superseded', requested_by: 'Mira Halvorsen', requested_on: '2024-11-04', index_removed: true, removed_on: '2024-11-05', note: 'Replaced by the 2024 policy at import time.' },
        { source_id: { $ref: 'sr_vend1' }, source_title: 'Vendor integration guide, v1', base_name: 'Support knowledge', reason: 'superseded', requested_by: 'Ilse Grootveld', requested_on: '2025-09-11', index_removed: true, removed_on: '2025-09-11', note: 'Vendor issued a corrected edition.' },
        // The two that make the screen worth having: decided months ago, still
        // in the index, and the sources themselves say `indexed`.
        { source_id: { $ref: 'sr_nda' }, source_title: 'Expired NDAs, 2019-2021', base_name: 'Contracts and DPAs', reason: 'permission_withdrawn', requested_by: 'Nadia Ferreira', requested_on: '2026-02-01', index_removed: false, note: 'All the agreements have expired; there is no longer a basis to keep answering from them.' },
        { source_id: { $ref: 'sr_oldhb' }, source_title: 'Staff handbook 2022 (withdrawn)', base_name: 'HR handbook', reason: 'superseded', requested_by: 'Mira Halvorsen', requested_on: '2025-12-31', index_removed: false, note: 'Withdrawn with the 2024 edition. Nobody confirmed the index had dropped it.' },
    ],
};

module.exports = {
    id: 'app-knowledge-governance',
    version: 1,
    title: 'Knowledge base governance',
    description: 'The register for what your AI assistants may repeat: every source in a knowledge base, who supplied it, on what legal basis, when its approval expires, what a personal-data scan found in it, and which assistants may read it. Leads with the source that is approved, indexed and past its review date.',
    category: 'Data',
    icon: 'ShieldCheck',
    tags: ['governance', 'rag', 'knowledge base', 'gdpr', 'retention', 'ai assurance', 'audit'],
    definition,
    dataModel,
    seed,
};
