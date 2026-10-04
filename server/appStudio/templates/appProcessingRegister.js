/**
 * App Studio template — Processing register (verwerkingsregister).
 *
 * The Article 30 GDPR record of processing activities: the document a
 * supervisory authority asks for first, the one that is legally mandatory, and
 * the one almost every organisation keeps in a spreadsheet. Around it sit the
 * things an audit actually pulls on — the processors (Art. 28), the third-
 * country transfers and their safeguard (Chapter V), and the DPIAs (Art. 35).
 *
 * There is no AI anywhere in this app, deliberately. It is the product as a
 * place where sensitive records simply live.
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS ────────────────────────────────
 *
 * `vars.activity` holds a SELECTION, never a copy. Every value on the entry
 * screen — the header, the detail panel, each prefilled control — reads the
 * live row through its own `record` binding scoped by that id.
 *
 * The tempting shape (and the one the sibling templates use for a card) is to
 * park the clicked row in a variable and render from it. Here that is exactly
 * wrong: the moment someone records a review, the snapshot still shows the old
 * review date — and "the register says it was reviewed in May" is the single
 * sentence this whole app exists to keep true. So NOTHING ON SCREEN renders
 * from the snapshot: it supplies `vars.activity.id`, and every value is re-read.
 *
 * The one place the snapshot is read for more than its id is inside an action,
 * where `vars.activity.name` is copied onto a link, transfer, DPIA or log row.
 * That is unavoidable — a server step has no `records` scope, so an action
 * cannot look the row up — and it is harmless, because those columns are
 * DISPLAY COPIES of the name at the moment the link was made, which is what a
 * denormalised register row is for. The live name is one screen away.
 *
 * It costs nothing: `dataCacheKey` hashes tableId + filter + sort + limit and
 * IGNORES `path`, so the header's `path:'name'`, the detail panel's whole row
 * and fourteen prefilled inputs are ONE fetch behind fifteen bindings.
 *
 * ── THE TWO FINDINGS, MATERIALISED ─────────────────────────────────────────
 *
 * An auditor finds two things in a register: entries whose review is overdue,
 * and entries relying on legitimate interests with no balancing test recorded.
 * Both are on the front screen, above the register itself, because a finding
 * buried three clicks deep is a finding nobody fixes.
 *
 * Neither is expressible as a live query. The filter language compares a column
 * to a LITERAL or to a formula over vars/currentUser/today — never a column to
 * another column, and there are no joins. So both are STORED:
 *
 *  • `next_review_date` is written at review time as
 *    `dateAdd(reviewed_on, review_interval_days, 'day')`, which makes "overdue"
 *    the one honest clause `next_review_date < today`. Storing only
 *    `last_reviewed` + an interval would need arithmetic no filter can do.
 *
 *  • `lia_status` is derived by the two actions that write `legal_basis`, from
 *    the basis and whether a balancing test was actually written down:
 *    legitimate interests + empty summary = `missing`. It is a pure function of
 *    two fields the editor supplies, so it cannot drift — and the rule that an
 *    entry counts as compliant exactly when someone has typed out what they
 *    weighed is the honest one.
 *
 * `review_interval_days` is days rather than months because the expression
 * engine's `dateAdd` has no month unit (second/minute/hour/day/week). Days are
 * also exact, which a statutory deadline ought to be.
 *
 * ── CONSTRAINTS THAT SHAPED THIS FILE (none of them obvious) ────────────────
 *
 *  • NO JOINS. Every read is FROM one table. So the link tables carry
 *    DENORMALISED display copies (`activity_name`, `processor_name`,
 *    `category_name`, `is_special`) written by the action that creates the row
 *    out of the clicked `item` — the only place both sides are in scope at once.
 *    They are display copies and the app treats them as such.
 *
 *  • A BINDING FILTER FORMULA may only read currentUser / vars / forms /
 *    screen / today. Every dynamic scope here goes through `vars` or `today`.
 *
 *  • A SERVER STEP sees form, vars, item, value, currentUser, now, today —
 *    and NOT screen/forms/actions/records. Nothing here reads `screen.params`:
 *    it resolves in preview and writes NULL in production.
 *
 *  • An OPTIONAL filter whose formula resolves to null is OMITTED; `required`
 *    means the component shows nothing until the value exists. Every panel on
 *    the entry screen is `required:true` on the activity id, so opening the app
 *    with nothing selected shows explanatory empty text rather than the whole
 *    register's processors in one undifferentiated list.
 *
 *  • A `height:'fill'` SECTION stretches its FIRST grid row only, so every
 *    screen is an auto-height header plus one fill section holding a single row.
 *
 *  • `filter_bar` publishes to the reserved `vars.filters`; one per screen, and
 *    `filters` is never declared as a variable.
 *
 *  • An aggregate binding with no explicit `limit` is silently capped at 50.
 *
 * ── WHAT THIS TEMPLATE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * The register grid is NOT inline-editable, unlike the vocabularies on Setup.
 * A statutory record is amended through a recorded change, not by typing in a
 * cell — every edit goes through the entry screen, and every review lands in an
 * append-only log that not even the DPO may update or delete.
 *
 * There is no rollup of the linked Art. 9 categories onto the activity. The
 * activity carries a DECLARATION (`special_category`), because that is what
 * Art. 30 asks a controller for; linking a special category promotes it to
 * "present", and unlinking the last one deliberately does not silently demote
 * it back. A person decides that, and the register records who.
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
// Three roles, and the split is the real one around a register: the DPO owns
// the document, a process owner maintains their own entries, and an auditor
// reads everything and changes nothing. `default:'role'` inverts the default to
// deny so every grant below is a decision. The app owner is never listed —
// resolveScope short-circuits them to full access.
//
// roleMapping defaults to `auditor`: somebody who wanders into a register of
// processing activities should be able to read it and touch nothing.
// ---------------------------------------------------------------------------

/** The vocabularies. Changing what "legitimate interests" MEANS is the DPO's. */
const ACCESS_VOCABULARY = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'all', delete: 'all' },
        steward: { read: 'all', create: false, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * The register itself. A process owner may add an entry for their own process
 * and amend what they entered — `own`, not `all`, because a register where any
 * steward can rewrite another department's legal basis is not a control.
 * Deleting is the DPO's alone: an entry that is no longer processed is set to
 * `retired`, which keeps the history an authority may ask about.
 */
const ACCESS_REGISTER = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'all', delete: 'all' },
        steward: { read: 'all', create: true, update: 'own', delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/** Processors, transfers, DPIAs and the links between them: same shape. */
const ACCESS_SUPPLIERS = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: 'all', delete: 'all' },
        steward: { read: 'all', create: true, update: 'own', delete: 'own' },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * The review log. NOBODY updates or deletes it — not the steward, not the DPO,
 * not the auditor. It is the evidence that the register was maintained, and
 * evidence you can rewrite is not evidence. Append-only is expressed here by
 * granting `create` and withholding `update`/`delete` from every role.
 */
const ACCESS_REVIEW_LOG = {
    default: 'role',
    roles: {
        dpo: { read: 'all', create: true, update: false, delete: false },
        steward: { read: 'all', create: true, update: false, delete: false },
        auditor: { read: 'all', create: false, update: false, delete: false },
    },
};

// ---------------------------------------------------------------------------
// Vocabularies shared by the schema and the screens.
//
// The seam, same as the sibling templates: `input_select.options`,
// `filter_bar.options` and `data_grid.columns` are author-time lists, while the
// config TABLES are live. A legal basis added on Setup shows up in the register
// grid and the detail panel immediately, but not in the New-entry dropdown
// until an editor adds it there. Said out loud on the Setup screen.
// ---------------------------------------------------------------------------

const LEGAL_BASIS_OPTIONS = [
    { value: 'consent', label: 'Consent — Art. 6(1)(a)' },
    { value: 'contract', label: 'Contract — Art. 6(1)(b)' },
    { value: 'legal_obligation', label: 'Legal obligation — Art. 6(1)(c)' },
    { value: 'vital_interests', label: 'Vital interests — Art. 6(1)(d)' },
    { value: 'public_task', label: 'Public task — Art. 6(1)(e)' },
    { value: 'legitimate_interests', label: 'Legitimate interests — Art. 6(1)(f)' },
];

const DEPARTMENT_OPTIONS = [
    { value: 'hr', label: 'People & Organisation' },
    { value: 'care', label: 'Care delivery' },
    { value: 'marketing', label: 'Marketing' },
    { value: 'ict', label: 'ICT' },
    { value: 'finance', label: 'Finance' },
    { value: 'facilities', label: 'Facilities' },
];

const RISK_OPTIONS = [
    { value: 'low', label: 'Low' },
    { value: 'elevated', label: 'Elevated' },
    { value: 'high', label: 'High' },
];

const STATUS_OPTIONS = [
    { value: 'active', label: 'Active' },
    { value: 'paused', label: 'Paused' },
    { value: 'retired', label: 'Retired' },
];

/** The activity's own DPIA state — the register's view of Art. 35. */
const DPIA_STATE_OPTIONS = [
    { value: 'not_assessed', label: 'Not screened' },
    { value: 'not_needed', label: 'Not required' },
    { value: 'planned', label: 'Planned' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'done', label: 'Completed' },
];

/**
 * The Art. 9 declaration. Three values rather than a yes/no: "unclear" is what
 * a register honestly contains halfway through being written, and a bool would
 * force that into a "no" nobody ever revisits.
 */
const SPECIAL_CATEGORY_OPTIONS = [
    { value: 'none', label: 'No special-category data' },
    { value: 'present', label: 'Special-category data (Art. 9)' },
    { value: 'unclear', label: 'Not yet established' },
];

/** Derived, never typed. See the header: it is a function of basis + summary. */
const LIA_STATUS_OPTIONS = [
    { value: 'not_required', label: 'Not applicable' },
    { value: 'recorded', label: 'Balancing test recorded' },
    { value: 'missing', label: 'Balancing test missing' },
];

const SAFEGUARD_OPTIONS = [
    { value: 'adequacy', label: 'Adequacy decision — Art. 45' },
    { value: 'sccs', label: 'Standard contractual clauses — Art. 46' },
    { value: 'bcr', label: 'Binding corporate rules — Art. 47' },
    { value: 'derogation', label: 'Derogation — Art. 49' },
    { value: 'none', label: 'No safeguard identified' },
];

const DPA_OPTIONS = [
    { value: 'signed', label: 'Signed' },
    { value: 'requested', label: 'Requested' },
    { value: 'none', label: 'None on file' },
];

const DPIA_PHASE_OPTIONS = [
    { value: 'screening', label: 'Screening' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'consultation', label: 'Prior consultation — Art. 36' },
    { value: 'done', label: 'Completed' },
];

const DPIA_OUTCOME_OPTIONS = [
    { value: 'pending', label: 'Pending' },
    { value: 'proceed', label: 'Proceed' },
    { value: 'proceed_with_measures', label: 'Proceed with measures' },
    { value: 'do_not_proceed', label: 'Do not proceed' },
];

const REVIEW_KIND_OPTIONS = [
    { value: 'periodic_review', label: 'Periodic review' },
    { value: 'change', label: 'Change to the processing' },
    { value: 'balancing_test', label: 'Balancing test' },
];

// Tone maps for the lists and cards. Same vocabulary as the options above —
// the test file asserts they cover it, because an unmapped value silently
// renders as a plain grey pill and the screen stops carrying its warning.
const RISK_TONES = [
    { value: 'low', label: 'Low', tone: 'success' },
    { value: 'elevated', label: 'Elevated', tone: 'warning' },
    { value: 'high', label: 'High', tone: 'danger' },
];


const DPA_TONES = [
    { value: 'signed', label: 'DPA signed', tone: 'success' },
    { value: 'requested', label: 'DPA requested', tone: 'warning' },
    { value: 'none', label: 'No DPA', tone: 'danger' },
];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const dataModel = {
    modelVersion: 1,
    roles: [
        { key: 'dpo', label: 'Data protection officer' },
        { key: 'steward', label: 'Process owner' },
        { key: 'auditor', label: 'Auditor (read-only)' },
    ],
    roleMapping: { default: 'auditor', byGroup: {} },
    tables: [
        // ── Vocabularies ───────────────────────────────────────────────────
        {
            id: 'tbl_dept01',
            key: 'departments',
            name: 'Departments',
            icon: 'Building2',
            access: ACCESS_VOCABULARY,
            fields: [
                { id: 'fld_dpkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_dpnam01', key: 'name', type: 'text', required: true, unique: false },
                // Who the DPO chases when a review is overdue.
                { id: 'fld_dpown01', key: 'owner_name', type: 'text', required: false, unique: false },
                { id: 'fld_dpmai01', key: 'owner_email', type: 'text', required: false, unique: false },
                { id: 'fld_dppos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_lbase1',
            key: 'legal_bases',
            name: 'Legal bases',
            icon: 'BookOpen',
            access: ACCESS_VOCABULARY,
            fields: [
                // The KEY is what an activity stores. Unique, because two bases
                // sharing a key would merge two legally distinct grounds.
                { id: 'fld_lbkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_lbnam01', key: 'name', type: 'text', required: true, unique: false },
                // "Art. 6(1)(f) GDPR". Printed next to the entry, because a
                // register is read by people who cite articles at each other.
                { id: 'fld_lbart01', key: 'article_ref', type: 'text', required: true, unique: false },
                { id: 'fld_lbdes01', key: 'description', type: 'text', required: false, unique: false },
                // True for legitimate interests alone in the seeded vocabulary,
                // but it is DATA: an organisation that reads Art. 6(1)(e) as
                // needing a documented weighing can say so without a developer.
                { id: 'fld_lbbal01', key: 'needs_balancing', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_lbpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_dcat01',
            key: 'data_categories',
            name: 'Data categories',
            icon: 'Tags',
            access: ACCESS_VOCABULARY,
            fields: [
                { id: 'fld_dckey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_dcnam01', key: 'name', type: 'text', required: true, unique: false },
                // Art. 9. The flag changes what the organisation must do, so it
                // travels onto every link row rather than being looked up.
                { id: 'fld_dcspc01', key: 'is_special', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_dcart01', key: 'article_ref', type: 'text', required: false, unique: false },
                { id: 'fld_dcexa01', key: 'examples', type: 'text', required: false, unique: false },
                { id: 'fld_dcpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },

        // ── Suppliers ──────────────────────────────────────────────────────
        {
            id: 'tbl_proc01',
            key: 'processors',
            name: 'Processors',
            icon: 'Handshake',
            access: ACCESS_SUPPLIERS,
            fields: [
                { id: 'fld_prnam01', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_prsvc01', key: 'service', type: 'text', required: false, unique: false },
                { id: 'fld_prmai01', key: 'contact_email', type: 'text', required: false, unique: false },
                { id: 'fld_prcnt01', key: 'country', type: 'text', required: false, unique: false },
                {
                    id: 'fld_prdpa01', key: 'dpa_status', type: 'select', required: true, unique: false,
                    options: DPA_OPTIONS, default: 'none',
                },
                { id: 'fld_prdpd01', key: 'dpa_signed_on', type: 'date', required: false, unique: false },
                { id: 'fld_prdpr01', key: 'dpa_reference', type: 'text', required: false, unique: false },
                { id: 'fld_prrev01', key: 'last_audited', type: 'date', required: false, unique: false },
                { id: 'fld_prnot01', key: 'notes', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_subp01',
            key: 'sub_processors',
            name: 'Sub-processors',
            icon: 'Boxes',
            access: ACCESS_SUPPLIERS,
            fields: [
                { id: 'fld_spprc01', key: 'processor_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_proc01' } },
                // Display copy — there is no join to follow processor_id.
                { id: 'fld_spnam01', key: 'processor_name', type: 'text', required: false, unique: false },
                { id: 'fld_spsub01', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_spsvc01', key: 'service', type: 'text', required: false, unique: false },
                { id: 'fld_spcnt01', key: 'country', type: 'text', required: false, unique: false },
                // Art. 28(2): the date the processor told you about this one.
                { id: 'fld_spdis01', key: 'disclosed_on', type: 'date', required: false, unique: false },
                { id: 'fld_spnot01', key: 'notes', type: 'text', required: false, unique: false },
            ],
        },

        // ── The register ───────────────────────────────────────────────────
        {
            id: 'tbl_act001',
            key: 'processing_activities',
            name: 'Processing activities',
            icon: 'ClipboardList',
            access: ACCESS_REGISTER,
            fields: [
                { id: 'fld_acnam01', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_acpur01', key: 'purpose', type: 'text', required: true, unique: false },
                // Keys into the vocabularies. Text, not select — see the header:
                // this is what makes them end-user editable instead of schema.
                { id: 'fld_acdep01', key: 'department', type: 'text', required: false, unique: false },
                { id: 'fld_aclbs01', key: 'legal_basis', type: 'text', required: false, unique: false, default: 'contract' },
                { id: 'fld_acctl01', key: 'controller_name', type: 'text', required: false, unique: false },
                // Art. 26. Empty means sole controller, which is the common case
                // and reads better than a bool plus a name that may be blank.
                { id: 'fld_acjnt01', key: 'joint_controller', type: 'text', required: false, unique: false },
                // DERIVED at write time from legal_basis + lia_summary. Stored
                // because a filter cannot compare two columns (see the header).
                {
                    id: 'fld_aclia01', key: 'lia_status', type: 'select', required: true, unique: false,
                    options: LIA_STATUS_OPTIONS, default: 'not_required',
                },
                { id: 'fld_aclis01', key: 'lia_summary', type: 'text', required: false, unique: false },
                { id: 'fld_acsub01', key: 'data_subjects', type: 'text', required: false, unique: false },
                // A DECLARATION, not a rollup of the linked categories. See the
                // header for why the app refuses to compute this behind anyone.
                {
                    id: 'fld_acspc01', key: 'special_category', type: 'select', required: true, unique: false,
                    options: SPECIAL_CATEGORY_OPTIONS, default: 'none',
                },
                { id: 'fld_acret01', key: 'retention_period', type: 'text', required: false, unique: false },
                { id: 'fld_acrtb01', key: 'retention_basis', type: 'text', required: false, unique: false },
                { id: 'fld_acsec01', key: 'security_measures', type: 'richtext', required: false, unique: false },
                { id: 'fld_acsys01', key: 'systems', type: 'text', required: false, unique: false },
                { id: 'fld_acrev01', key: 'last_reviewed', type: 'date', required: false, unique: false },
                // Days, not months: dateAdd has no month unit, and a statutory
                // deadline should be exact rather than approximately a year.
                { id: 'fld_acint01', key: 'review_interval_days', type: 'number', subtype: 'integer', required: false, unique: false, default: 365 },
                // The materialised deadline. `next_review_date < today` is the
                // whole overdue query, and it is why this column exists.
                { id: 'fld_acnxt01', key: 'next_review_date', type: 'date', required: false, unique: false },
                {
                    id: 'fld_acsta01', key: 'status', type: 'select', required: true, unique: false,
                    options: STATUS_OPTIONS, default: 'active',
                },
                // Required with a default, so a risk tier can never be blank —
                // an unrated entry is one nobody has to argue about, which is
                // exactly how high-risk processing stays unscreened.
                {
                    id: 'fld_acrsk01', key: 'risk_tier', type: 'select', required: true, unique: false,
                    options: RISK_OPTIONS, default: 'low',
                },
                {
                    id: 'fld_acdpi01', key: 'dpia_status', type: 'select', required: true, unique: false,
                    options: DPIA_STATE_OPTIONS, default: 'not_assessed',
                },
                { id: 'fld_acrvn01', key: 'reviewer_name', type: 'text', required: false, unique: false },
                // Matched against currentUser.email so "only my reviews" works
                // identically embedded in Nextcloud and standalone.
                { id: 'fld_acrvm01', key: 'reviewer_email', type: 'text', required: false, unique: false },
            ],
        },

        // ── Links off an activity ──────────────────────────────────────────
        {
            id: 'tbl_aproc1',
            key: 'activity_processors',
            name: 'Processors per activity',
            icon: 'Handshake',
            access: ACCESS_SUPPLIERS,
            fields: [
                { id: 'fld_apact01', key: 'activity_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_act001' } },
                { id: 'fld_apacn01', key: 'activity_name', type: 'text', required: false, unique: false },
                { id: 'fld_appro01', key: 'processor_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_proc01' } },
                { id: 'fld_apprn01', key: 'processor_name', type: 'text', required: false, unique: false },
                // A SNAPSHOT of the DPA state at linking time, so the engagement
                // grid can be read without a join. The DPA register on the
                // Processors screen is the current truth.
                { id: 'fld_apdpa01', key: 'dpa_status', type: 'text', required: false, unique: false },
                { id: 'fld_aprol01', key: 'role', type: 'text', required: false, unique: false },
                { id: 'fld_apnot01', key: 'notes', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_acat01',
            key: 'activity_data_categories',
            name: 'Data categories per activity',
            icon: 'Tags',
            access: ACCESS_SUPPLIERS,
            fields: [
                { id: 'fld_caact01', key: 'activity_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_act001' } },
                { id: 'fld_caacn01', key: 'activity_name', type: 'text', required: false, unique: false },
                { id: 'fld_cakey01', key: 'category_key', type: 'text', required: false, unique: false },
                { id: 'fld_canam01', key: 'category_name', type: 'text', required: false, unique: false },
                // Copied from the vocabulary row at link time. Without it, "show
                // me every Art. 9 processing" would need a join this engine has
                // no way to express.
                { id: 'fld_caspc01', key: 'is_special', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_canot01', key: 'notes', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_trans1',
            key: 'transfers',
            name: 'Third-country transfers',
            icon: 'ExternalLink',
            access: ACCESS_SUPPLIERS,
            fields: [
                { id: 'fld_tract01', key: 'activity_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_act001' } },
                { id: 'fld_tracn01', key: 'activity_name', type: 'text', required: false, unique: false },
                // Plain text, not a relation: the receiving party is often not a
                // processor you have a row for (a group company, a court).
                { id: 'fld_trpro01', key: 'recipient', type: 'text', required: true, unique: false },
                { id: 'fld_trcnt01', key: 'country', type: 'text', required: true, unique: false },
                {
                    id: 'fld_trsaf01', key: 'safeguard', type: 'select', required: true, unique: false,
                    options: SAFEGUARD_OPTIONS, default: 'sccs',
                },
                { id: 'fld_trref01', key: 'safeguard_reference', type: 'text', required: false, unique: false },
                // Schrems II: clauses on their own are not enough, someone has
                // to have assessed the destination. This column is the question
                // a Dutch DPO is actually asked.
                { id: 'fld_trtia01', key: 'tia_done', type: 'bool', required: false, unique: false, default: false },
                { id: 'fld_trdat01', key: 'assessed_on', type: 'date', required: false, unique: false },
                { id: 'fld_trnot01', key: 'notes', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_dpia01',
            key: 'dpias',
            name: 'DPIAs',
            icon: 'ShieldCheck',
            access: ACCESS_SUPPLIERS,
            fields: [
                { id: 'fld_dpact01', key: 'activity_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_act001' } },
                { id: 'fld_dpacn01', key: 'activity_name', type: 'text', required: false, unique: false },
                { id: 'fld_dptit01', key: 'title', type: 'text', required: true, unique: false },
                {
                    id: 'fld_dpsta01', key: 'status', type: 'select', required: true, unique: false,
                    options: DPIA_PHASE_OPTIONS, default: 'screening',
                },
                {
                    id: 'fld_dpout01', key: 'outcome', type: 'select', required: true, unique: false,
                    options: DPIA_OUTCOME_OPTIONS, default: 'pending',
                },
                // The SAME three tiers as the register's risk_tier, because the
                // triage copies one straight into the other — two vocabularies
                // would make "did the DPIA lower the risk?" unanswerable.
                {
                    id: 'fld_dpres01', key: 'residual_risk', type: 'select', required: true, unique: false,
                    options: RISK_OPTIONS, default: 'elevated',
                },
                { id: 'fld_dpmea01', key: 'measures', type: 'richtext', required: false, unique: false },
                { id: 'fld_dpstd01', key: 'started_on', type: 'date', required: false, unique: false },
                { id: 'fld_dpcom01', key: 'completed_on', type: 'date', required: false, unique: false },
                { id: 'fld_dpown01', key: 'owner_name', type: 'text', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_rlog01',
            key: 'review_log',
            name: 'Review log',
            icon: 'History',
            access: ACCESS_REVIEW_LOG,
            fields: [
                { id: 'fld_rlact01', key: 'activity_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_act001' } },
                { id: 'fld_rlacn01', key: 'activity_name', type: 'text', required: false, unique: false },
                { id: 'fld_rlwho01', key: 'reviewer_name', type: 'text', required: false, unique: false },
                { id: 'fld_rlwhe01', key: 'reviewed_on', type: 'date', required: false, unique: false },
                // The deadline this review SET. Keeping it on the log entry is
                // what lets an auditor reconstruct the cadence from the log
                // alone, without trusting the activity row's current value.
                { id: 'fld_rlnxt01', key: 'next_review_date', type: 'date', required: false, unique: false },
                {
                    id: 'fld_rlkin01', key: 'kind', type: 'select', required: true, unique: false,
                    options: REVIEW_KIND_OPTIONS, default: 'periodic_review',
                },
                { id: 'fld_rlnot01', key: 'note', type: 'text', required: false, unique: false },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Reading the OPEN entry.
//
// `vars.activity` is the selection. These helpers turn it into a live read of
// the row, which is what every value on the entry screen renders from — see the
// module header. `required:true` is load-bearing twice over: with nothing
// selected the panels show their empty text instead of the first row of the
// whole register, and after a delete they go quiet rather than showing a ghost.
//
// Every one of these bindings has the SAME tableId + filter + limit, and
// dataCacheKey ignores `path` — so the header, the detail panel and fourteen
// prefilled inputs are one fetch.
// ---------------------------------------------------------------------------

const ACTIVITY_SCOPE = [
    { field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.activity.id' }, required: true },
];

/** The open activity's whole row, or one column of it. */
const openActivity = (path) => (path
    ? { kind: 'record', tableId: 'tbl_act001', filter: ACTIVITY_SCOPE, limit: 1, path }
    : { kind: 'record', tableId: 'tbl_act001', filter: ACTIVITY_SCOPE, limit: 1 });

/** Rows of a child table belonging to the open activity. */
const forOpenActivity = (tableId, sort, limit) => ({
    kind: 'records',
    tableId,
    filter: [{ field: 'activity_id', op: 'eq', value: { kind: 'formula', expr: 'vars.activity.id' }, required: true }],
    sort,
    limit,
});

/** Rows belonging to the selected processor, same shape. */
const forOpenProcessor = (tableId, sort, limit) => ({
    kind: 'records',
    tableId,
    filter: [{ field: 'processor_id', op: 'eq', value: { kind: 'formula', expr: 'vars.processor.id' }, required: true }],
    sort,
    limit,
});

/** A count of activities matching one extra clause. Always limited — see 14. */
const activityCount = (extra) => ({
    kind: 'aggregate',
    tableId: 'tbl_act001',
    aggregates: [{ fn: 'count', field: '*', as: 'n' }],
    filter: extra,
    limit: 1,
});

// ==================================================================
// REGISTER — the front screen. The two findings sit ABOVE the register,
// because a finding you have to search for is a finding nobody fixes.
// ==================================================================
const SCREEN_REGISTER = {
    id: 'scr_register',
    name: 'Register',
    icon: 'ClipboardList',
    showInNav: true,
    maxWidth: 'full',
    description: 'The Article 30 record of processing activities.',
    sections: [
        {
            id: 'sec_rgtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rghdr',
                    type: 'page_header',
                    props: {
                        look: 'split',
                        title: 'Processing register (verwerkingsregister)',
                        subtitle: 'Article 30 GDPR — the record of processing activities, and the first document a supervisory authority asks for.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'ClipboardList',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_rgnew',
                            type: 'button',
                            props: { label: 'New activity', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_newopen',
                        },
                    ],
                },
                {
                    id: 'cmp_rgst1',
                    type: 'stat',
                    props: {
                        label: 'Entries',
                        value: activityCount([{ field: 'status', op: 'eq', value: 'active' }]),
                        caption: 'active processing activities',
                        icon: 'ClipboardList',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_rgst2',
                    type: 'stat',
                    props: {
                        label: 'Reviews overdue',
                        // The whole overdue query, made possible by storing the
                        // deadline instead of deriving it (see the header).
                        value: activityCount([
                            { field: 'status', op: 'eq', value: 'active' },
                            { field: 'next_review_date', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                        ]),
                        caption: 'past the date the last review set',
                        icon: 'AlertTriangle',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_rgst3',
                    type: 'stat',
                    props: {
                        label: 'Balancing test missing',
                        value: activityCount([{ field: 'lia_status', op: 'eq', value: 'missing' }]),
                        caption: 'legitimate interests, nothing written down',
                        icon: 'FileCheck',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
                {
                    id: 'cmp_rgst4',
                    type: 'stat',
                    props: {
                        label: 'Special category',
                        value: activityCount([{ field: 'special_category', op: 'eq', value: 'present' }]),
                        caption: 'Article 9 data declared',
                        icon: 'ShieldCheck',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_rgfind',
            style: { padding: 4, gap: 3, background: 'panel' },
            children: [
                {
                    id: 'cmp_rgh1',
                    type: 'heading',
                    props: { text: 'Reviews overdue', level: 3 },
                    style: { span: 6 },
                    visible: true,
                },
                {
                    id: 'cmp_rgh2',
                    type: 'heading',
                    props: { text: 'Legitimate interests without a balancing test', level: 3 },
                    style: { span: 6 },
                    visible: true,
                },
                {
                    id: 'cmp_rgover',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_act001',
                            filter: [
                                { field: 'status', op: 'eq', value: 'active' },
                                { field: 'next_review_date', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                            ],
                            sort: [{ field: 'next_review_date', dir: 'asc' }],
                            limit: 25,
                        },
                        titleKey: 'name',
                        subtitleKey: 'reviewer_name',
                        metaKey: 'next_review_date',
                        timestampKey: null,
                        badgeKey: 'risk_tier',
                        badgeToneMap: RISK_TONES,
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'CalendarClock',
                        emptyText: 'Nothing is overdue — every entry has been reviewed inside its own interval.',
                    },
                    style: { span: 6, height: 'md' },
                    visible: true,
                    onRowClick: 'act_pickact',
                },
                {
                    id: 'cmp_rglia',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_act001',
                            filter: [{ field: 'lia_status', op: 'eq', value: 'missing' }],
                            sort: [{ field: 'name', dir: 'asc' }],
                            limit: 25,
                        },
                        titleKey: 'name',
                        subtitleKey: 'purpose',
                        metaKey: 'department',
                        timestampKey: null,
                        badgeKey: 'risk_tier',
                        badgeToneMap: RISK_TONES,
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'FileCheck',
                        emptyText: 'Every entry relying on legitimate interests has its balancing test written down.',
                    },
                    style: { span: 6, height: 'md' },
                    visible: true,
                    onRowClick: 'act_pickact',
                },
            ],
        },
        {
            id: 'sec_rgfilt',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rgfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search', type: 'search', options: [] },
                            { name: 'department', label: 'Department', type: 'select', options: DEPARTMENT_OPTIONS },
                            { name: 'legal_basis', label: 'Legal basis', type: 'select', options: LEGAL_BASIS_OPTIONS },
                            { name: 'risk_tier', label: 'Risk', type: 'select', options: RISK_OPTIONS },
                            { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
                        ],
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            // ONE row: a fill section stretches its first grid row only.
            id: 'sec_rgmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_rggrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_act001',
                            filter: [
                                { field: 'name', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                { field: 'department', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.department' }, required: false },
                                { field: 'legal_basis', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.legal_basis' }, required: false },
                                { field: 'risk_tier', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.risk_tier' }, required: false },
                                { field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.status' }, required: false },
                            ],
                            // Soonest deadline first: the register opens on the
                            // work rather than on the alphabet.
                            sort: [{ field: 'next_review_date', dir: 'asc' }],
                            limit: 400,
                        },
                        columns: [
                            { key: 'name', label: 'Activity', format: 'text', width: 260, sortable: true, filterable: true, editable: false },
                            { key: 'department', label: 'Department', format: 'badge', width: 140, sortable: true, filterable: true, editable: false },
                            { key: 'legal_basis', label: 'Legal basis', format: 'badge', width: 170, sortable: true, filterable: true, editable: false },
                            { key: 'lia_status', label: 'Balancing test', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'special_category', label: 'Art. 9', format: 'badge', width: 120, sortable: true, filterable: true, editable: false },
                            { key: 'risk_tier', label: 'Risk', format: 'badge', width: 110, sortable: true, filterable: true, editable: false },
                            { key: 'next_review_date', label: 'Review due', format: 'date', width: 130, sortable: true, filterable: false, editable: false },
                            { key: 'status', label: 'Status', format: 'badge', width: 110, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        // No inline editing, unlike the vocabularies on Setup: a
                        // statutory record is amended through a recorded change,
                        // never by typing in a cell.
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Open', actionId: 'act_pickact' }],
                        look: 'minimal',
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No entries match these filters. Clear them, or record the first activity.',
                    },
                    style: { span: 12, height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_rgdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_newmodal',
                    type: 'modal',
                    props: { title: 'New processing activity', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_newform',
                            type: 'form',
                            props: { name: 'newactivity', submitLabel: 'Add to the register', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_newsave',
                            children: [
                                { id: 'cmp_nwf01', type: 'input_text', props: { name: 'name', label: 'Name of the processing activity', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_nwf02', type: 'input_textarea', props: { name: 'purpose', label: 'Purpose — Art. 30(1)(b)', required: true, rows: 2 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_nwf03', type: 'input_select', props: { name: 'department', label: 'Department', required: false, options: DEPARTMENT_OPTIONS, defaultValue: null, placeholder: 'Pick a department', valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_nwf04', type: 'input_text', props: { name: 'controller_name', label: 'Controller — Art. 30(1)(a)', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_nwf05', type: 'input_select', props: { name: 'legal_basis', label: 'Legal basis', required: true, options: LEGAL_BASIS_OPTIONS, defaultValue: 'contract', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_nwf06', type: 'input_select', props: { name: 'risk_tier', label: 'Risk tier', required: true, options: RISK_OPTIONS, defaultValue: 'low', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                // The balancing test is a text box, not a tick.
                                // An entry counts as compliant exactly when
                                // somebody has written down what they weighed.
                                { id: 'cmp_nwf07', type: 'input_textarea', props: { name: 'lia_summary', label: 'Balancing test (LIA) — required when the basis is legitimate interests', required: false, rows: 3 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_nwf08', type: 'input_text', props: { name: 'data_subjects', label: 'Categories of data subjects — Art. 30(1)(c)', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_nwf09', type: 'input_select', props: { name: 'special_category', label: 'Special-category data', required: true, options: SPECIAL_CATEGORY_OPTIONS, defaultValue: 'none', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_nwf10', type: 'input_number', props: { name: 'review_interval_days', label: 'Review every (days)', required: false, min: 30, max: 1825, step: 1, defaultValue: 365 }, style: { span: 6 }, visible: true },
                                { id: 'cmp_nwf11', type: 'input_text', props: { name: 'retention_period', label: 'Retention period — Art. 30(1)(f)', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_nwf12', type: 'input_text', props: { name: 'retention_basis', label: 'Why that period', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_nwf13', type: 'input_text', props: { name: 'reviewer_name', label: 'Reviewer', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_nwf14', type: 'input_text', props: { name: 'reviewer_email', label: 'Reviewer e-mail', required: false, inputType: 'email' }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// ENTRY — one register entry in full, plus everything hanging off it.
// Nothing here renders from the selection snapshot; see the header.
// ==================================================================
const SCREEN_ACTIVITY = {
    id: 'scr_activity',
    name: 'Register entry',
    icon: 'FileText',
    showInNav: false,
    maxWidth: 'wide',
    description: 'One processing activity, its processors, transfers and reviews.',
    sections: [
        {
            id: 'sec_actop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_acthdr',
                    type: 'page_header',
                    props: {
                        look: 'split',
                        title: 'Register entry',
                        subtitle: null,
                        titleFrom: openActivity('name'),
                        subtitleFrom: openActivity('purpose'),
                        icon: 'FileText',
                        showDivider: true,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_actback',
                            type: 'button',
                            props: { label: 'Back to the register', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_backreg',
                        },
                        {
                            id: 'cmp_actedit',
                            type: 'button',
                            props: { label: 'Edit entry', variant: 'secondary', iconLeft: 'Wrench', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_editopen',
                        },
                        {
                            id: 'cmp_actrev',
                            type: 'button',
                            props: { label: 'Record a review', variant: 'primary', iconLeft: 'CheckCircle2', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_revopen',
                        },
                    ],
                },
                {
                    id: 'cmp_actdet',
                    type: 'record_detail',
                    props: {
                        source: openActivity(null),
                        columns: 3,
                        fields: [
                            { key: 'name', label: 'Activity', format: 'text' },
                            { key: 'department', label: 'Department', format: 'badge' },
                            { key: 'status', label: 'Status', format: 'badge' },
                            { key: 'purpose', label: 'Purpose (Art. 30(1)(b))', format: 'text' },
                            { key: 'controller_name', label: 'Controller (Art. 30(1)(a))', format: 'text' },
                            { key: 'joint_controller', label: 'Joint controller (Art. 26)', format: 'text' },
                            { key: 'legal_basis', label: 'Legal basis (Art. 6)', format: 'badge' },
                            { key: 'lia_status', label: 'Balancing test', format: 'badge' },
                            { key: 'lia_summary', label: 'What was weighed', format: 'text' },
                            { key: 'data_subjects', label: 'Data subjects (Art. 30(1)(c))', format: 'text' },
                            { key: 'special_category', label: 'Special category (Art. 9)', format: 'badge' },
                            { key: 'risk_tier', label: 'Risk tier', format: 'badge' },
                            { key: 'retention_period', label: 'Retention (Art. 30(1)(f))', format: 'text' },
                            { key: 'retention_basis', label: 'Why that period', format: 'text' },
                            { key: 'systems', label: 'Systems', format: 'text' },
                            { key: 'last_reviewed', label: 'Last reviewed', format: 'date' },
                            { key: 'next_review_date', label: 'Next review due', format: 'date' },
                            { key: 'review_interval_days', label: 'Interval (days)', format: 'number' },
                            { key: 'reviewer_name', label: 'Reviewer', format: 'text' },
                            { key: 'reviewer_email', label: 'Reviewer e-mail', format: 'text' },
                            { key: 'dpia_status', label: 'DPIA (Art. 35)', format: 'badge' },
                            { key: 'security_measures', label: 'Security measures (Art. 30(1)(g))', format: 'markdown' },
                        ],
                        emptyText: 'Open an entry from the register to see it here.',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            // The triage bar. Each select owns exactly ONE column and writes
            // only that one: onChange hands over the whole form, so a shared
            // action would re-write the siblings from whatever they happen to
            // hold — and silently blanking a risk tier is the failure this app
            // is meant to prevent. Four small actions instead of one big one.
            id: 'sec_acttri',
            style: { padding: 4, gap: 3, background: 'panel' },
            children: [
                {
                    id: 'cmp_acttf',
                    type: 'form',
                    props: { name: 'triage', submitLabel: 'Save', showReset: false, showSubmit: false },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_acttf1',
                            type: 'input_select',
                            props: { name: 'status', label: 'Status', required: true, options: STATUS_OPTIONS, defaultValue: 'active', placeholder: null, valueFrom: openActivity('status') },
                            style: { span: 3 },
                            visible: true,
                            onChange: 'act_setstat',
                        },
                        {
                            id: 'cmp_acttf2',
                            type: 'input_select',
                            props: { name: 'risk_tier', label: 'Risk tier', required: true, options: RISK_OPTIONS, defaultValue: 'low', placeholder: null, valueFrom: openActivity('risk_tier') },
                            style: { span: 3 },
                            visible: true,
                            onChange: 'act_setrisk',
                        },
                        {
                            id: 'cmp_acttf3',
                            type: 'input_select',
                            props: { name: 'special_category', label: 'Special category', required: true, options: SPECIAL_CATEGORY_OPTIONS, defaultValue: 'none', placeholder: null, valueFrom: openActivity('special_category') },
                            style: { span: 3 },
                            visible: true,
                            onChange: 'act_setspec',
                        },
                        {
                            id: 'cmp_acttf4',
                            type: 'input_select',
                            props: { name: 'dpia_status', label: 'DPIA', required: true, options: DPIA_STATE_OPTIONS, defaultValue: 'not_assessed', placeholder: null, valueFrom: openActivity('dpia_status') },
                            style: { span: 3 },
                            visible: true,
                            onChange: 'act_setdpia',
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_actmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_acttabs',
                    type: 'tabs',
                    props: {},
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_acttb1',
                            type: 'tab',
                            props: { label: 'Processors', icon: 'Handshake' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_actap',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenActivity('tbl_aproc1', [{ field: 'processor_name', dir: 'asc' }], 100),
                                        columns: [
                                            { key: 'processor_name', label: 'Processor', format: 'text', width: 220, sortable: true, filterable: true, editable: false },
                                            { key: 'role', label: 'Role', format: 'text', width: 200, sortable: false, filterable: false, editable: false },
                                            { key: 'dpa_status', label: 'DPA at linking', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'notes', label: 'Notes', format: 'text', width: 240, sortable: false, filterable: false, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Unlink', actionId: 'act_unlink' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No processors linked to this entry yet — pick one from the list on the right.',
                                    },
                                    style: { span: 7 },
                                    visible: true,
                                },
                                {
                                    // The picker. Linking reads the CLICKED row,
                                    // which is the only place both the processor
                                    // and the open activity are in scope at once
                                    // — so the display copies are written here.
                                    id: 'cmp_actpp',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_proc01', sort: [{ field: 'name', dir: 'asc' }], limit: 100 },
                                        columns: [
                                            { key: 'name', label: 'Processor', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                                            { key: 'dpa_status', label: 'DPA', format: 'badge', width: 130, sortable: true, filterable: true, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: true,
                                        rowActions: [{ label: 'Link to this entry', actionId: 'act_link' }],
                                        density: 'compact',
                                        zebra: false,
                                        emptyText: 'No processors recorded yet — add them on the Processors screen.',
                                    },
                                    style: { span: 5 },
                                    visible: true,
                                },
                            ],
                        },
                        {
                            id: 'cmp_acttb2',
                            type: 'tab',
                            props: { label: 'Transfers', icon: 'ExternalLink' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_acttr',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenActivity('tbl_trans1', [{ field: 'country', dir: 'asc' }], 100),
                                        columns: [
                                            { key: 'recipient', label: 'Recipient', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                                            { key: 'country', label: 'Country', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'safeguard', label: 'Safeguard', format: 'badge', width: 170, sortable: true, filterable: true, editable: false },
                                            { key: 'safeguard_reference', label: 'Reference', format: 'text', width: 220, sortable: false, filterable: false, editable: false },
                                            { key: 'tia_done', label: 'TIA done', format: 'boolean', width: 110, sortable: true, filterable: true, editable: false },
                                            { key: 'assessed_on', label: 'Assessed', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Remove', actionId: 'act_deltr' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No transfers outside the EEA recorded for this entry.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_acttrf',
                                    type: 'form',
                                    props: { name: 'newtransfer', submitLabel: 'Add transfer', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_savetr',
                                    children: [
                                        { id: 'cmp_actt1', type: 'input_text', props: { name: 'recipient', label: 'Recipient', required: true, inputType: 'text' }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_actt2', type: 'input_text', props: { name: 'country', label: 'Country', required: true, inputType: 'text' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_actt3', type: 'input_select', props: { name: 'safeguard', label: 'Safeguard', required: true, options: SAFEGUARD_OPTIONS, defaultValue: 'sccs', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 5 }, visible: true },
                                        { id: 'cmp_actt4', type: 'input_text', props: { name: 'safeguard_reference', label: 'Reference', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_actt5', type: 'input_date', props: { name: 'assessed_on', label: 'Transfer impact assessment done on', required: false, defaultValue: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_actt6', type: 'input_checkbox', props: { name: 'tia_done', label: 'A transfer impact assessment is on file (Schrems II)', defaultChecked: false }, style: { span: 12 }, visible: true },
                                        { id: 'cmp_actt7', type: 'input_text', props: { name: 'notes', label: 'Notes', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                        {
                            id: 'cmp_acttb3',
                            type: 'tab',
                            props: { label: 'Data categories', icon: 'Tags' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_actdc',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenActivity('tbl_acat01', [{ field: 'category_name', dir: 'asc' }], 100),
                                        columns: [
                                            { key: 'category_name', label: 'Category', format: 'text', width: 220, sortable: true, filterable: true, editable: false },
                                            { key: 'is_special', label: 'Article 9', format: 'boolean', width: 120, sortable: true, filterable: true, editable: false },
                                            { key: 'notes', label: 'Notes', format: 'text', width: 300, sortable: false, filterable: false, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Remove', actionId: 'act_delcat' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No data categories recorded for this entry yet.',
                                    },
                                    style: { span: 7 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_actdcp',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_dcat01', sort: [{ field: 'position', dir: 'asc' }], limit: 60 },
                                        columns: [
                                            { key: 'name', label: 'Category', format: 'text', width: 200, sortable: false, filterable: false, editable: false },
                                            { key: 'is_special', label: 'Art. 9', format: 'boolean', width: 100, sortable: false, filterable: false, editable: false },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: true,
                                        rowActions: [{ label: 'Add to this entry', actionId: 'act_addcat' }],
                                        density: 'compact',
                                        zebra: false,
                                        emptyText: 'The data-category vocabulary is empty — fill it on the Vocabularies screen.',
                                    },
                                    style: { span: 5 },
                                    visible: true,
                                },
                            ],
                        },
                        {
                            id: 'cmp_acttb4',
                            type: 'tab',
                            props: { label: 'DPIA', icon: 'ShieldCheck' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_actdp',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenActivity('tbl_dpia01', [{ field: 'started_on', dir: 'desc' }], 50),
                                        columns: [
                                            { key: 'title', label: 'Assessment', format: 'text', width: 240, sortable: true, filterable: false, editable: false },
                                            { key: 'status', label: 'Phase', format: 'badge', width: 170, sortable: true, filterable: true, editable: true },
                                            { key: 'outcome', label: 'Outcome', format: 'badge', width: 190, sortable: true, filterable: true, editable: true },
                                            { key: 'residual_risk', label: 'Residual risk', format: 'badge', width: 140, sortable: true, filterable: true, editable: true },
                                            { key: 'started_on', label: 'Started', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                                            { key: 'completed_on', label: 'Completed', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                                        ],
                                        pageSize: 10,
                                        // Inline editing REQUIRES selectable 'none':
                                        // with a selection mode set, onRowSelect
                                        // fires with { selected: rows } instead of
                                        // the edited row.
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No impact assessment for this entry. Start one from the DPIA screen, or below.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_dpiasave',
                                },
                                {
                                    id: 'cmp_actdpb',
                                    type: 'button',
                                    props: { label: 'Start a DPIA for this entry', variant: 'secondary', iconLeft: 'ShieldCheck', role: 'button' },
                                    style: { span: 4 },
                                    visible: true,
                                    onClick: 'act_dpiahere',
                                },
                            ],
                        },
                        {
                            id: 'cmp_acttb5',
                            type: 'tab',
                            props: { label: 'Review history', icon: 'History' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_actrl',
                                    type: 'timeline',
                                    props: {
                                        source: forOpenActivity('tbl_rlog01', [{ field: 'reviewed_on', dir: 'desc' }], 50),
                                        titleKey: 'note',
                                        dateKey: 'reviewed_on',
                                        descriptionKey: 'reviewer_name',
                                        icon: 'History',
                                        rowLimit: 50,
                                        emptyText: 'No review has been recorded for this entry yet. Nobody may edit this log once it is written.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_actdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_editmodal',
                    type: 'modal',
                    props: { title: 'Edit register entry', size: 'lg', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            // Every field prefills from the LIVE row, not from
                            // the selection snapshot — so an entry edited twice
                            // in a row does not silently restore the first save.
                            id: 'cmp_editform',
                            type: 'form',
                            props: { name: 'editactivity', submitLabel: 'Save the entry', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_editsave',
                            children: [
                                { id: 'cmp_edf01', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text', valueFrom: openActivity('name') }, style: { span: 12 }, visible: true },
                                { id: 'cmp_edf02', type: 'input_textarea', props: { name: 'purpose', label: 'Purpose — Art. 30(1)(b)', required: true, rows: 2, valueFrom: openActivity('purpose') }, style: { span: 12 }, visible: true },
                                { id: 'cmp_edf03', type: 'input_select', props: { name: 'department', label: 'Department', required: false, options: DEPARTMENT_OPTIONS, defaultValue: null, placeholder: 'Pick a department', valueFrom: openActivity('department') }, style: { span: 6 }, visible: true },
                                { id: 'cmp_edf04', type: 'input_select', props: { name: 'legal_basis', label: 'Legal basis — Art. 6', required: true, options: LEGAL_BASIS_OPTIONS, defaultValue: 'contract', placeholder: null, valueFrom: openActivity('legal_basis') }, style: { span: 6 }, visible: true },
                                { id: 'cmp_edf05', type: 'input_text', props: { name: 'controller_name', label: 'Controller — Art. 30(1)(a)', required: false, inputType: 'text', valueFrom: openActivity('controller_name') }, style: { span: 6 }, visible: true },
                                { id: 'cmp_edf06', type: 'input_text', props: { name: 'joint_controller', label: 'Joint controller — Art. 26 (leave empty if sole)', required: false, inputType: 'text', valueFrom: openActivity('joint_controller') }, style: { span: 6 }, visible: true },
                                { id: 'cmp_edf07', type: 'input_textarea', props: { name: 'lia_summary', label: 'Balancing test (LIA) — the interests weighed, and why processing wins', required: false, rows: 3, valueFrom: openActivity('lia_summary') }, style: { span: 12 }, visible: true },
                                { id: 'cmp_edf08', type: 'input_text', props: { name: 'data_subjects', label: 'Categories of data subjects — Art. 30(1)(c)', required: false, inputType: 'text', valueFrom: openActivity('data_subjects') }, style: { span: 12 }, visible: true },
                                { id: 'cmp_edf09', type: 'input_text', props: { name: 'retention_period', label: 'Retention period — Art. 30(1)(f)', required: false, inputType: 'text', valueFrom: openActivity('retention_period') }, style: { span: 6 }, visible: true },
                                { id: 'cmp_edf10', type: 'input_text', props: { name: 'retention_basis', label: 'Why that period', required: false, inputType: 'text', valueFrom: openActivity('retention_basis') }, style: { span: 6 }, visible: true },
                                { id: 'cmp_edf11', type: 'input_text', props: { name: 'systems', label: 'Systems the data lives in', required: false, inputType: 'text', valueFrom: openActivity('systems') }, style: { span: 12 }, visible: true },
                                { id: 'cmp_edf12', type: 'input_richtext', props: { name: 'security_measures', label: 'Security measures — Art. 30(1)(g)', required: false, defaultValue: null, valueFrom: openActivity('security_measures') }, style: { span: 12 }, visible: true },
                                { id: 'cmp_edf13', type: 'input_text', props: { name: 'reviewer_name', label: 'Reviewer', required: false, inputType: 'text', valueFrom: openActivity('reviewer_name') }, style: { span: 6 }, visible: true },
                                { id: 'cmp_edf14', type: 'input_text', props: { name: 'reviewer_email', label: 'Reviewer e-mail', required: false, inputType: 'email', valueFrom: openActivity('reviewer_email') }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_revmodal',
                    type: 'modal',
                    props: { title: 'Record a review', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_revform',
                            type: 'form',
                            props: { name: 'reviewactivity', submitLabel: 'Record the review', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_revsave',
                            children: [
                                // The deadline is measured from the date the
                                // review actually happened, not from now — so a
                                // review entered a week late does not quietly
                                // buy the organisation an extra week.
                                { id: 'cmp_rvf01', type: 'input_date', props: { name: 'reviewed_on', label: 'Reviewed on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                // `input_number` has no `valueFrom`, so this cannot
                                // prefill from the entry the way the rest of the
                                // screen does — it always opens on 365, and the
                                // review WRITES it. An entry on a two-yearly cadence
                                // would silently drop to yearly, so the label says
                                // so rather than the app doing it quietly. The
                                // entry's current interval is on the detail panel
                                // above, and in the review log.
                                { id: 'cmp_rvf02', type: 'input_number', props: { name: 'review_interval_days', label: 'Review again in (days) — replaces the interval on the entry', required: true, min: 30, max: 1825, step: 1, defaultValue: 365 }, style: { span: 6 }, visible: true },
                                { id: 'cmp_rvf03', type: 'input_select', props: { name: 'kind', label: 'What kind of review', required: true, options: REVIEW_KIND_OPTIONS, defaultValue: 'periodic_review', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_rvf04', type: 'input_text', props: { name: 'reviewer_name', label: 'Reviewed by', required: true, inputType: 'text', valueFrom: openActivity('reviewer_name') }, style: { span: 6 }, visible: true },
                                { id: 'cmp_rvf05', type: 'input_textarea', props: { name: 'note', label: 'What you checked, and what changed', required: true, rows: 3 }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// REVIEWS — the cadence. An Art. 30 record two years stale is a finding,
// so the deadline gets a calendar rather than a column nobody sorts by.
// ==================================================================
const SCREEN_REVIEWS = {
    id: 'scr_reviews',
    name: 'Reviews',
    icon: 'CalendarDays',
    showInNav: true,
    maxWidth: 'full',
    description: 'When every entry falls due, and what is already late.',
    sections: [
        {
            id: 'sec_rvtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rvhdr',
                    type: 'page_header',
                    props: {
                        look: 'split',
                        title: 'Review calendar',
                        subtitle: 'Every entry carries its own interval. The calendar plots the date the last review set — recording a review moves it.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'CalendarDays',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_rvrem',
                            type: 'button',
                            props: { label: 'Chase the overdue reviewers', variant: 'secondary', iconLeft: 'Mail', role: 'button' },
                            style: { span: 4 },
                            visible: true,
                            onClick: 'act_remind',
                        },
                    ],
                },
                {
                    // The one place this app asks for something outside itself.
                    // run_automation with no automation chosen is legal and
                    // deliberate — but a button that silently does nothing is
                    // not, so the screen says what is missing and who fixes it.
                    id: 'cmp_rvnote',
                    type: 'callout',
                    props: {
                        title: 'The reminder button needs one of your own automations',
                        text: 'Chasing reviewers is a mail job, not a register job, so this button runs an automation you own. Nothing is wired to it yet: open the app in the builder, pick the automation that should send the reminder, and the button starts working. Everything else here works with no automation, no connector and no Nextcloud.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
                {
                    id: 'cmp_rvfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'department', label: 'Department', type: 'select', options: DEPARTMENT_OPTIONS },
                            { name: 'risk_tier', label: 'Risk', type: 'select', options: RISK_OPTIONS },
                            { name: 'mine', label: 'Only mine', type: 'toggle', options: [] },
                        ],
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
                    id: 'cmp_rvcal',
                    type: 'calendar',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_act001',
                            filter: [
                                { field: 'status', op: 'eq', value: 'active' },
                                { field: 'department', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.department' }, required: false },
                                { field: 'risk_tier', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.risk_tier' }, required: false },
                                // A toggle that is OFF must not mean "assigned to
                                // nobody": it resolves to null and the clause is
                                // dropped entirely.
                                { field: 'reviewer_email', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.mine ? currentUser.email : null' }, required: false },
                            ],
                            sort: [{ field: 'next_review_date', dir: 'asc' }],
                            limit: 300,
                        },
                        dateKey: 'next_review_date',
                        endDateKey: null,
                        titleKey: 'name',
                        colorKey: 'risk_tier',
                        view: 'month',
                        emptyText: 'Nothing falls due in this month.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_pickact',
                },
                {
                    id: 'cmp_rvover',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_act001',
                            filter: [
                                { field: 'status', op: 'eq', value: 'active' },
                                { field: 'next_review_date', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                            ],
                            sort: [{ field: 'next_review_date', dir: 'asc' }],
                            limit: 100,
                        },
                        columns: [
                            { key: 'name', label: 'Overdue', format: 'text', width: 220, sortable: true, filterable: false, editable: false },
                            { key: 'next_review_date', label: 'Was due', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                            { key: 'reviewer_name', label: 'Reviewer', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: false,
                        rowActions: [{ label: 'Open', actionId: 'act_pickact' }],
                        look: 'minimal',
                        density: 'compact',
                        zebra: true,
                        emptyText: 'Nothing is overdue.',
                    },
                    style: { span: 4, height: 'fill' },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// PROCESSORS — Art. 28. The DPA register, who sits behind each supplier,
// and which entries in the register depend on them.
// ==================================================================
const SCREEN_PROCESSORS = {
    id: 'scr_procs',
    name: 'Processors',
    icon: 'Handshake',
    showInNav: true,
    maxWidth: 'full',
    description: 'Suppliers processing on your behalf, and their sub-processors.',
    sections: [
        {
            id: 'sec_prtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_prhdr',
                    type: 'page_header',
                    props: {
                        look: 'split',
                        title: 'Processors and sub-processors',
                        subtitle: 'Article 28 — who processes on your behalf, whether a data processing agreement is signed, and who sits behind them. Pick one on the left to see its chain.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'Handshake',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_prnew',
                            type: 'button',
                            props: { label: 'New processor', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_procopen',
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_prmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_prlist',
                    type: 'list',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_proc01', sort: [{ field: 'name', dir: 'asc' }], limit: 100 },
                        titleKey: 'name',
                        subtitleKey: 'service',
                        metaKey: 'country',
                        timestampKey: null,
                        badgeKey: 'dpa_status',
                        badgeToneMap: DPA_TONES,
                        unreadKey: null,
                        selectedWhen: 'item.id == vars.processor.id',
                        icon: 'Handshake',
                        emptyText: 'No processors recorded yet.',
                    },
                    style: { span: 3, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_pickproc',
                },
                {
                    id: 'cmp_prtabs',
                    type: 'tabs',
                    props: {},
                    style: { span: 9, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_prtb1',
                            type: 'tab',
                            props: { label: 'DPA register', icon: 'FileCheck' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    // The audit view, and the one grid here that
                                    // IS inline-editable: a DPA reference is
                                    // administrative fact, not a statutory
                                    // statement about your own processing.
                                    id: 'cmp_prgrid',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_proc01', sort: [{ field: 'name', dir: 'asc' }], limit: 200 },
                                        columns: [
                                            { key: 'name', label: 'Processor', format: 'text', width: 200, sortable: true, filterable: true, editable: true },
                                            { key: 'service', label: 'Service', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'country', label: 'Country', format: 'text', width: 140, sortable: true, filterable: true, editable: true },
                                            { key: 'dpa_status', label: 'DPA', format: 'badge', width: 130, sortable: true, filterable: true, editable: true },
                                            { key: 'dpa_signed_on', label: 'Signed', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                                            { key: 'dpa_reference', label: 'Reference', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'last_audited', label: 'Last audited', format: 'date', width: 130, sortable: true, filterable: false, editable: true },
                                            { key: 'contact_email', label: 'Contact', format: 'text', width: 220, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: true,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No processors recorded yet.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_procsave',
                                },
                            ],
                        },
                        {
                            id: 'cmp_prtb2',
                            type: 'tab',
                            props: { label: 'Sub-processors', icon: 'Boxes' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_prsub',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenProcessor('tbl_subp01', [{ field: 'name', dir: 'asc' }], 100),
                                        columns: [
                                            { key: 'name', label: 'Sub-processor', format: 'text', width: 220, sortable: true, filterable: true, editable: true },
                                            { key: 'service', label: 'Service', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'country', label: 'Country', format: 'text', width: 140, sortable: true, filterable: true, editable: true },
                                            { key: 'disclosed_on', label: 'Disclosed', format: 'date', width: 130, sortable: true, filterable: false, editable: true },
                                            { key: 'notes', label: 'Notes', format: 'text', width: 240, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 10,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Remove', actionId: 'act_delsub' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'Pick a processor on the left. Article 28(2): they must tell you who they use.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_subsave',
                                },
                                {
                                    // Hidden until a processor is picked. The write
                                    // below reads `vars.processor.id`, and with
                                    // nothing selected it would store a row whose
                                    // processor is NULL — which every read of this
                                    // table scopes away, so the toast would say
                                    // "recorded" about something nobody can ever
                                    // see again.
                                    id: 'cmp_prsubf',
                                    type: 'form',
                                    props: { name: 'newsub', submitLabel: 'Add sub-processor', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    visibleWhen: { kind: 'formula', expr: 'vars.processor.id' },
                                    onSubmit: 'act_newsub',
                                    children: [
                                        { id: 'cmp_prs01', type: 'input_text', props: { name: 'name', label: 'Sub-processor', required: true, inputType: 'text' }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_prs02', type: 'input_text', props: { name: 'service', label: 'Service', required: false, inputType: 'text' }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_prs03', type: 'input_text', props: { name: 'country', label: 'Country', required: false, inputType: 'text' }, style: { span: 2 }, visible: true },
                                        { id: 'cmp_prs04', type: 'input_date', props: { name: 'disclosed_on', label: 'Disclosed on', required: false, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 2 }, visible: true },
                                        { id: 'cmp_prs05', type: 'input_text', props: { name: 'notes', label: 'Notes', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                        {
                            id: 'cmp_prtb3',
                            type: 'tab',
                            props: { label: 'Used by', icon: 'ClipboardList' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    // Read-only on purpose: the link is owned by
                                    // the register entry that depends on it, and
                                    // this side has no join to walk back through.
                                    id: 'cmp_prused',
                                    type: 'data_grid',
                                    props: {
                                        source: forOpenProcessor('tbl_aproc1', [{ field: 'activity_name', dir: 'asc' }], 200),
                                        columns: [
                                            { key: 'activity_name', label: 'Processing activity', format: 'text', width: 280, sortable: true, filterable: true, editable: false },
                                            { key: 'role', label: 'Role', format: 'text', width: 200, sortable: false, filterable: false, editable: false },
                                            { key: 'dpa_status', label: 'DPA at linking', format: 'badge', width: 150, sortable: true, filterable: true, editable: false },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'Pick a processor on the left to see which register entries depend on it.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_prdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_procmodal',
                    type: 'modal',
                    props: { title: 'New processor', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_procform',
                            type: 'form',
                            props: { name: 'newprocessor', submitLabel: 'Add processor', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_procsav2',
                            children: [
                                { id: 'cmp_prf01', type: 'input_text', props: { name: 'name', label: 'Processor', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_prf02', type: 'input_text', props: { name: 'service', label: 'What they do for you', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_prf03', type: 'input_text', props: { name: 'contact_email', label: 'Contact', required: false, inputType: 'email' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_prf04', type: 'input_text', props: { name: 'country', label: 'Country', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_prf05', type: 'input_select', props: { name: 'dpa_status', label: 'Data processing agreement', required: true, options: DPA_OPTIONS, defaultValue: 'none', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_prf06', type: 'input_date', props: { name: 'dpa_signed_on', label: 'Signed on', required: false, defaultValue: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_prf07', type: 'input_text', props: { name: 'dpa_reference', label: 'Reference', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_prf08', type: 'input_text', props: { name: 'notes', label: 'Notes', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// TRANSFERS — Chapter V. The Schrems II question, in a column.
// ==================================================================
const SCREEN_TRANSFERS = {
    id: 'scr_transfer',
    name: 'Transfers',
    icon: 'ExternalLink',
    showInNav: true,
    maxWidth: 'full',
    description: 'Where personal data leaves the EEA, and on what safeguard.',
    sections: [
        {
            id: 'sec_trtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_trhdr',
                    type: 'page_header',
                    props: {
                        look: 'split',
                        title: 'Third-country transfers',
                        subtitle: 'Chapter V GDPR — every transfer outside the EEA and the safeguard it relies on: an adequacy decision, standard contractual clauses, binding corporate rules or a derogation.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'ExternalLink',
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
                        title: 'Clauses alone are not the answer',
                        text: 'Since Schrems II, standard contractual clauses only hold up when somebody has assessed the destination country as well. The "TIA done" column is that assessment; a transfer on clauses with the box empty is the gap a supervisory authority asks about first. Transfers are added from the entry they belong to, so every row here names its processing activity.',
                        tone: 'warning',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_trmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_trgrid',
                    type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_trans1', sort: [{ field: 'country', dir: 'asc' }], limit: 300 },
                        columns: [
                            { key: 'activity_name', label: 'Processing activity', format: 'text', width: 230, sortable: true, filterable: true, editable: false },
                            { key: 'recipient', label: 'Recipient', format: 'text', width: 200, sortable: true, filterable: true, editable: false },
                            { key: 'country', label: 'Country', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                            { key: 'safeguard', label: 'Safeguard', format: 'badge', width: 180, sortable: true, filterable: true, editable: true },
                            { key: 'safeguard_reference', label: 'Reference', format: 'text', width: 220, sortable: false, filterable: false, editable: true },
                            { key: 'tia_done', label: 'TIA done', format: 'boolean', width: 110, sortable: true, filterable: true, editable: true },
                            { key: 'assessed_on', label: 'Assessed', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                            { key: 'notes', label: 'Notes', format: 'text', width: 240, sortable: false, filterable: false, editable: true },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [],
                        look: 'minimal',
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No transfers outside the EEA recorded. Add them from the entry that transfers.',
                    },
                    style: { span: 8, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_trsave',
                },
                {
                    id: 'cmp_trchart',
                    type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_trans1',
                            groupBy: [{ field: 'safeguard', as: 'safeguard' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'transfers' }],
                            limit: 20,
                        },
                        title: 'Transfers by safeguard',
                        xKey: 'safeguard',
                        series: [{ key: 'transfers', label: 'Transfers', color: 'primary' }],
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
// DPIA — Art. 35 triage. What has not been screened, and what is running.
// ==================================================================
const SCREEN_DPIA = {
    id: 'scr_dpia',
    name: 'DPIA',
    icon: 'ShieldCheck',
    showInNav: true,
    maxWidth: 'full',
    description: 'Which activities need an impact assessment, and where each stands.',
    sections: [
        {
            id: 'sec_dptop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_dphdr',
                    type: 'page_header',
                    props: {
                        look: 'split',
                        title: 'Data protection impact assessments',
                        subtitle: 'Article 35 — screen every entry, assess the ones that need it, and record the outcome. The queue is everything nobody has decided about yet, worst risk first.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'ShieldCheck',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_dpst1',
                    type: 'stat',
                    props: {
                        label: 'Not screened',
                        value: activityCount([{ field: 'dpia_status', op: 'eq', value: 'not_assessed' }]),
                        caption: 'entries with no Article 35 decision',
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
                    id: 'cmp_dpst2',
                    type: 'stat',
                    props: {
                        label: 'Assessments running',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_dpia01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'status', op: 'neq', value: 'done' }],
                            limit: 1,
                        },
                        caption: 'not yet completed',
                        icon: 'Timer',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 4 },
                    visible: true,
                },
                {
                    id: 'cmp_dpst3',
                    type: 'stat',
                    props: {
                        label: 'Completed',
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_dpia01',
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'status', op: 'eq', value: 'done' }],
                            limit: 1,
                        },
                        caption: 'assessments on file',
                        icon: 'CheckCircle2',
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
            id: 'sec_dpmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    // The screening queue. It filters on the DECISION, not on the
                    // risk: Art. 35(3)'s triggers are broader than any one column,
                    // so the app refuses to pre-judge and instead insists that
                    // somebody says "required" or "not required" about each entry.
                    id: 'cmp_dpque',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_act001',
                            filter: [
                                { field: 'status', op: 'eq', value: 'active' },
                                { field: 'dpia_status', op: 'eq', value: 'not_assessed' },
                            ],
                            sort: [{ field: 'risk_tier', dir: 'asc' }],
                            limit: 100,
                        },
                        columns: [
                            { key: 'name', label: 'Awaiting screening', format: 'text', width: 230, sortable: true, filterable: true, editable: false },
                            { key: 'risk_tier', label: 'Risk', format: 'badge', width: 110, sortable: true, filterable: true, editable: false },
                            { key: 'special_category', label: 'Art. 9', format: 'badge', width: 130, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [
                            { label: 'Start a DPIA', actionId: 'act_startdpia' },
                            { label: 'Not required', actionId: 'act_nodpia' },
                        ],
                        look: 'minimal',
                        density: 'compact',
                        zebra: true,
                        emptyText: 'Every active entry has been screened.',
                    },
                    style: { span: 5, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_dpgrid',
                    type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_dpia01', sort: [{ field: 'started_on', dir: 'desc' }], limit: 200 },
                        columns: [
                            { key: 'activity_name', label: 'Processing activity', format: 'text', width: 220, sortable: true, filterable: true, editable: false },
                            { key: 'title', label: 'Assessment', format: 'text', width: 220, sortable: false, filterable: false, editable: false },
                            { key: 'status', label: 'Phase', format: 'badge', width: 170, sortable: true, filterable: true, editable: true },
                            { key: 'outcome', label: 'Outcome', format: 'badge', width: 190, sortable: true, filterable: true, editable: true },
                            { key: 'residual_risk', label: 'Residual risk', format: 'badge', width: 140, sortable: true, filterable: true, editable: true },
                            { key: 'owner_name', label: 'Owner', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                            { key: 'completed_on', label: 'Completed', format: 'date', width: 130, sortable: true, filterable: false, editable: true },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        // Deliberately no "open the entry" action: this row
                        // carries its activity's ID, not its ROW, and there is
                        // no join to fetch one from the other without routing a
                        // formula over `item` through a filter — which would
                        // split the fetch layer's cache key from the read side
                        // and hang the component. The entry name is right here
                        // instead, and the register finds it in one search.
                        rowActions: [],
                        look: 'minimal',
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No impact assessments started yet.',
                    },
                    style: { span: 7, height: 'fill' },
                    visible: true,
                    onRowSelect: 'act_dpiasave',
                },
            ],
        },
    ],
};

// ==================================================================
// VOCABULARIES — the config tables, edited by the DPO, live.
// ==================================================================
const SCREEN_SETUP = {
    id: 'scr_setup',
    name: 'Vocabularies',
    icon: 'TableProperties',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Legal bases, data categories and departments.',
    sections: [
        {
            id: 'sec_sutop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_suhdr',
                    type: 'page_header',
                    props: {
                        look: 'split',
                        title: 'Vocabularies',
                        subtitle: 'Legal bases, data categories and departments are data, not schema — the DPO edits them here and the register follows, with no developer and no deploy.',
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
                        text: 'The register grid, the detail panel and the data-category picker read these tables live, so a basis or category you add here appears immediately. The dropdowns in the New-entry and Edit forms are fixed lists in the app definition: a new legal basis shows up everywhere except those two menus until an editor adds it there as well.',
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
                            id: 'cmp_sutb1',
                            type: 'tab',
                            props: { label: 'Legal bases', icon: 'BookOpen' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sulb',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_lbase1', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            // The key is what activities STORE.
                                            // Not editable: renaming it here would
                                            // orphan every entry that points at it.
                                            { key: 'key', label: 'Key', format: 'text', width: 180, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Name', format: 'text', width: 220, sortable: false, filterable: false, editable: true },
                                            { key: 'article_ref', label: 'Article', format: 'text', width: 160, sortable: false, filterable: false, editable: true },
                                            { key: 'needs_balancing', label: 'Needs a balancing test', format: 'boolean', width: 180, sortable: false, filterable: false, editable: true },
                                            { key: 'description', label: 'Description', format: 'text', width: 300, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No legal bases configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_lbsave',
                                },
                                {
                                    id: 'cmp_sulbf',
                                    type: 'form',
                                    props: { name: 'newbasis', submitLabel: 'Add legal basis', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_lbnew',
                                    children: [
                                        { id: 'cmp_sulb1', type: 'input_text', props: { name: 'key', label: 'Key', required: true, inputType: 'text', placeholder: 'public_task' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sulb2', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sulb3', type: 'input_text', props: { name: 'article_ref', label: 'Article', required: true, inputType: 'text', placeholder: 'Art. 6(1)(e) GDPR' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sulb4', type: 'input_text', props: { name: 'description', label: 'Description', required: false, inputType: 'text' }, style: { span: 3 }, visible: true },
                                    ],
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutb2',
                            type: 'tab',
                            props: { label: 'Data categories', icon: 'Tags' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sudc',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_dcat01', sort: [{ field: 'position', dir: 'asc' }], limit: 60 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 170, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Name', format: 'text', width: 220, sortable: false, filterable: false, editable: true },
                                            { key: 'is_special', label: 'Article 9', format: 'boolean', width: 120, sortable: true, filterable: true, editable: true },
                                            { key: 'article_ref', label: 'Article', format: 'text', width: 150, sortable: false, filterable: false, editable: true },
                                            { key: 'examples', label: 'Examples', format: 'text', width: 300, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No data categories configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_dcsave',
                                },
                                {
                                    id: 'cmp_sudcf',
                                    type: 'form',
                                    props: { name: 'newcategory', submitLabel: 'Add data category', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_dcnew',
                                    children: [
                                        { id: 'cmp_sudc1', type: 'input_text', props: { name: 'key', label: 'Key', required: true, inputType: 'text', placeholder: 'health' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sudc2', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sudc3', type: 'input_text', props: { name: 'article_ref', label: 'Article', required: false, inputType: 'text' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sudc4', type: 'input_text', props: { name: 'examples', label: 'Examples', required: false, inputType: 'text' }, style: { span: 3 }, visible: true },
                                    ],
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutb3',
                            type: 'tab',
                            props: { label: 'Departments', icon: 'Building2' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sudp',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_dept01', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Name', format: 'text', width: 240, sortable: false, filterable: false, editable: true },
                                            { key: 'owner_name', label: 'Owner', format: 'text', width: 200, sortable: false, filterable: false, editable: true },
                                            { key: 'owner_email', label: 'Owner e-mail', format: 'text', width: 240, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No departments configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_deptsave',
                                },
                                {
                                    id: 'cmp_sudpf',
                                    type: 'form',
                                    props: { name: 'newdept', submitLabel: 'Add department', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_deptnew',
                                    children: [
                                        { id: 'cmp_sudp1', type: 'input_text', props: { name: 'key', label: 'Key', required: true, inputType: 'text', placeholder: 'facilities' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sudp2', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sudp3', type: 'input_text', props: { name: 'owner_name', label: 'Owner', required: false, inputType: 'text' }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_sudp4', type: 'input_text', props: { name: 'owner_email', label: 'Owner e-mail', required: false, inputType: 'email' }, style: { span: 3 }, visible: true },
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

/**
 * ── THE LOGIC BEHIND THE CONTROLS ──────────────────────────────────────────
 *
 * Three rules run through all of it.
 *
 * WHERE CONTEXT COMES FROM. A server step sees `form`, `vars`, `item`, `value`,
 * `currentUser`, `now` and `today` — and NOT `screen`, `forms`, `actions` or
 * `records`. So a write reads the submitted form, the clicked row (`item`), or
 * the selection variable. Nothing reads `screen.params`: it resolves in preview
 * and writes NULL in production, which is the worst kind of wrong.
 *
 * WHY EVERY MUTATION ENDS IN `refresh`. Nothing invalidates a bound query after
 * a write. Without it a recorded review leaves the old date on screen — and on
 * this app, of all apps, a stale review date is the exact lie it exists to
 * prevent. Each `refresh` names the table it dirtied.
 *
 * WHY `lia_status` IS COMPUTED IN TWO PLACES AND NOWHERE ELSE. Exactly two
 * actions write `legal_basis` — creating an entry and editing one — and both
 * derive the status from the basis plus whether a balancing test was written
 * down, with the same expression. Any third writer would be able to leave an
 * entry on legitimate interests reading "not applicable", which is a clean bill
 * of health nobody issued. The test file asserts there is no third writer.
 */

/** legitimate interests + nothing written down = the finding. */
const LIA_RULE = "form.legal_basis == 'legitimate_interests' ? (isEmpty(form.lia_summary) ? 'missing' : 'recorded') : 'not_required'";

/**
 * The statutory deadline, measured from the date the review ACTUALLY happened.
 * `dateAdd` has no month unit, so the interval is days; `formatDate` trims the
 * ISO timestamp back to the date-only string a `date` column stores.
 */
const NEXT_REVIEW_FROM_FORM = "formatDate(dateAdd(form.reviewed_on, form.review_interval_days, 'day'), 'YYYY-MM-DD')";
const NEXT_REVIEW_FROM_TODAY = "formatDate(dateAdd(today, form.review_interval_days, 'day'), 'YYYY-MM-DD')";

const actions = {
    // ── The register ───────────────────────────────────────────────────────

    /**
     * Open an entry. `item` is the clicked row — from the findings lists, the
     * register grid, the calendar or the overdue grid, all of which are bound
     * to the activities table, so the payload is always an activity.
     *
     * Only the id is used afterwards (see the module header); the rest of the
     * row rides along so the selection reads sensibly in the editor's inspector.
     */
    act_pickact: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'activity', value: { kind: 'formula', expr: 'item' } },
            { kind: 'navigate', screenId: 'scr_activity' },
        ],
    },

    act_backreg: { kind: 'navigate', screenId: 'scr_register' },

    act_newopen: { kind: 'open_modal', modalId: 'cmp_newmodal' },

    act_newsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_act001',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    purpose: { kind: 'formula', expr: 'form.purpose' },
                    department: { kind: 'formula', expr: 'form.department' },
                    controller_name: { kind: 'formula', expr: 'form.controller_name' },
                    legal_basis: { kind: 'formula', expr: 'form.legal_basis' },
                    lia_summary: { kind: 'formula', expr: 'form.lia_summary' },
                    lia_status: { kind: 'formula', expr: LIA_RULE },
                    data_subjects: { kind: 'formula', expr: 'form.data_subjects' },
                    special_category: { kind: 'formula', expr: 'form.special_category' },
                    risk_tier: { kind: 'formula', expr: 'form.risk_tier' },
                    retention_period: { kind: 'formula', expr: 'form.retention_period' },
                    retention_basis: { kind: 'formula', expr: 'form.retention_basis' },
                    reviewer_name: { kind: 'formula', expr: 'form.reviewer_name' },
                    reviewer_email: { kind: 'formula', expr: 'form.reviewer_email' },
                    review_interval_days: { kind: 'formula', expr: 'form.review_interval_days' },
                    // Recording the entry IS the first review of it, so the
                    // clock starts today rather than leaving the deadline empty
                    // — an entry with no next_review_date is invisible to the
                    // overdue query forever.
                    last_reviewed: { kind: 'formula', expr: 'today' },
                    next_review_date: { kind: 'formula', expr: NEXT_REVIEW_FROM_TODAY },
                    status: { kind: 'static', value: 'active' },
                    dpia_status: { kind: 'static', value: 'not_assessed' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_newmodal' },
            { kind: 'reset_form', form: 'newactivity' },
            { kind: 'refresh', tableId: 'tbl_act001' },
            { kind: 'toast', message: 'Added to the register. Open it to record its processors, transfers and categories.', tone: 'success' },
        ],
    },

    // ── One entry ──────────────────────────────────────────────────────────

    act_editopen: { kind: 'open_modal', modalId: 'cmp_editmodal' },

    /** The second and last place `lia_status` is derived. See LIA_RULE. */
    act_editsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'vars.activity.id' },
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    purpose: { kind: 'formula', expr: 'form.purpose' },
                    department: { kind: 'formula', expr: 'form.department' },
                    controller_name: { kind: 'formula', expr: 'form.controller_name' },
                    joint_controller: { kind: 'formula', expr: 'form.joint_controller' },
                    legal_basis: { kind: 'formula', expr: 'form.legal_basis' },
                    lia_summary: { kind: 'formula', expr: 'form.lia_summary' },
                    lia_status: { kind: 'formula', expr: LIA_RULE },
                    data_subjects: { kind: 'formula', expr: 'form.data_subjects' },
                    retention_period: { kind: 'formula', expr: 'form.retention_period' },
                    retention_basis: { kind: 'formula', expr: 'form.retention_basis' },
                    systems: { kind: 'formula', expr: 'form.systems' },
                    security_measures: { kind: 'formula', expr: 'form.security_measures' },
                    reviewer_name: { kind: 'formula', expr: 'form.reviewer_name' },
                    reviewer_email: { kind: 'formula', expr: 'form.reviewer_email' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_editmodal' },
            { kind: 'refresh', tableId: 'tbl_act001' },
            { kind: 'toast', message: 'Entry updated.', tone: 'success' },
        ],
    },

    act_revopen: { kind: 'open_modal', modalId: 'cmp_revmodal' },

    /**
     * The review. Two writes, and the log is the point of it: the activity row
     * says where the register stands NOW, the log says how it got there — and
     * nobody, not even the DPO, may edit or delete the log afterwards.
     */
    act_revsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'vars.activity.id' },
                values: {
                    last_reviewed: { kind: 'formula', expr: 'form.reviewed_on' },
                    review_interval_days: { kind: 'formula', expr: 'form.review_interval_days' },
                    next_review_date: { kind: 'formula', expr: NEXT_REVIEW_FROM_FORM },
                    reviewer_name: { kind: 'formula', expr: 'form.reviewer_name' },
                },
            },
            {
                kind: 'create_record',
                tableId: 'tbl_rlog01',
                values: {
                    activity_id: { kind: 'formula', expr: 'vars.activity.id' },
                    activity_name: { kind: 'formula', expr: 'vars.activity.name' },
                    reviewer_name: { kind: 'formula', expr: 'form.reviewer_name' },
                    reviewed_on: { kind: 'formula', expr: 'form.reviewed_on' },
                    // The SAME arithmetic as the activity write above, so the
                    // log can be read on its own — an auditor reconstructing the
                    // cadence never has to trust the current row.
                    next_review_date: { kind: 'formula', expr: NEXT_REVIEW_FROM_FORM },
                    kind: { kind: 'formula', expr: 'form.kind' },
                    note: { kind: 'formula', expr: 'form.note' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_revmodal' },
            { kind: 'reset_form', form: 'reviewactivity' },
            { kind: 'refresh', tableId: 'tbl_act001' },
            { kind: 'refresh', tableId: 'tbl_rlog01' },
            { kind: 'toast', message: 'Review recorded. The next deadline has moved.', tone: 'success' },
        ],
    },

    // ── The triage bar. One column each, on purpose (see the screen). ──────

    act_setstat: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'vars.activity.id' },
                values: { status: { kind: 'formula', expr: 'form.status' } },
            },
            { kind: 'refresh', tableId: 'tbl_act001' },
        ],
    },

    act_setrisk: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'vars.activity.id' },
                values: { risk_tier: { kind: 'formula', expr: 'form.risk_tier' } },
            },
            { kind: 'refresh', tableId: 'tbl_act001' },
        ],
    },

    act_setspec: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'vars.activity.id' },
                values: { special_category: { kind: 'formula', expr: 'form.special_category' } },
            },
            { kind: 'refresh', tableId: 'tbl_act001' },
        ],
    },

    act_setdpia: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'vars.activity.id' },
                values: { dpia_status: { kind: 'formula', expr: 'form.dpia_status' } },
            },
            { kind: 'refresh', tableId: 'tbl_act001' },
        ],
    },

    // ── Processors on an entry ─────────────────────────────────────────────

    /**
     * Linking. `item` is the processor row that was clicked and `vars.activity`
     * is the open entry, so this is the ONE moment both sides are in scope —
     * which is exactly why the display copies are written here. There are no
     * joins, so a name the engagement row does not carry cannot be shown.
     */
    act_link: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_aproc1',
                values: {
                    activity_id: { kind: 'formula', expr: 'vars.activity.id' },
                    activity_name: { kind: 'formula', expr: 'vars.activity.name' },
                    processor_id: { kind: 'formula', expr: 'item.id' },
                    processor_name: { kind: 'formula', expr: 'item.name' },
                    dpa_status: { kind: 'formula', expr: 'item.dpa_status' },
                    role: { kind: 'static', value: 'Processor (Art. 28)' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_aproc1' },
            { kind: 'toast', message: 'Processor linked to this entry.', tone: 'success' },
        ],
    },

    act_unlink: {
        kind: 'sequence',
        steps: [
            { kind: 'delete_record', tableId: 'tbl_aproc1', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_aproc1' },
        ],
    },

    // ── Transfers on an entry ──────────────────────────────────────────────

    act_savetr: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_trans1',
                values: {
                    activity_id: { kind: 'formula', expr: 'vars.activity.id' },
                    activity_name: { kind: 'formula', expr: 'vars.activity.name' },
                    recipient: { kind: 'formula', expr: 'form.recipient' },
                    country: { kind: 'formula', expr: 'form.country' },
                    safeguard: { kind: 'formula', expr: 'form.safeguard' },
                    safeguard_reference: { kind: 'formula', expr: 'form.safeguard_reference' },
                    tia_done: { kind: 'formula', expr: 'form.tia_done' },
                    assessed_on: { kind: 'formula', expr: 'form.assessed_on' },
                    notes: { kind: 'formula', expr: 'form.notes' },
                },
            },
            { kind: 'reset_form', form: 'newtransfer' },
            { kind: 'refresh', tableId: 'tbl_trans1' },
            { kind: 'toast', message: 'Transfer recorded.', tone: 'success' },
        ],
    },

    act_deltr: {
        kind: 'sequence',
        steps: [
            { kind: 'delete_record', tableId: 'tbl_trans1', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_trans1' },
        ],
    },

    /** The Chapter V screen's inline edits — the safeguard and the assessment. */
    act_trsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_trans1',
                recordId: { kind: 'formula', expr: 'form.id' },
                // Compare-and-set: refuse the write when somebody changed the
                // row since this grid loaded it, rather than overwriting them.
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    safeguard: { kind: 'formula', expr: 'form.safeguard' },
                    safeguard_reference: { kind: 'formula', expr: 'form.safeguard_reference' },
                    tia_done: { kind: 'formula', expr: 'form.tia_done' },
                    assessed_on: { kind: 'formula', expr: 'form.assessed_on' },
                    notes: { kind: 'formula', expr: 'form.notes' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_trans1' },
        ],
    },

    // ── Data categories on an entry ────────────────────────────────────────

    /**
     * Linking an Art. 9 category PROMOTES the entry's declaration to "present".
     * The condition runs client-side, where the clicked vocabulary row is in
     * scope; the write inside it reads only the selection and a literal.
     *
     * The reverse is deliberately absent — removing the last special category
     * does not demote the declaration. Art. 30 asks the controller to say what
     * it processes, and quietly answering "no" on their behalf is not the
     * app's call to make.
     */
    act_addcat: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_acat01',
                values: {
                    activity_id: { kind: 'formula', expr: 'vars.activity.id' },
                    activity_name: { kind: 'formula', expr: 'vars.activity.name' },
                    category_key: { kind: 'formula', expr: 'item.key' },
                    category_name: { kind: 'formula', expr: 'item.name' },
                    is_special: { kind: 'formula', expr: 'item.is_special' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_acat01' },
            {
                kind: 'condition',
                expr: 'item.is_special',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_act001',
                        recordId: { kind: 'formula', expr: 'vars.activity.id' },
                        values: { special_category: { kind: 'static', value: 'present' } },
                    },
                    { kind: 'refresh', tableId: 'tbl_act001' },
                    { kind: 'toast', message: 'Special-category data (Art. 9) — this entry is now declared as such.', tone: 'warning' },
                ],
            },
        ],
    },

    act_delcat: {
        kind: 'sequence',
        steps: [
            { kind: 'delete_record', tableId: 'tbl_acat01', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_acat01' },
        ],
    },

    // ── DPIA ───────────────────────────────────────────────────────────────

    /** From the triage queue: `item` is the activity awaiting screening. */
    act_startdpia: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_dpia01',
                values: {
                    activity_id: { kind: 'formula', expr: 'item.id' },
                    activity_name: { kind: 'formula', expr: 'item.name' },
                    title: { kind: 'formula', expr: "concat('DPIA — ', item.name)" },
                    status: { kind: 'static', value: 'screening' },
                    outcome: { kind: 'static', value: 'pending' },
                    // The register's tier is the assessment's STARTING residual
                    // risk, which is why both use the same three values.
                    residual_risk: { kind: 'formula', expr: 'item.risk_tier' },
                    started_on: { kind: 'formula', expr: 'today' },
                    owner_name: { kind: 'formula', expr: 'currentUser.name' },
                },
            },
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: { dpia_status: { kind: 'static', value: 'in_progress' } },
            },
            { kind: 'refresh', tableId: 'tbl_dpia01' },
            { kind: 'refresh', tableId: 'tbl_act001' },
            { kind: 'toast', message: 'Assessment started, and the entry now says so.', tone: 'success' },
        ],
    },

    /** The other half of screening: a decision that no DPIA is needed. */
    act_nodpia: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: { dpia_status: { kind: 'static', value: 'not_needed' } },
            },
            { kind: 'refresh', tableId: 'tbl_act001' },
            { kind: 'toast', message: 'Screened: no impact assessment required.', tone: 'info' },
        ],
    },

    /** The same thing from the entry itself, where there is no clicked row. */
    act_dpiahere: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_dpia01',
                values: {
                    activity_id: { kind: 'formula', expr: 'vars.activity.id' },
                    activity_name: { kind: 'formula', expr: 'vars.activity.name' },
                    title: { kind: 'formula', expr: "concat('DPIA — ', vars.activity.name)" },
                    status: { kind: 'static', value: 'screening' },
                    outcome: { kind: 'static', value: 'pending' },
                    residual_risk: { kind: 'formula', expr: 'vars.activity.risk_tier' },
                    started_on: { kind: 'formula', expr: 'today' },
                    owner_name: { kind: 'formula', expr: 'currentUser.name' },
                },
            },
            {
                kind: 'update_record',
                tableId: 'tbl_act001',
                recordId: { kind: 'formula', expr: 'vars.activity.id' },
                values: { dpia_status: { kind: 'static', value: 'in_progress' } },
            },
            { kind: 'refresh', tableId: 'tbl_dpia01' },
            { kind: 'refresh', tableId: 'tbl_act001' },
            { kind: 'toast', message: 'Assessment started for this entry.', tone: 'success' },
        ],
    },

    act_dpiasave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_dpia01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    status: { kind: 'formula', expr: 'form.status' },
                    outcome: { kind: 'formula', expr: 'form.outcome' },
                    residual_risk: { kind: 'formula', expr: 'form.residual_risk' },
                    completed_on: { kind: 'formula', expr: 'form.completed_on' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_dpia01' },
        ],
    },

    // ── Processors screen ──────────────────────────────────────────────────

    act_pickproc: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'processor', value: { kind: 'formula', expr: 'item' } }],
    },

    act_procopen: { kind: 'open_modal', modalId: 'cmp_procmodal' },

    act_procsav2: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_proc01',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    service: { kind: 'formula', expr: 'form.service' },
                    contact_email: { kind: 'formula', expr: 'form.contact_email' },
                    country: { kind: 'formula', expr: 'form.country' },
                    dpa_status: { kind: 'formula', expr: 'form.dpa_status' },
                    dpa_signed_on: { kind: 'formula', expr: 'form.dpa_signed_on' },
                    dpa_reference: { kind: 'formula', expr: 'form.dpa_reference' },
                    notes: { kind: 'formula', expr: 'form.notes' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_procmodal' },
            { kind: 'reset_form', form: 'newprocessor' },
            { kind: 'refresh', tableId: 'tbl_proc01' },
            { kind: 'toast', message: 'Processor added.', tone: 'success' },
        ],
    },

    act_procsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_proc01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    service: { kind: 'formula', expr: 'form.service' },
                    country: { kind: 'formula', expr: 'form.country' },
                    dpa_status: { kind: 'formula', expr: 'form.dpa_status' },
                    dpa_signed_on: { kind: 'formula', expr: 'form.dpa_signed_on' },
                    dpa_reference: { kind: 'formula', expr: 'form.dpa_reference' },
                    last_audited: { kind: 'formula', expr: 'form.last_audited' },
                    contact_email: { kind: 'formula', expr: 'form.contact_email' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_proc01' },
        ],
    },

    act_newsub: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_subp01',
                values: {
                    processor_id: { kind: 'formula', expr: 'vars.processor.id' },
                    processor_name: { kind: 'formula', expr: 'vars.processor.name' },
                    name: { kind: 'formula', expr: 'form.name' },
                    service: { kind: 'formula', expr: 'form.service' },
                    country: { kind: 'formula', expr: 'form.country' },
                    disclosed_on: { kind: 'formula', expr: 'form.disclosed_on' },
                    notes: { kind: 'formula', expr: 'form.notes' },
                },
            },
            { kind: 'reset_form', form: 'newsub' },
            { kind: 'refresh', tableId: 'tbl_subp01' },
            { kind: 'toast', message: 'Sub-processor recorded.', tone: 'success' },
        ],
    },

    act_subsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_subp01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    service: { kind: 'formula', expr: 'form.service' },
                    country: { kind: 'formula', expr: 'form.country' },
                    disclosed_on: { kind: 'formula', expr: 'form.disclosed_on' },
                    notes: { kind: 'formula', expr: 'form.notes' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_subp01' },
        ],
    },

    act_delsub: {
        kind: 'sequence',
        steps: [
            { kind: 'delete_record', tableId: 'tbl_subp01', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_subp01' },
        ],
    },

    /**
     * The one thing this app asks of the outside world. `automationId: null` is
     * legal and is the only warning the template carries — the Reviews screen
     * says so in plain language rather than shipping a button that lies.
     */
    act_remind: {
        kind: 'sequence',
        steps: [
            { kind: 'run_automation', automationId: null },
            { kind: 'toast', message: 'Reminder automation started. If nothing happened, no automation is wired to this button yet — see the note above.', tone: 'info' },
        ],
    },

    // ── Vocabularies ───────────────────────────────────────────────────────

    act_lbsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_lbase1',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    article_ref: { kind: 'formula', expr: 'form.article_ref' },
                    needs_balancing: { kind: 'formula', expr: 'form.needs_balancing' },
                    description: { kind: 'formula', expr: 'form.description' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_lbase1' },
        ],
    },

    act_lbnew: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_lbase1',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    article_ref: { kind: 'formula', expr: 'form.article_ref' },
                    description: { kind: 'formula', expr: 'form.description' },
                    position: { kind: 'static', value: 99 },
                },
            },
            { kind: 'reset_form', form: 'newbasis' },
            { kind: 'refresh', tableId: 'tbl_lbase1' },
            { kind: 'toast', message: 'Legal basis added. Remember it will not appear in the New-entry dropdown until an editor adds it there too.', tone: 'info' },
        ],
    },

    act_dcsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_dcat01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    is_special: { kind: 'formula', expr: 'form.is_special' },
                    article_ref: { kind: 'formula', expr: 'form.article_ref' },
                    examples: { kind: 'formula', expr: 'form.examples' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_dcat01' },
        ],
    },

    act_dcnew: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_dcat01',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    article_ref: { kind: 'formula', expr: 'form.article_ref' },
                    examples: { kind: 'formula', expr: 'form.examples' },
                    position: { kind: 'static', value: 99 },
                },
            },
            { kind: 'reset_form', form: 'newcategory' },
            { kind: 'refresh', tableId: 'tbl_dcat01' },
            { kind: 'toast', message: 'Data category added. Tick Article 9 in the grid if it is a special category.', tone: 'info' },
        ],
    },

    act_deptsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_dept01',
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    owner_name: { kind: 'formula', expr: 'form.owner_name' },
                    owner_email: { kind: 'formula', expr: 'form.owner_email' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_dept01' },
        ],
    },

    act_deptnew: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_dept01',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    owner_name: { kind: 'formula', expr: 'form.owner_name' },
                    owner_email: { kind: 'formula', expr: 'form.owner_email' },
                    position: { kind: 'static', value: 99 },
                },
            },
            { kind: 'reset_form', form: 'newdept' },
            { kind: 'refresh', tableId: 'tbl_dept01' },
            { kind: 'toast', message: 'Department added.', tone: 'success' },
        ],
    },
};

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'Processing register',
        description: 'The Article 30 record of processing activities, with its processors, transfers, DPIAs and review cycle.',
        icon: 'ClipboardList',
    },
    theme: { primary: '#57534E', ...THEME_DEFAULTS },
    // Identity: "classic" provenance in a stone grey with Satoshi — the sober,
    // archival document register. Split headers, minimal grids and panel form
    // bands do the differentiating; the primary stays deliberately quiet.
    design: { preset: 'classic', font: 'satoshi', surface: 'hairline', motion: 'subtle', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
    nav: {
        style: 'sidebar',
        groups: [
            { id: 'nvg_register', label: 'Register', icon: 'ClipboardList', screens: ['scr_register', 'scr_reviews'] },
            { id: 'nvg_suppliers', label: 'Suppliers', icon: 'Handshake', screens: ['scr_procs', 'scr_transfer'] },
            { id: 'nvg_assess', label: 'Assessments', icon: 'ShieldCheck', screens: ['scr_dpia'] },
            { id: 'nvg_setup', label: 'Setup', icon: 'Settings', screens: ['scr_setup'] },
        ],
    },
    roles: [
        { id: 'dpo', name: 'Data protection officer' },
        { id: 'steward', name: 'Process owner' },
        { id: 'auditor', name: 'Auditor (read-only)' },
    ],
    /**
     * `filters` is NOT declared — it is reserved, owned by filter_bar, which
     * republishes the whole object on every keystroke.
     *
     * Both variables hold a SELECTION. `activity` in particular is never
     * rendered from: the entry screen re-reads the row through `openActivity()`
     * so a recorded review shows immediately. See the module header.
     */
    variables: [
        { name: 'activity', label: 'Open register entry', type: 'record', default: null, description: 'The entry the detail screen is scoped to. Only its id is read; every value on screen comes from a live read of the row.' },
        { name: 'processor', label: 'Selected processor', type: 'record', default: null, description: 'Scopes the sub-processor and "used by" panels on the Processors screen.' },
    ],
    homeScreenId: 'scr_register',
    screens: [
        SCREEN_REGISTER,
        SCREEN_ACTIVITY,
        SCREEN_REVIEWS,
        SCREEN_PROCESSORS,
        SCREEN_TRANSFERS,
        SCREEN_DPIA,
        SCREEN_SETUP,
    ],
    actions,
};

// ---------------------------------------------------------------------------
// Seed
//
// A plainly fictional care organisation, "Zonnehof Zorggroep", with the twelve
// processing activities such a body actually has — personnel and payroll,
// electronic client records, medication, cameras, a newsletter, supplier
// administration. Fictional throughout, every address at example.com.
//
// The seed is built so the FIRST screen carries its two findings rather than
// looking clean by accident: three entries are past their review date, and two
// rely on legitimate interests with the balancing test left empty. One entry
// transfers to the United States on standard contractual clauses with no
// transfer impact assessment — the Schrems II gap, visible on the Transfers
// screen the moment the app opens.
//
// `$id` is a LOCAL alias, never a column; `{ $ref }` points at a row seeded
// EARLIER, and templateInstall rewrites those into real record ids.
//
// The review dates are internally consistent by construction:
// next_review_date = last_reviewed + review_interval_days, to the day, and the
// review log carries the same pair. The test file re-computes both.
// ---------------------------------------------------------------------------

const seed = {
    tbl_dept01: [
        { key: 'hr', name: 'People & Organisation', owner_name: 'Head of People', owner_email: 'people@example.com', position: 1 },
        { key: 'care', name: 'Care delivery', owner_name: 'Care manager', owner_email: 'care@example.com', position: 2 },
        { key: 'marketing', name: 'Marketing', owner_name: 'Marketing lead', owner_email: 'marketing@example.com', position: 3 },
        { key: 'ict', name: 'ICT', owner_name: 'ICT manager', owner_email: 'ict@example.com', position: 4 },
        { key: 'finance', name: 'Finance', owner_name: 'Financial controller', owner_email: 'finance@example.com', position: 5 },
        { key: 'facilities', name: 'Facilities', owner_name: 'Facilities coordinator', owner_email: 'facilities@example.com', position: 6 },
    ],

    tbl_lbase1: [
        { key: 'consent', name: 'Consent', article_ref: 'Art. 6(1)(a) GDPR', description: 'Freely given, specific, informed and unambiguous — and withdrawable at any time.', needs_balancing: false, position: 1 },
        { key: 'contract', name: 'Performance of a contract', article_ref: 'Art. 6(1)(b) GDPR', description: 'Necessary to perform a contract with the data subject, or to take steps before entering one.', needs_balancing: false, position: 2 },
        { key: 'legal_obligation', name: 'Legal obligation', article_ref: 'Art. 6(1)(c) GDPR', description: 'Required by Union or Member State law — name the law in the retention basis.', needs_balancing: false, position: 3 },
        { key: 'vital_interests', name: 'Vital interests', article_ref: 'Art. 6(1)(d) GDPR', description: 'Necessary to protect someone’s life. Narrow, and rarely the right answer for automation processing.', needs_balancing: false, position: 4 },
        { key: 'public_task', name: 'Public task', article_ref: 'Art. 6(1)(e) GDPR', description: 'Carried out in the public interest or in the exercise of official authority.', needs_balancing: false, position: 5 },
        // The only basis in the seeded vocabulary that demands a written
        // weighing — and the reason `lia_status` exists at all.
        { key: 'legitimate_interests', name: 'Legitimate interests', article_ref: 'Art. 6(1)(f) GDPR', description: 'Requires a documented balancing test: your interest, the necessity, and the data subject’s rights and expectations.', needs_balancing: true, position: 6 },
    ],

    tbl_dcat01: [
        { key: 'identification', name: 'Identification data', is_special: false, article_ref: 'Art. 4(1)', examples: 'Name, date of birth, client number, staff number.', position: 1 },
        { key: 'contact', name: 'Contact details', is_special: false, article_ref: 'Art. 4(1)', examples: 'Address, e-mail, telephone.', position: 2 },
        { key: 'financial', name: 'Financial data', is_special: false, article_ref: 'Art. 4(1)', examples: 'Bank account, salary, invoice lines.', position: 3 },
        { key: 'employment', name: 'Employment data', is_special: false, article_ref: 'Art. 4(1)', examples: 'Contract, role, hours, appraisals.', position: 4 },
        { key: 'health', name: 'Health data', is_special: true, article_ref: 'Art. 9(1)', examples: 'Diagnosis, care plan, medication, absence cause.', position: 5 },
        { key: 'biometric', name: 'Biometric data', is_special: true, article_ref: 'Art. 9(1)', examples: 'Fingerprint or face template used to identify someone.', position: 6 },
        { key: 'trade_union', name: 'Trade union membership', is_special: true, article_ref: 'Art. 9(1)', examples: 'Union deduction on a payslip.', position: 7 },
        { key: 'camera_images', name: 'Camera images', is_special: false, article_ref: 'Art. 4(1)', examples: 'Footage of people entering and leaving a building.', position: 8 },
        { key: 'location', name: 'Location data', is_special: false, article_ref: 'Art. 4(1)', examples: 'Approximate location derived from an IP address.', position: 9 },
        { key: 'usage_logs', name: 'Usage and access logs', is_special: false, article_ref: 'Art. 4(1)', examples: 'Who opened which record, and when.', position: 10 },
    ],

    tbl_proc01: [
        { $id: 'pr_pay', name: 'Meridiaan Payroll B.V.', service: 'Payroll processing and payslips', contact_email: 'privacy@meridiaan-payroll.example.com', country: 'Netherlands', dpa_status: 'signed', dpa_signed_on: '2024-04-08', dpa_reference: 'DPA-2024-011', last_audited: '2026-01-15', notes: 'Annual ISAE 3402 type II report received.' },
        { $id: 'pr_host', name: 'Kestrel Cloud Hosting GmbH', service: 'Application hosting for the client portal', contact_email: 'dpo@kestrel-hosting.example.com', country: 'Germany', dpa_status: 'signed', dpa_signed_on: '2023-11-02', dpa_reference: 'DPA-2023-047', last_audited: '2025-12-04', notes: 'EEA-only regions contractually fixed.' },
        { $id: 'pr_ana', name: 'Northwind Analytics Inc.', service: 'Website statistics', contact_email: 'privacy@northwind-analytics.example.com', country: 'United States', dpa_status: 'requested', dpa_reference: 'Draft sent 2026-05-19', notes: 'No signed agreement yet — chase before the next review.' },
        { $id: 'pr_ehr', name: 'Lumen Care Systems B.V.', service: 'Electronic client record system', contact_email: 'privacy@lumencare.example.com', country: 'Netherlands', dpa_status: 'signed', dpa_signed_on: '2024-09-30', dpa_reference: 'DPA-2024-029', last_audited: '2026-03-11', notes: 'NEN 7510 certified; support desk sits in the United Kingdom.' },
        { $id: 'pr_mail', name: 'Vestamail Campaigns Ltd', service: 'Newsletter delivery', contact_email: 'support@vestamail.example.com', country: 'Ireland', dpa_status: 'none', notes: 'Signed up before the register existed. No agreement on file at all.' },
    ],

    tbl_subp01: [
        { processor_id: { $ref: 'pr_host' }, processor_name: 'Kestrel Cloud Hosting GmbH', name: 'Basalt Datacenters B.V.', service: 'Physical hosting, Amsterdam', country: 'Netherlands', disclosed_on: '2023-11-02', notes: 'Named in annex 3 of the agreement.' },
        { processor_id: { $ref: 'pr_ehr' }, processor_name: 'Lumen Care Systems B.V.', name: 'Kestrel Cloud Hosting GmbH', service: 'Infrastructure', country: 'Germany', disclosed_on: '2024-09-30', notes: 'Also a direct processor of ours — the same supplier twice in the chain.' },
        { processor_id: { $ref: 'pr_ana' }, processor_name: 'Northwind Analytics Inc.', name: 'Cascade Storage LLC', service: 'Object storage for raw event data', country: 'United States', disclosed_on: '2026-05-19', notes: 'Disclosed in the draft agreement.' },
        { processor_id: { $ref: 'pr_mail' }, processor_name: 'Vestamail Campaigns Ltd', name: 'Sendrail SMTP Ltd', service: 'Outbound mail relay', country: 'Ireland', disclosed_on: '2025-06-12' },
        { processor_id: { $ref: 'pr_pay' }, processor_name: 'Meridiaan Payroll B.V.', name: 'Tijdreeks Archief B.V.', service: 'Statutory archiving of payroll records', country: 'Netherlands', disclosed_on: '2024-04-08' },
    ],

    tbl_act001: [
        {
            $id: 'ac_pers', name: 'Personnel administration', purpose: 'Administering employment relationships: contracts, hours, roles and appraisals.',
            department: 'hr', controller_name: 'Zonnehof Zorggroep', legal_basis: 'contract', lia_status: 'not_required',
            data_subjects: 'Employees, trainees and temporary staff.', special_category: 'none',
            retention_period: '2 years after the end of employment', retention_basis: 'Standard administrative term; payroll tax items are kept longer under the payroll entry.',
            security_measures: 'Role-based access in the HR system, logging of record access, two-factor authentication for HR staff.',
            systems: 'HR system, shared drive (contracts)', last_reviewed: '2026-02-10', review_interval_days: 365, next_review_date: '2027-02-10',
            status: 'active', risk_tier: 'low', dpia_status: 'not_needed', reviewer_name: 'Head of People', reviewer_email: 'people@example.com',
        },
        {
            $id: 'ac_pay', name: 'Payroll and salary payments', purpose: 'Calculating and paying salaries, and meeting payroll tax and pension obligations.',
            department: 'hr', controller_name: 'Zonnehof Zorggroep', legal_basis: 'legal_obligation', lia_status: 'not_required',
            data_subjects: 'Employees and former employees.', special_category: 'none',
            retention_period: '7 years', retention_basis: 'Fiscal retention obligation for payroll records.',
            security_measures: 'Processing agreement with the payroll supplier, encrypted file exchange, four-eyes approval on payment runs.',
            systems: 'Payroll supplier portal, banking software', last_reviewed: '2026-01-20', review_interval_days: 365, next_review_date: '2027-01-20',
            status: 'active', risk_tier: 'low', dpia_status: 'not_needed', reviewer_name: 'Financial controller', reviewer_email: 'finance@example.com',
        },
        {
            $id: 'ac_recr', name: 'Recruitment and applications', purpose: 'Assessing applicants for vacancies and keeping a shortlist with consent.',
            department: 'hr', controller_name: 'Zonnehof Zorggroep', legal_basis: 'consent', lia_status: 'not_required',
            data_subjects: 'Applicants.', special_category: 'none',
            retention_period: '4 weeks after the procedure ends, or 1 year with consent', retention_basis: 'Common practice; the longer term is only used where the applicant agreed.',
            security_measures: 'Applications in a separate mailbox with restricted access; files deleted on a calendar reminder.',
            systems: 'Recruitment mailbox, shared drive', last_reviewed: '2025-09-15', review_interval_days: 365, next_review_date: '2026-09-15',
            status: 'active', risk_tier: 'low', dpia_status: 'not_assessed', reviewer_name: 'Head of People', reviewer_email: 'people@example.com',
        },
        {
            $id: 'ac_occh', name: 'Occupational health and absence', purpose: 'Recording absence, arranging reintegration and meeting the employer’s statutory duties.',
            department: 'hr', controller_name: 'Zonnehof Zorggroep', joint_controller: 'Occupational health service (own controller for medical data)',
            legal_basis: 'legal_obligation', lia_status: 'not_required',
            data_subjects: 'Employees reporting sick.', special_category: 'present',
            retention_period: '2 years after the end of employment', retention_basis: 'Statutory reintegration obligations.',
            security_measures: 'Only the case manager sees the file; no diagnosis is recorded by the employer, only limitations and availability.',
            systems: 'Absence module, occupational health portal', last_reviewed: '2026-03-03', review_interval_days: 365, next_review_date: '2027-03-03',
            status: 'active', risk_tier: 'high', dpia_status: 'done', reviewer_name: 'Head of People', reviewer_email: 'people@example.com',
        },
        {
            // Overdue AND high risk: the entry the front screen opens on.
            $id: 'ac_ecd', name: 'Electronic client records', purpose: 'Recording care given, care plans and reporting, so continuity of care is safeguarded.',
            department: 'care', controller_name: 'Zonnehof Zorggroep', legal_basis: 'legal_obligation', lia_status: 'not_required',
            data_subjects: 'Clients and their legal representatives.', special_category: 'present',
            retention_period: '20 years after the end of the treatment relationship', retention_basis: 'Statutory medical record retention term.',
            security_measures: 'Access on a need-to-know basis per care team, full access logging, annual access review, NEN 7510 certified supplier.',
            systems: 'Electronic client record (Lumen Care Systems)', last_reviewed: '2025-05-30', review_interval_days: 365, next_review_date: '2026-05-30',
            status: 'active', risk_tier: 'high', dpia_status: 'in_progress', reviewer_name: 'Care manager', reviewer_email: 'care@example.com',
        },
        {
            $id: 'ac_med', name: 'Medication administration', purpose: 'Recording which medication was prescribed, handed out and taken.',
            department: 'care', controller_name: 'Zonnehof Zorggroep', legal_basis: 'legal_obligation', lia_status: 'not_required',
            data_subjects: 'Clients.', special_category: 'present',
            retention_period: '20 years after the end of the treatment relationship', retention_basis: 'Part of the medical record.',
            security_measures: 'Double signing on administration, access limited to the care team on duty.',
            systems: 'Electronic client record, medication module', last_reviewed: '2026-04-14', review_interval_days: 365, next_review_date: '2027-04-14',
            status: 'active', risk_tier: 'elevated', dpia_status: 'in_progress', reviewer_name: 'Care manager', reviewer_email: 'care@example.com',
        },
        {
            // Legitimate interests DONE properly: the balancing test is written
            // down, so lia_status is 'recorded' and it stays off the finding list.
            $id: 'ac_cctv', name: 'Camera surveillance at the entrances', purpose: 'Protecting property and the safety of residents, staff and visitors at the main entrances.',
            department: 'facilities', controller_name: 'Zonnehof Zorggroep', legal_basis: 'legitimate_interests',
            lia_status: 'recorded',
            lia_summary: 'Interest: preventing and investigating break-ins and aggression at the entrances, after four incidents in 2025. Necessity: lighting and a locked door were tried first and did not stop the incidents; cameras cover only the two entrances, never care areas. Balance: images are kept 4 weeks, viewed only after a reported incident by two named people, signage at every door, and no audio is recorded.',
            data_subjects: 'Residents, staff, visitors and passers-by at the entrances.', special_category: 'none',
            retention_period: '4 weeks', retention_basis: 'Longer only where footage is needed for a reported incident.',
            security_measures: 'Recorder in a locked room, viewing on request only, viewing actions logged.',
            systems: 'Camera recorder (on premises)', last_reviewed: '2025-10-06', review_interval_days: 365, next_review_date: '2026-10-06',
            status: 'active', risk_tier: 'elevated', dpia_status: 'done', reviewer_name: 'Facilities coordinator', reviewer_email: 'facilities@example.com',
        },
        {
            // Finding: legitimate interests, nothing written down — AND overdue.
            $id: 'ac_analy', name: 'Website statistics', purpose: 'Understanding which pages visitors use, to improve the website.',
            department: 'marketing', controller_name: 'Zonnehof Zorggroep', legal_basis: 'legitimate_interests', lia_status: 'missing',
            data_subjects: 'Website visitors.', special_category: 'none',
            retention_period: '14 months', retention_basis: 'Supplier default; not yet reasoned through.',
            security_measures: 'Statistics supplier account limited to two people.',
            systems: 'Website, analytics supplier', last_reviewed: '2025-02-28', review_interval_days: 365, next_review_date: '2026-02-28',
            status: 'active', risk_tier: 'elevated', dpia_status: 'not_assessed', reviewer_name: 'Marketing lead', reviewer_email: 'marketing@example.com',
        },
        {
            $id: 'ac_news', name: 'Newsletter subscriptions', purpose: 'Sending the quarterly newsletter to people who asked for it.',
            department: 'marketing', controller_name: 'Zonnehof Zorggroep', legal_basis: 'consent', lia_status: 'not_required',
            data_subjects: 'Subscribers.', special_category: 'none',
            retention_period: 'Until the subscription is withdrawn', retention_basis: 'Consent can be withdrawn at any time; the unsubscribe link is in every mail.',
            security_measures: 'Subscriber list held only at the mailing supplier; export restricted to the marketing lead.',
            systems: 'Mailing supplier', last_reviewed: '2026-06-01', review_interval_days: 365, next_review_date: '2027-06-01',
            status: 'active', risk_tier: 'low', dpia_status: 'not_needed', reviewer_name: 'Marketing lead', reviewer_email: 'marketing@example.com',
        },
        {
            // Second finding: legitimate interests with an empty balancing test.
            $id: 'ac_portal', name: 'Access logging in the client portal', purpose: 'Detecting and investigating unauthorised access to client records.',
            department: 'ict', controller_name: 'Zonnehof Zorggroep', legal_basis: 'legitimate_interests', lia_status: 'missing',
            data_subjects: 'Employees and clients using the portal.', special_category: 'none',
            retention_period: '12 months', retention_basis: 'Long enough to investigate a reported incident.',
            security_measures: 'Logs are write-once, readable by the security officer only.',
            systems: 'Client portal, log store', last_reviewed: '2026-05-11', review_interval_days: 365, next_review_date: '2027-05-11',
            status: 'active', risk_tier: 'elevated', dpia_status: 'not_assessed', reviewer_name: 'ICT manager', reviewer_email: 'ict@example.com',
        },
        {
            $id: 'ac_supp', name: 'Supplier and invoice administration', purpose: 'Handling purchase orders, invoices and payments to suppliers.',
            department: 'finance', controller_name: 'Zonnehof Zorggroep', legal_basis: 'contract', lia_status: 'not_required',
            data_subjects: 'Contact persons at suppliers.', special_category: 'none',
            retention_period: '7 years', retention_basis: 'Fiscal retention obligation for the accounts.',
            security_measures: 'Segregation of duties between purchasing and payment; supplier bank changes verified by telephone.',
            systems: 'Accounting package', last_reviewed: '2025-08-19', review_interval_days: 730, next_review_date: '2027-08-19',
            status: 'active', risk_tier: 'low', dpia_status: 'not_needed', reviewer_name: 'Financial controller', reviewer_email: 'finance@example.com',
        },
        {
            // Overdue, and holds Art. 9 data — the third thing on the front list.
            $id: 'ac_inc', name: 'Incident and complaints register', purpose: 'Recording incidents and complaints so they can be investigated and prevented.',
            department: 'care', controller_name: 'Zonnehof Zorggroep', legal_basis: 'legal_obligation', lia_status: 'not_required',
            data_subjects: 'Clients, complainants and staff involved.', special_category: 'present',
            retention_period: '5 years after closure', retention_basis: 'Quality and supervision obligations.',
            security_measures: 'Restricted to the quality officer and the manager concerned; anonymised for trend reporting.',
            systems: 'Quality system', last_reviewed: '2025-07-01', review_interval_days: 365, next_review_date: '2026-07-01',
            status: 'active', risk_tier: 'elevated', dpia_status: 'not_assessed', reviewer_name: 'Care manager', reviewer_email: 'care@example.com',
        },
    ],

    tbl_aproc1: [
        { activity_id: { $ref: 'ac_pers' }, activity_name: 'Personnel administration', processor_id: { $ref: 'pr_pay' }, processor_name: 'Meridiaan Payroll B.V.', dpa_status: 'signed', role: 'Processor (Art. 28)', notes: 'Holds the contract data needed for payroll.' },
        { activity_id: { $ref: 'ac_pay' }, activity_name: 'Payroll and salary payments', processor_id: { $ref: 'pr_pay' }, processor_name: 'Meridiaan Payroll B.V.', dpa_status: 'signed', role: 'Processor (Art. 28)' },
        { activity_id: { $ref: 'ac_ecd' }, activity_name: 'Electronic client records', processor_id: { $ref: 'pr_ehr' }, processor_name: 'Lumen Care Systems B.V.', dpa_status: 'signed', role: 'Processor (Art. 28)' },
        { activity_id: { $ref: 'ac_med' }, activity_name: 'Medication administration', processor_id: { $ref: 'pr_ehr' }, processor_name: 'Lumen Care Systems B.V.', dpa_status: 'signed', role: 'Processor (Art. 28)' },
        { activity_id: { $ref: 'ac_inc' }, activity_name: 'Incident and complaints register', processor_id: { $ref: 'pr_ehr' }, processor_name: 'Lumen Care Systems B.V.', dpa_status: 'signed', role: 'Processor (Art. 28)' },
        // Linked while the agreement was still a draft — the snapshot says so,
        // and the DPA register on the Processors screen says it still is.
        { activity_id: { $ref: 'ac_analy' }, activity_name: 'Website statistics', processor_id: { $ref: 'pr_ana' }, processor_name: 'Northwind Analytics Inc.', dpa_status: 'requested', role: 'Processor (Art. 28)', notes: 'Linked before the agreement was signed.' },
        { activity_id: { $ref: 'ac_news' }, activity_name: 'Newsletter subscriptions', processor_id: { $ref: 'pr_mail' }, processor_name: 'Vestamail Campaigns Ltd', dpa_status: 'none', role: 'Processor (Art. 28)', notes: 'No agreement on file — raise with the supplier.' },
        { activity_id: { $ref: 'ac_portal' }, activity_name: 'Access logging in the client portal', processor_id: { $ref: 'pr_host' }, processor_name: 'Kestrel Cloud Hosting GmbH', dpa_status: 'signed', role: 'Processor (Art. 28)' },
    ],

    tbl_acat01: [
        { activity_id: { $ref: 'ac_pers' }, activity_name: 'Personnel administration', category_key: 'identification', category_name: 'Identification data', is_special: false },
        { activity_id: { $ref: 'ac_pers' }, activity_name: 'Personnel administration', category_key: 'contact', category_name: 'Contact details', is_special: false },
        { activity_id: { $ref: 'ac_pers' }, activity_name: 'Personnel administration', category_key: 'employment', category_name: 'Employment data', is_special: false },
        { activity_id: { $ref: 'ac_pers' }, activity_name: 'Personnel administration', category_key: 'financial', category_name: 'Financial data', is_special: false },
        { activity_id: { $ref: 'ac_pay' }, activity_name: 'Payroll and salary payments', category_key: 'identification', category_name: 'Identification data', is_special: false },
        { activity_id: { $ref: 'ac_pay' }, activity_name: 'Payroll and salary payments', category_key: 'financial', category_name: 'Financial data', is_special: false },
        { activity_id: { $ref: 'ac_pay' }, activity_name: 'Payroll and salary payments', category_key: 'employment', category_name: 'Employment data', is_special: false },
        { activity_id: { $ref: 'ac_recr' }, activity_name: 'Recruitment and applications', category_key: 'identification', category_name: 'Identification data', is_special: false },
        { activity_id: { $ref: 'ac_recr' }, activity_name: 'Recruitment and applications', category_key: 'contact', category_name: 'Contact details', is_special: false },
        { activity_id: { $ref: 'ac_recr' }, activity_name: 'Recruitment and applications', category_key: 'employment', category_name: 'Employment data', is_special: false },
        { activity_id: { $ref: 'ac_occh' }, activity_name: 'Occupational health and absence', category_key: 'identification', category_name: 'Identification data', is_special: false },
        { activity_id: { $ref: 'ac_occh' }, activity_name: 'Occupational health and absence', category_key: 'employment', category_name: 'Employment data', is_special: false },
        { activity_id: { $ref: 'ac_occh' }, activity_name: 'Occupational health and absence', category_key: 'health', category_name: 'Health data', is_special: true, notes: 'Limitations and availability only — no diagnosis is held by the employer.' },
        { activity_id: { $ref: 'ac_ecd' }, activity_name: 'Electronic client records', category_key: 'identification', category_name: 'Identification data', is_special: false },
        { activity_id: { $ref: 'ac_ecd' }, activity_name: 'Electronic client records', category_key: 'contact', category_name: 'Contact details', is_special: false },
        { activity_id: { $ref: 'ac_ecd' }, activity_name: 'Electronic client records', category_key: 'health', category_name: 'Health data', is_special: true },
        { activity_id: { $ref: 'ac_med' }, activity_name: 'Medication administration', category_key: 'identification', category_name: 'Identification data', is_special: false },
        { activity_id: { $ref: 'ac_med' }, activity_name: 'Medication administration', category_key: 'health', category_name: 'Health data', is_special: true },
        { activity_id: { $ref: 'ac_cctv' }, activity_name: 'Camera surveillance at the entrances', category_key: 'camera_images', category_name: 'Camera images', is_special: false },
        { activity_id: { $ref: 'ac_analy' }, activity_name: 'Website statistics', category_key: 'usage_logs', category_name: 'Usage and access logs', is_special: false },
        { activity_id: { $ref: 'ac_analy' }, activity_name: 'Website statistics', category_key: 'location', category_name: 'Location data', is_special: false },
        { activity_id: { $ref: 'ac_news' }, activity_name: 'Newsletter subscriptions', category_key: 'contact', category_name: 'Contact details', is_special: false },
        { activity_id: { $ref: 'ac_portal' }, activity_name: 'Access logging in the client portal', category_key: 'identification', category_name: 'Identification data', is_special: false },
        { activity_id: { $ref: 'ac_portal' }, activity_name: 'Access logging in the client portal', category_key: 'usage_logs', category_name: 'Usage and access logs', is_special: false },
        { activity_id: { $ref: 'ac_supp' }, activity_name: 'Supplier and invoice administration', category_key: 'contact', category_name: 'Contact details', is_special: false },
        { activity_id: { $ref: 'ac_supp' }, activity_name: 'Supplier and invoice administration', category_key: 'financial', category_name: 'Financial data', is_special: false },
        { activity_id: { $ref: 'ac_inc' }, activity_name: 'Incident and complaints register', category_key: 'identification', category_name: 'Identification data', is_special: false },
        { activity_id: { $ref: 'ac_inc' }, activity_name: 'Incident and complaints register', category_key: 'health', category_name: 'Health data', is_special: true },
    ],

    tbl_trans1: [
        // THE gap: clauses in place, nobody has assessed the destination.
        { activity_id: { $ref: 'ac_analy' }, activity_name: 'Website statistics', recipient: 'Northwind Analytics Inc.', country: 'United States', safeguard: 'sccs', safeguard_reference: 'SCC module 2, annex to the draft agreement', tia_done: false, notes: 'Clauses are drafted, but no transfer impact assessment has been done.' },
        { activity_id: { $ref: 'ac_portal' }, activity_name: 'Access logging in the client portal', recipient: 'Cascade Storage LLC', country: 'United States', safeguard: 'sccs', safeguard_reference: 'SCC module 3 via Kestrel, annex 4', tia_done: true, assessed_on: '2026-01-22', notes: 'Assessment concluded: logs are pseudonymised before export.' },
        { activity_id: { $ref: 'ac_ecd' }, activity_name: 'Electronic client records', recipient: 'Lumen Care Systems support desk', country: 'United Kingdom', safeguard: 'adequacy', safeguard_reference: 'UK adequacy decision', tia_done: true, assessed_on: '2025-11-30', notes: 'Support access is read-only and time-boxed per ticket.' },
        { activity_id: { $ref: 'ac_news' }, activity_name: 'Newsletter subscriptions', recipient: 'Sendrail SMTP Ltd (Singapore relay)', country: 'Singapore', safeguard: 'derogation', safeguard_reference: 'Art. 49(1)(b) — necessary to send the mail the subscriber asked for', tia_done: false, notes: 'A derogation is not an automation solution. Move the relay into the EEA or sign clauses.' },
        { activity_id: { $ref: 'ac_recr' }, activity_name: 'Recruitment and applications', recipient: 'Talentbaan Assessments Pty Ltd', country: 'Australia', safeguard: 'sccs', safeguard_reference: 'SCC module 2, signed 2026-01-30', tia_done: true, assessed_on: '2026-02-05', notes: 'Only used for the two management vacancies in 2026.' },
    ],

    tbl_dpia01: [
        { activity_id: { $ref: 'ac_occh' }, activity_name: 'Occupational health and absence', title: 'DPIA — Occupational health and absence', status: 'done', outcome: 'proceed_with_measures', residual_risk: 'elevated', measures: 'Employer records limitations and availability only; diagnosis stays with the occupational health service. Access limited to one case manager per file, with logging.', started_on: '2025-09-01', completed_on: '2025-10-20', owner_name: 'Data protection officer' },
        { activity_id: { $ref: 'ac_ecd' }, activity_name: 'Electronic client records', title: 'DPIA — Electronic client records', status: 'in_progress', outcome: 'pending', residual_risk: 'high', measures: 'Draft: per-team access profiles, quarterly access review, alerting on bulk export.', started_on: '2026-06-02', owner_name: 'Data protection officer' },
        { activity_id: { $ref: 'ac_cctv' }, activity_name: 'Camera surveillance at the entrances', title: 'DPIA — Camera surveillance at the entrances', status: 'done', outcome: 'proceed_with_measures', residual_risk: 'low', measures: 'Coverage limited to two entrances, 4-week retention, viewing by two named people after a reported incident only, signage at every door.', started_on: '2025-08-11', completed_on: '2025-09-30', owner_name: 'Facilities coordinator' },
        { activity_id: { $ref: 'ac_med' }, activity_name: 'Medication administration', title: 'DPIA — Medication administration', status: 'screening', outcome: 'pending', residual_risk: 'elevated', started_on: '2026-07-28', owner_name: 'Care manager' },
    ],

    tbl_rlog01: [
        { activity_id: { $ref: 'ac_pers' }, activity_name: 'Personnel administration', reviewer_name: 'Head of People', reviewed_on: '2025-02-10', next_review_date: '2026-02-10', kind: 'periodic_review', note: 'Annual review. Retention shortened from 5 to 2 years after the end of employment.' },
        { activity_id: { $ref: 'ac_pers' }, activity_name: 'Personnel administration', reviewer_name: 'Head of People', reviewed_on: '2026-02-10', next_review_date: '2027-02-10', kind: 'periodic_review', note: 'Annual review. No changes; appraisal forms moved into the HR system.' },
        { activity_id: { $ref: 'ac_pay' }, activity_name: 'Payroll and salary payments', reviewer_name: 'Financial controller', reviewed_on: '2026-01-20', next_review_date: '2027-01-20', kind: 'periodic_review', note: 'Annual review. Processing agreement with the payroll supplier re-checked.' },
        { activity_id: { $ref: 'ac_recr' }, activity_name: 'Recruitment and applications', reviewer_name: 'Head of People', reviewed_on: '2025-09-15', next_review_date: '2026-09-15', kind: 'periodic_review', note: 'Annual review. Deletion reminder after 4 weeks now runs automatically.' },
        { activity_id: { $ref: 'ac_occh' }, activity_name: 'Occupational health and absence', reviewer_name: 'Head of People', reviewed_on: '2026-03-03', next_review_date: '2027-03-03', kind: 'periodic_review', note: 'Annual review following the completed impact assessment.' },
        { activity_id: { $ref: 'ac_ecd' }, activity_name: 'Electronic client records', reviewer_name: 'Care manager', reviewed_on: '2024-05-30', next_review_date: '2025-05-30', kind: 'periodic_review', note: 'Annual review. Access profiles per care team introduced.' },
        { activity_id: { $ref: 'ac_ecd' }, activity_name: 'Electronic client records', reviewer_name: 'Care manager', reviewed_on: '2025-05-30', next_review_date: '2026-05-30', kind: 'periodic_review', note: 'Annual review. Supplier re-certified; impact assessment still to be redone.' },
        { activity_id: { $ref: 'ac_med' }, activity_name: 'Medication administration', reviewer_name: 'Care manager', reviewed_on: '2026-04-14', next_review_date: '2027-04-14', kind: 'periodic_review', note: 'Annual review. Double signing on administration confirmed.' },
        { activity_id: { $ref: 'ac_cctv' }, activity_name: 'Camera surveillance at the entrances', reviewer_name: 'Facilities coordinator', reviewed_on: '2025-10-06', next_review_date: '2026-10-06', kind: 'balancing_test', note: 'Balancing test written out after the 2025 incidents and recorded on the entry.' },
        { activity_id: { $ref: 'ac_cctv' }, activity_name: 'Camera surveillance at the entrances', reviewer_name: 'Facilities coordinator', reviewed_on: '2025-10-06', next_review_date: '2026-10-06', kind: 'periodic_review', note: 'Annual review. Camera at the rear entrance removed; two entrances remain.' },
        { activity_id: { $ref: 'ac_analy' }, activity_name: 'Website statistics', reviewer_name: 'Marketing lead', reviewed_on: '2025-02-28', next_review_date: '2026-02-28', kind: 'periodic_review', note: 'Annual review. Balancing test still to be written — carried over, and still open.' },
        { activity_id: { $ref: 'ac_news' }, activity_name: 'Newsletter subscriptions', reviewer_name: 'Marketing lead', reviewed_on: '2026-06-01', next_review_date: '2027-06-01', kind: 'periodic_review', note: 'Annual review. Unsubscribe link checked in the last three mailings.' },
        { activity_id: { $ref: 'ac_portal' }, activity_name: 'Access logging in the client portal', reviewer_name: 'ICT manager', reviewed_on: '2026-05-11', next_review_date: '2027-05-11', kind: 'change', note: 'Log retention shortened from 24 to 12 months. Balancing test still outstanding.' },
        { activity_id: { $ref: 'ac_supp' }, activity_name: 'Supplier and invoice administration', reviewer_name: 'Financial controller', reviewed_on: '2025-08-19', next_review_date: '2027-08-19', kind: 'periodic_review', note: 'Two-yearly review. No personal data beyond supplier contact persons.' },
        { activity_id: { $ref: 'ac_inc' }, activity_name: 'Incident and complaints register', reviewer_name: 'Care manager', reviewed_on: '2025-07-01', next_review_date: '2026-07-01', kind: 'periodic_review', note: 'Annual review. Anonymisation for trend reporting agreed with the quality officer.' },
    ],
};

module.exports = {
    id: 'app-processing-register',
    version: 1,
    title: 'Processing register (verwerkingsregister)',
    description: 'The Article 30 GDPR record of processing activities: legal bases, data categories, retention and security per activity, the processors and third-country transfers behind them, DPIA triage, and a review cycle that shows what is overdue. No AI, no connector — a place sensitive records simply live.',
    category: 'Data',
    icon: 'ClipboardList',
    tags: ['gdpr', 'avg', 'privacy', 'compliance', 'article-30', 'verwerkingsregister', 'dpia', 'register'],
    definition,
    dataModel,
    seed,
};
