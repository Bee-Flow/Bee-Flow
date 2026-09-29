/**
 * App Studio template — Invoice approvals (PDF in, approved and paid out).
 *
 * The flagship of the approvals wave. A finance team drops the supplier
 * invoices they have to pay into the app as PDFs, an ai_extract step reads
 * each one (supplier, invoice number, dates, net/VAT/total, PO number, line
 * items), and then the money question — WHO has to say yes before we pay —
 * is answered by a real, ordered approval chain rather than by a forwarded
 * mail thread.
 *
 * ── WHY THIS TEMPLATE EXISTS ────────────────────────────────────────────────
 * Approval is the one workflow every organisation has and almost nobody has
 * written down. It lives in someone's head ("anything over five grand goes to
 * Marieke"), which means it is applied inconsistently, is invisible to an
 * auditor, and disappears when that person is on holiday. `request_approval`
 * with `stages` makes the ladder a first-class object: named steps, in order,
 * each with its own approvers and its own rule, each one recorded.
 *
 * ── THE TWO KINDS OF ROUTING, AND WHEN TO REACH FOR WHICH ───────────────────
 * This template deliberately demonstrates BOTH, because they answer different
 * questions and an author who only knows one will contort it into the other.
 *
 *   FLOW-LEVEL routing — `condition` and `switch` steps in the action, each
 *   branch carrying its OWN request_approval. Reach for this when the branches
 *   differ in SHAPE: a different number of stages, different rules, a
 *   different deadline, or "no approval at all, park it instead". You cannot
 *   express "a two-stage chain here, a five-stage chain there" inside one
 *   chain, and pretending otherwise produces a chain full of conditions that
 *   nobody can read. See `act_iasubmit`:
 *     · the `condition` step routes on the SUPPLIER — a blocked supplier is
 *       parked on hold and NO approval is requested at all (there is no stage
 *       shape that means "do not ask anyone");
 *     · the `switch` step routes mainly on the AMOUNT BAND, into three
 *       genuinely different chains (1 rung / 4 rungs / 5 rungs, different
 *       rules, different deadlines) — and it reads the supplier too, because
 *       a small invoice from a watch-list supplier has to be PROMOTED off the
 *       one-rung ladder: a ladder with no Finance rung on it has nowhere for a
 *       stage condition to put one.
 *
 *   PER-STAGE `when` — one chain, one or more stages that only apply to some
 *   requests. Reach for this when the ladder is the SAME ladder and a rung is
 *   conditional: "over €5,000 also needs the director". The chain stays
 *   readable as a ladder, the skipped stage is KEPT and marked `skipped`
 *   (approvalStages.js), so the record still answers "why did this never reach
 *   Finance?" — which a second, separately-branched chain could never do.
 *   Conditions are evaluated ONCE, at request time, against the action scope,
 *   so the chain the first approver sees is the chain that will actually run.
 *   See STAGES_STANDARD (Finance and Director rungs) and STAGES_BOARD (the
 *   Board rung).
 *
 * The rule of thumb the file follows: BRANCH when the ladder changes, CONDITION
 * a rung when the ladder stays the same.
 *
 * ── THE APPROVER SEATS ARE THE ONE THING A TEMPLATE CANNOT KNOW ─────────────
 * A stage must name at least one approver — canonicalize drops a seatless
 * stage and validate refuses it, and rightly so: a stage nobody can decide is
 * a deadlock with a name. But this template has no idea who the installer's
 * team leads are, and inventing user ids that look real is worse than useless.
 *
 * So every seat here is an obviously-fake GROUP id prefixed `replace-me-`
 * (see the SEAT_* constants below). Two things make that safe rather than
 * sloppy:
 *
 *   1. At request time approvalLifecycle.validateStages puts every seat
 *      through the org gate and a stage that keeps none of them FALLS BACK TO
 *      THE APP OWNER — the stage is never dropped. So a freshly installed app
 *      works on day one: the owner is asked for every rung, in order, and the
 *      ladder is visibly there to be filled in.
 *   2. The app says so out loud. The Approval policy screen opens with the
 *      setup callout, and the ladder table spells out which group each rung
 *      expects, so "configure this" is a task in the product rather than a
 *      line in a README nobody reads.
 *
 * Groups rather than users on purpose: a rung should survive somebody leaving.
 *
 * ── THE SHAPE OF THE APP ────────────────────────────────────────────────────
 * Ten screens in four nav groups (a `sidebar` nav — at ten screens a flat tab
 * row stops telling anyone anything):
 *
 *   Work      · Today          — the finance team's morning screen: what is
 *                                waiting on ME (approval_list, scope 'mine'),
 *                                what is overdue, what is stuck.
 *             · New invoice    — drop the PDF, read it, check it, file it.
 *             · Invoices       — the register: filter bar, data grid, row tone
 *                                by status, click through to the invoice.
 *             · Invoice        — (not in nav) the document beside the numbers:
 *                                file_preview on the left, extracted fields and
 *                                the send-for-approval form on the right, the
 *                                lines below, the trail at the bottom.
 *   Decide    · Approvals      — approval_list twice: what is waiting on the
 *                                viewer, and what this app has asked for.
 *             · Payments       — approved invoices waiting to be paid, and the
 *                                record-payment dialog.
 *   Insight   · Reporting      — spend by month, by supplier, by cost centre;
 *                                the approval ladder's own throughput.
 *   Setup     · Suppliers      — the supplier master, including the two levers
 *                                the routing reads.
 *             · Approval policy— the ladder, written down, plus the seat setup.
 *             · Audit trail    — append-only; nobody, owner included, may edit.
 *
 * ── HOW THE RECORD LEARNS THE DECISION ──────────────────────────────────────
 * Every request_approval here carries the SAME `onDecided` hook (see
 * onDecidedHook()): approved → status 'approved' + who decided + when + the
 * approver's answers; rejected → status 'rejected' + the reason; expired or
 * withdrawn → back to 'needs_review' with a note saying which. The hook is
 * snapshotted at request time and runs inside the decision as the app owner,
 * so an approver who is not the owner still flips the invoice.
 *
 * `{{answers.<name>}}` is the approver's own form: "goods received as
 * ordered?" and "pay no later than" are questions the person deciding is the
 * only one who can answer, and they land on the invoice as columns rather
 * than as prose in a comment.
 *
 * ── AUTHORING NOTES (learned the hard way elsewhere, still true here) ───────
 *  • A stage's `when` is evaluated against the ACTION scope, server-side:
 *    `form.*` and `vars.*` are there, `records` is pinned to {}. That is why
 *    the routing levers are FORM FIELDS on the send-for-approval form
 *    (amount, cost centre, supplier check) rather than reads of the row — and
 *    it is also better product: the person sending it confirms the number
 *    that is about to be approved.
 *  • `stages` supersede assigneeUserId / approverUserIds / finalApproverUserId
 *    / escalateTo* — setting both is `action.approval_stages_conflict`. This
 *    file sets stages only.
 *  • The detail screen scopes on `vars.invoice` but reads only its `id`;
 *    every value on screen comes from a live read of the row, so a decision
 *    that lands while you are looking at it shows up on the next refetch.
 *  • Column keys are English here (no portal contract to honour), and every
 *    user-visible string is inline in the definition — templates do not go
 *    through i18n.
 *
 * ── THE DEMO DATA IS FICTION ────────────────────────────────────────────────
 * Every supplier, invoice number, contact and bank reference below is
 * invented. Bank references are deliberately NOT IBANs — they are a masked
 * "last 4" note — because a template that ships plausible-looking account
 * numbers is a template someone will eventually pay money into.
 */

'use strict';

const THEME_DEFAULTS = {
    radius: 'md',
    density: 'comfortable',
    fontScale: 'md',
    appearance: 'auto',
};

// ---------------------------------------------------------------------------
// Vocabularies. One list per concept, reused by the column, the dropdown, the
// badge tones and the board — so a status can never mean two things.
// ---------------------------------------------------------------------------

/**
 * The invoice's life. `draft` exists because an upload is a real state: the
 * PDF is stored, nothing has been read off it yet, and a grid that hid those
 * rows would hide exactly the ones somebody has to finish.
 */
const STATUS_OPTIONS = [
    { value: 'draft', label: 'Uploaded' },
    { value: 'needs_review', label: 'Needs review' },
    { value: 'in_approval', label: 'In approval' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'on_hold', label: 'On hold' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'paid', label: 'Paid' },
];

const STATUS_TONES = [
    { value: 'draft', label: 'Uploaded', tone: 'neutral' },
    { value: 'needs_review', label: 'Needs review', tone: 'warning' },
    { value: 'in_approval', label: 'In approval', tone: 'info' },
    { value: 'approved', label: 'Approved', tone: 'primary' },
    { value: 'rejected', label: 'Rejected', tone: 'danger' },
    { value: 'on_hold', label: 'On hold', tone: 'danger' },
    { value: 'scheduled', label: 'Scheduled', tone: 'info' },
    { value: 'paid', label: 'Paid', tone: 'success' },
];

/**
 * The SUPPLIER lever the routing reads. Copied onto each invoice at intake
 * (there are no joins to follow at request time) and offered on the
 * send-for-approval form, so the person sending it can escalate a supplier
 * they are unsure about without editing the supplier master.
 */
const RISK_OPTIONS = [
    { value: 'standard', label: 'Standard supplier' },
    { value: 'watch', label: 'On the watch list' },
    { value: 'blocked', label: 'Blocked — do not pay' },
];

const RISK_TONES = [
    { value: 'standard', label: 'Standard', tone: 'success' },
    { value: 'watch', label: 'Watch list', tone: 'warning' },
    { value: 'blocked', label: 'Blocked', tone: 'danger' },
];

/**
 * The invoice's own copy of the supplier lever. `auto` means "the amount
 * decides"; `always` puts the director rung in the chain whatever the amount
 * is — the shape of "external counsel always goes to the director".
 */
const DIRECTOR_RULE_OPTIONS = [
    { value: 'auto', label: 'Follow the amount' },
    { value: 'always', label: 'Always send to the director' },
];

const SUPPLIER_CATEGORY_OPTIONS = [
    { value: 'goods', label: 'Goods' },
    { value: 'services', label: 'Services' },
    { value: 'utilities', label: 'Utilities' },
    { value: 'professional', label: 'Professional fees' },
    { value: 'software', label: 'Software & subscriptions' },
    { value: 'logistics', label: 'Logistics' },
];

/**
 * Cost centres appear TWICE: as this option list (which the dropdowns and the
 * grid filter read) and as rows in `cost_centres` (which carries the budget
 * holder's name and the year's budget). That is the one seam in the
 * config-as-data story and it is called out on the Setup screen; the
 * accompanying test asserts the two agree on install.
 */
const COST_CENTRE_OPTIONS = [
    { value: 'cc_ops', label: 'Operations' },
    { value: 'cc_fac', label: 'Facilities' },
    { value: 'cc_it', label: 'IT & software' },
    { value: 'cc_mkt', label: 'Marketing' },
    { value: 'cc_hr', label: 'People' },
    { value: 'cc_fin', label: 'Finance & legal' },
];

const CURRENCY_OPTIONS = [
    { value: 'EUR', label: 'EUR (€)' },
    { value: 'USD', label: 'USD ($)' },
    { value: 'GBP', label: 'GBP (£)' },
];

/** The append-only trail's vocabulary. */
const EVENT_KIND_OPTIONS = [
    { value: 'uploaded', label: 'Uploaded' },
    { value: 'extracted', label: 'Read by AI' },
    { value: 'edited', label: 'Corrected' },
    { value: 'submitted', label: 'Sent for approval' },
    { value: 'decided', label: 'Decision recorded' },
    { value: 'hold', label: 'Put on hold' },
    { value: 'paid', label: 'Paid' },
    { value: 'note', label: 'Note' },
];

const EVENT_KIND_TONES = [
    { value: 'uploaded', label: 'Uploaded', tone: 'neutral' },
    { value: 'extracted', label: 'Read by AI', tone: 'info' },
    { value: 'edited', label: 'Corrected', tone: 'warning' },
    { value: 'submitted', label: 'Sent for approval', tone: 'primary' },
    { value: 'decided', label: 'Decision', tone: 'success' },
    { value: 'hold', label: 'On hold', tone: 'danger' },
    { value: 'paid', label: 'Paid', tone: 'success' },
    { value: 'note', label: 'Note', tone: 'neutral' },
];

// ---------------------------------------------------------------------------
// APPROVER SEATS — see the module header.
//
// Deliberately unmistakable placeholders. `replace-me-` can never collide with
// a real group id, reads as an instruction wherever it surfaces, and is
// asserted by appInvoiceApprovals.test.js so a real id can never be committed
// into the shipped gallery by accident.
//
// Group seats, not user seats: a rung that names a person stops working the
// day that person leaves, and every one of these rungs is a ROLE.
// ---------------------------------------------------------------------------
const SEAT_TEAM_LEAD = { groupId: 'replace-me-team-leads' };
const SEAT_BUDGET_HOLDER = { groupId: 'replace-me-budget-holders' };
const SEAT_FINANCE = { groupId: 'replace-me-finance' };
const SEAT_CONTROLLER = { groupId: 'replace-me-financial-controller' };
const SEAT_CFO = { groupId: 'replace-me-cfo' };
const SEAT_DIRECTOR = { groupId: 'replace-me-director' };
const SEAT_MD = { groupId: 'replace-me-managing-director' };
const SEAT_BOARD = { groupId: 'replace-me-board' };

// ---------------------------------------------------------------------------
// The money thresholds. Named once, used by the switch, by the stage
// conditions, by the policy seed and by the on-screen copy — a ladder whose
// numbers disagree with the table describing it is worse than no table.
// ---------------------------------------------------------------------------
const BAND_STANDARD = 1000;      // below this: one rung
const BAND_FINANCE = 2500;       // Finance joins the standard ladder here
const BAND_DIRECTOR = 5000;      // the owner's own sentence: "over €5,000 also needs the director"
const BAND_BOARD = 25000;        // above this: the long ladder
const BAND_FULL_BOARD = 100000;  // and the board itself only above this

// ---------------------------------------------------------------------------
// Access matrices. Every table names one explicitly; none is left on the
// friendly `default:'app'`, because with three roles that default would be one
// role wearing three names. The owner is never listed — resolveScope
// short-circuits them to full access.
//
// The split is the real one around accounts payable:
//   ap        — books the invoice: uploads, reads, corrects, sends for approval.
//               Cannot approve (the app never asks them to) and cannot pay.
//   approver  — budget holders and managers. They decide in the Approvals
//               inbox, which is NOT table access: approval rows live outside
//               the app's tables and are read as the real signed-in viewer.
//               Here they only need to READ the invoice they are deciding on.
//   finance   — the controller: everything, including marking an invoice paid
//               and maintaining the supplier master and the policy.
// ---------------------------------------------------------------------------
const ACCESS_INVOICES = {
    default: 'role',
    roles: {
        finance: { read: 'all', create: true, update: 'all', delete: 'all' },
        ap: { read: 'all', create: true, update: 'all', delete: false },
        // Read-only: an approver decides in the inbox, and an approver who
        // could edit the amount could approve a different invoice from the one
        // they were shown.
        approver: { read: 'all', create: false, update: false, delete: false },
    },
};

const ACCESS_LINES = {
    default: 'role',
    roles: {
        // create:true for ap is LOAD-BEARING: ai_extract writes its rows as the
        // VIEWER, so without it "Read the PDF" answers 403 for everyone but the
        // owner. Lines are work in progress, not an audit trail, so correcting
        // a bulk extraction must not depend on who happened to run it.
        finance: { read: 'all', create: true, update: 'all', delete: 'all' },
        ap: { read: 'all', create: true, update: 'all', delete: 'all' },
        approver: { read: 'all', create: false, update: false, delete: false },
    },
};

const ACCESS_SUPPLIERS = {
    default: 'role',
    roles: {
        // The two routing levers (risk, always_director) live here, so editing
        // a supplier is editing the approval policy — finance only.
        finance: { read: 'all', create: true, update: 'all', delete: 'all' },
        ap: { read: 'all', create: false, update: false, delete: false },
        approver: { read: 'all', create: false, update: false, delete: false },
    },
};

const ACCESS_COST_CENTRES = {
    default: 'role',
    roles: {
        finance: { read: 'all', create: true, update: 'all', delete: 'all' },
        ap: { read: 'all', create: false, update: false, delete: false },
        approver: { read: 'all', create: false, update: false, delete: false },
    },
};

const ACCESS_POLICY = {
    default: 'role',
    roles: {
        // The written-down ladder. Everyone READS it — an approval nobody can
        // look up the rule for is the thing this app exists to end.
        finance: { read: 'all', create: true, update: 'all', delete: 'all' },
        ap: { read: 'all', create: false, update: false, delete: false },
        approver: { read: 'all', create: false, update: false, delete: false },
    },
};

const ACCESS_EVENTS = {
    default: 'role',
    // APPEND-ONLY. The point of a trail is that the people it records cannot
    // edit it — the controller included. create:true for all three because
    // every one of them does something the trail has to record.
    roles: {
        finance: { read: 'all', create: true, update: false, delete: false },
        ap: { read: 'all', create: true, update: false, delete: false },
        approver: { read: 'all', create: true, update: false, delete: false },
    },
};

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const dataModel = {
    modelVersion: 1,
    tables: [
        {
            // The supplier master. Two of its columns are not descriptive at
            // all — `risk` and `always_director` are POLICY, and they are the
            // supplier half of the routing.
            id: 'tbl_iasup', key: 'suppliers', name: 'Suppliers', icon: 'Building2',
            fields: [
                { id: 'fld_iasnm', key: 'name', name: 'Supplier', type: 'text', required: true, unique: true },
                { id: 'fld_iasno', key: 'supplier_no', name: 'Supplier no.', type: 'text' },
                { id: 'fld_iascat', key: 'category', name: 'Category', type: 'select', options: SUPPLIER_CATEGORY_OPTIONS },
                { id: 'fld_iasctc', key: 'contact_name', name: 'Contact', type: 'text' },
                { id: 'fld_iasml', key: 'contact_email', name: 'Contact e-mail', type: 'text' },
                { id: 'fld_iasterm', key: 'payment_terms_days', name: 'Payment terms (days)', type: 'number', subtype: 'integer' },
                {
                    // Deliberately NOT an IBAN column. A template that ships
                    // plausible account numbers is a template someone
                    // eventually pays money into; the real number belongs in
                    // the accounting system, and what this app needs is a
                    // human check that the invoice names the account on file.
                    id: 'fld_iasbank', key: 'bank_reference', name: 'Bank account on file', type: 'text',
                },
                { id: 'fld_iasrisk', key: 'risk', name: 'Supplier check', type: 'select', options: RISK_OPTIONS, default: 'standard' },
                {
                    // The supplier-name lever, written as a flag rather than as
                    // a list of names in an expression: a new supplier that
                    // needs the director is a tick box, not a code change.
                    id: 'fld_iasdir', key: 'always_director', name: 'Always needs the director', type: 'bool',
                    default: false,
                },
                { id: 'fld_iasact', key: 'active', name: 'Active', type: 'bool', default: true },
                { id: 'fld_iasnote', key: 'notes', name: 'Notes', type: 'text' },
            ],
            access: ACCESS_SUPPLIERS,
        },
        {
            // The budget-holder vocabulary. Its `key` matches
            // COST_CENTRE_OPTIONS exactly — see the comment there.
            id: 'tbl_iacc', key: 'cost_centres', name: 'Cost centres', icon: 'Landmark',
            fields: [
                { id: 'fld_iacckey', key: 'key', name: 'Code', type: 'text', required: true, unique: true },
                { id: 'fld_iaccnm', key: 'name', name: 'Cost centre', type: 'text', required: true },
                { id: 'fld_iaccown', key: 'owner_name', name: 'Budget holder', type: 'text' },
                { id: 'fld_iaccbud', key: 'budget_year', name: 'Budget this year', type: 'number' },
                { id: 'fld_iaccact', key: 'active', name: 'Active', type: 'bool', default: true },
            ],
            access: ACCESS_COST_CENTRES,
        },
        {
            // The ladder, WRITTEN DOWN. This table does not drive the chain —
            // the chain lives in act_iasubmit, because approver seats and stage
            // rules are step fields, not bindings. What it does is make the
            // rule legible to the people it governs and to an auditor, which
            // is most of the value of having a policy at all. The accompanying
            // test asserts the two agree on the thresholds, so the written rule
            // cannot drift from the enforced one.
            id: 'tbl_iapol', key: 'approval_policy', name: 'Approval policy', icon: 'Scale',
            fields: [
                { id: 'fld_iaprnk', key: 'rank', name: 'Order', type: 'number', subtype: 'integer' },
                { id: 'fld_iapband', key: 'band', name: 'Band', type: 'text', required: true },
                { id: 'fld_iapmin', key: 'min_amount', name: 'From (€)', type: 'number' },
                { id: 'fld_iapmax', key: 'max_amount', name: 'Up to (€)', type: 'number' },
                { id: 'fld_iapstg', key: 'stages_label', name: 'Who has to approve', type: 'text' },
                { id: 'fld_iaprule', key: 'rule_note', name: 'How it resolves', type: 'text' },
                { id: 'fld_iapseat', key: 'seats_label', name: 'Groups to fill in', type: 'text' },
                { id: 'fld_iapact', key: 'active', name: 'Active', type: 'bool', default: true },
            ],
            access: ACCESS_POLICY,
        },
        {
            // The invoices themselves. Everything from `status` down is written
            // by an action or by the on_decided hook — never typed twice.
            id: 'tbl_iainv', key: 'invoices', name: 'Invoices', icon: 'FileText',
            fields: [
                { id: 'fld_iainr', key: 'invoice_no', name: 'Invoice no.', type: 'text', required: true },
                { id: 'fld_iaisup', key: 'supplier', name: 'Supplier', type: 'relation', relation: { table: 'tbl_iasup' } },
                {
                    // Denormalised on purpose: there are no joins in a records
                    // binding, so a grid that wanted the supplier's NAME could
                    // only show a record id. The test asserts every copy still
                    // matches the row it was copied from.
                    id: 'fld_iaisnm', key: 'supplier_name', name: 'Supplier', type: 'text',
                },
                { id: 'fld_iaidt', key: 'invoice_date', name: 'Invoice date', type: 'date' },
                { id: 'fld_iaidue', key: 'due_date', name: 'Due date', type: 'date' },
                { id: 'fld_iaicur', key: 'currency', name: 'Currency', type: 'select', options: CURRENCY_OPTIONS, default: 'EUR' },
                { id: 'fld_iaiexc', key: 'amount_excl_vat', name: 'Net', type: 'number' },
                { id: 'fld_iaivat', key: 'vat_amount', name: 'VAT', type: 'number' },
                { id: 'fld_iaitot', key: 'amount_total', name: 'Total', type: 'number' },
                { id: 'fld_iaicc', key: 'cost_center', name: 'Cost centre', type: 'select', options: COST_CENTRE_OPTIONS },
                { id: 'fld_iaipo', key: 'po_number', name: 'PO number', type: 'text' },
                { id: 'fld_iaidoc', key: 'document', name: 'Invoice PDF', type: 'file' },
                { id: 'fld_iaist', key: 'status', name: 'Status', type: 'select', options: STATUS_OPTIONS, default: 'draft' },
                // ── the routing levers, copied from the supplier at intake ──
                { id: 'fld_iairisk', key: 'supplier_risk', name: 'Supplier check', type: 'select', options: RISK_OPTIONS, default: 'standard' },
                {
                    // A SELECT rather than the supplier's boolean, because this
                    // column is offered on the send-for-approval form and
                    // `input_checkbox` has no `valueFrom` — a tick box that
                    // cannot show the value it already has is write-only. Copied
                    // from the supplier at intake; the person sending it may
                    // still raise it by hand.
                    id: 'fld_iaidir', key: 'director_rule', name: 'Director rule', type: 'select',
                    options: DIRECTOR_RULE_OPTIONS, default: 'auto',
                },
                {
                    // The band the ladder will use, computed in SQL so it is
                    // filterable and groupable without every screen repeating
                    // the thresholds. Portable — a CASE over numbers needs no
                    // dialect translation.
                    id: 'fld_iaband', key: 'band', name: 'Band', type: 'computed',
                    computed: {
                        type: 'text', stored: true,
                        expr: `CASE WHEN amount_total IS NULL THEN 'unknown' WHEN amount_total >= ${BAND_BOARD} THEN 'board' WHEN amount_total >= ${BAND_DIRECTOR} THEN 'director' WHEN amount_total >= ${BAND_STANDARD} THEN 'standard' ELSE 'fast' END`,
                    },
                },
                // ── the approval round ──
                { id: 'fld_iaroute', key: 'approval_route', name: 'Route taken', type: 'text' },
                { id: 'fld_iasubn', key: 'submitted_by_name', name: 'Sent by', type: 'text' },
                { id: 'fld_iasubt', key: 'submitted_at', name: 'Sent for approval', type: 'datetime' },
                { id: 'fld_iadecn', key: 'decided_by_name', name: 'Decided by', type: 'text' },
                { id: 'fld_iadect', key: 'decided_at', name: 'Decided', type: 'datetime' },
                { id: 'fld_iadecnt', key: 'decision_note', name: 'Decision note', type: 'text' },
                { id: 'fld_iarej', key: 'rejection_reason', name: 'Reason rejected', type: 'text' },
                // ── the approver's own answers, written by the on_decided hook ──
                { id: 'fld_iagr', key: 'goods_received', name: 'Goods/services received', type: 'bool' },
                { id: 'fld_iapayby', key: 'approved_pay_by', name: 'Approved: pay no later than', type: 'date' },
                // ── payment ──
                { id: 'fld_iapdt', key: 'payment_date', name: 'Paid on', type: 'date' },
                { id: 'fld_iapref', key: 'payment_reference', name: 'Payment reference', type: 'text' },
                { id: 'fld_iapbn', key: 'paid_by_name', name: 'Paid by', type: 'text' },
                { id: 'fld_iapat', key: 'paid_at', name: 'Payment recorded', type: 'datetime' },
                { id: 'fld_iaxnote', key: 'extraction_note', name: 'What the AI could not read', type: 'text' },
            ],
            access: ACCESS_INVOICES,
        },
        {
            // One row per invoice line. Written in bulk by the second
            // ai_extract; editable inline afterwards, because an extraction is
            // a first draft and a booking is not.
            id: 'tbl_ialine', key: 'invoice_lines', name: 'Invoice lines', icon: 'Table',
            fields: [
                { id: 'fld_ialinv', key: 'invoice', name: 'Invoice', type: 'relation', relation: { table: 'tbl_iainv' } },
                { id: 'fld_ialno', key: 'invoice_no', name: 'Invoice no.', type: 'text' },
                { id: 'fld_iallin', key: 'line_no', name: 'Line', type: 'number', subtype: 'integer' },
                { id: 'fld_ialdesc', key: 'description', name: 'Description', type: 'text' },
                { id: 'fld_ialqty', key: 'quantity', name: 'Qty', type: 'number' },
                { id: 'fld_ialup', key: 'unit_price', name: 'Unit price', type: 'number' },
                { id: 'fld_ialtot', key: 'line_total', name: 'Line total', type: 'number' },
                { id: 'fld_ialvat', key: 'vat_rate', name: 'VAT %', type: 'number' },
                { id: 'fld_ialcc', key: 'cost_center', name: 'Cost centre', type: 'select', options: COST_CENTRE_OPTIONS },
                { id: 'fld_ialgl', key: 'gl_account', name: 'GL account', type: 'text' },
            ],
            access: ACCESS_LINES,
        },
        {
            // The trail. Append-only by access matrix, not by convention.
            id: 'tbl_iaevt', key: 'invoice_events', name: 'Audit trail', icon: 'History',
            fields: [
                { id: 'fld_iaeinv', key: 'invoice', name: 'Invoice', type: 'relation', relation: { table: 'tbl_iainv' } },
                { id: 'fld_iaeno', key: 'invoice_no', name: 'Invoice no.', type: 'text' },
                { id: 'fld_iaeat', key: 'at', name: 'When', type: 'datetime' },
                { id: 'fld_iaeact', key: 'actor', name: 'Who', type: 'text' },
                { id: 'fld_iaekind', key: 'kind', name: 'What', type: 'select', options: EVENT_KIND_OPTIONS },
                { id: 'fld_iaedet', key: 'detail', name: 'Detail', type: 'text' },
            ],
            access: ACCESS_EVENTS,
        },
    ],
    roles: [
        { key: 'finance', label: 'Finance (controller)' },
        { key: 'ap', label: 'Accounts payable' },
        { key: 'approver', label: 'Approver' },
    ],
    // NULL, not 'ap': canReadStudioApp is a publication gate — it decides who
    // may see that the app exists, not who may see every invoice the company
    // has to pay. Until the owner grants a role, a viewer gets the locked
    // screen.
    roleMapping: { default: null, byGroup: {} },
};

// ---------------------------------------------------------------------------
// Seed — a small, entirely fictional trading company's August.
//
// Every supplier, invoice number, contact and bank reference is invented. The
// bank references are deliberately NOT IBANs: a masked "last 4" note is what
// an AP clerk actually checks an invoice against, and it is not a number
// anybody can pay into. Amounts use the Dutch 21% rate so net + VAT = total
// exactly — the accompanying test asserts that, because a demo whose sums do
// not add up teaches people to ignore the sums.
// ---------------------------------------------------------------------------

const seed = {
    tbl_iasup: [
        { $id: 'sup_kwartel', name: 'Kwartel Kantoorservice B.V.', supplier_no: 'S-1001', category: 'goods', contact_name: 'Ineke Wolters', contact_email: 'facturen@kwartel.example', payment_terms_days: 30, bank_reference: 'On file · last 4: 4417', risk: 'standard', always_director: false, active: true, notes: 'Office supplies and print. Framework agreement renewed each January.' },
        { $id: 'sup_nordfjell', name: 'Nordfjell Energi AS', supplier_no: 'S-1002', category: 'utilities', contact_name: 'Ola Rygg', contact_email: 'billing@nordfjell.example', payment_terms_days: 21, bank_reference: 'On file · last 4: 9052', risk: 'standard', always_director: false, active: true, notes: 'Electricity and district heating for the Rotterdam site.' },
        { $id: 'sup_bergveld', name: 'Bergveld Techniek B.V.', supplier_no: 'S-1003', category: 'services', contact_name: 'Sander Bergveld', contact_email: 'administratie@bergveld.example', payment_terms_days: 30, bank_reference: 'On file · last 4: 2288', risk: 'standard', always_director: false, active: true, notes: 'Machine maintenance and the annual overhaul.' },
        {
            $id: 'sup_vermeer', name: 'Vermeer & Kaptein Advocaten', supplier_no: 'S-1004', category: 'professional',
            contact_name: 'Mr. H. Kaptein', contact_email: 'declaraties@vermeerkaptein.example', payment_terms_days: 14,
            bank_reference: 'On file · last 4: 7731', risk: 'standard',
            // The supplier-name lever in the flesh: legal fees go to the
            // director whatever they cost, because the question is never the
            // amount — it is what we are apparently in a dispute about.
            always_director: true, active: true,
            notes: 'External counsel. Every invoice goes to the director regardless of amount — board resolution of March 2025.',
        },
        { $id: 'sup_stroomlijn', name: 'Stroomlijn Cloud B.V.', supplier_no: 'S-1005', category: 'software', contact_name: 'Rian de Kort', contact_email: 'invoices@stroomlijn.example', payment_terms_days: 30, bank_reference: 'On file · last 4: 5140', risk: 'standard', always_director: false, active: true, notes: 'Hosting and the monthly seat licence. Fixed price per quarter.' },
        { $id: 'sup_duinlicht', name: 'Duinlicht Facilitair B.V.', supplier_no: 'S-1006', category: 'services', contact_name: 'Petra Sanders', contact_email: 'fin@duinlicht.example', payment_terms_days: 45, bank_reference: 'On file · last 4: 6603', risk: 'standard', always_director: false, active: true, notes: 'Cleaning and reception cover.' },
        {
            $id: 'sup_marchetti', name: 'Marchetti Consulting Srl', supplier_no: 'S-1007', category: 'professional',
            contact_name: 'Giulia Marchetti', contact_email: 'amministrazione@marchetti.example', payment_terms_days: 30,
            bank_reference: 'On file · last 4: 1194',
            // On the watch list: the last two invoices arrived without a PO and
            // the day rate had moved. Finance joins the ladder for anything
            // from this supplier, whatever the amount.
            risk: 'watch', always_director: false, active: true,
            notes: 'Marketing strategy retainer. Two invoices arrived without a PO in Q1 — Finance checks every one until the PO discipline holds.',
        },
        {
            $id: 'sup_havenkade', name: 'Havenkade Logistiek B.V.', supplier_no: 'S-1008', category: 'logistics',
            contact_name: 'Onbekend', contact_email: 'facturatie@havenkade.example', payment_terms_days: 30,
            bank_reference: 'CHANGED — not verified', risk: 'blocked', always_director: false, active: false,
            notes: 'Payment stopped: a change-of-bank-account letter arrived that we could not verify by phone. Nothing is paid to this supplier until the account is confirmed on a known number.',
        },
    ],

    tbl_iacc: [
        { key: 'cc_ops', name: 'Operations', owner_name: 'Joris Hendriks', budget_year: 480000, active: true },
        { key: 'cc_fac', name: 'Facilities', owner_name: 'Petra Sanders', budget_year: 210000, active: true },
        { key: 'cc_it', name: 'IT & software', owner_name: 'Rian de Kort', budget_year: 165000, active: true },
        { key: 'cc_mkt', name: 'Marketing', owner_name: 'Naomi Ellis', budget_year: 140000, active: true },
        { key: 'cc_hr', name: 'People', owner_name: 'Tanja Willems', budget_year: 95000, active: true },
        { key: 'cc_fin', name: 'Finance & legal', owner_name: 'Marieke Doorn', budget_year: 120000, active: true },
    ],

    // The ladder in words. Kept in step with the thresholds above by the test.
    tbl_iapol: [
        {
            rank: 1, band: 'Fast track', min_amount: 0, max_amount: BAND_STANDARD,
            stages_label: 'Team lead',
            rule_note: 'One rung, decided by whoever gets there first. A week to answer, a reminder after two days. A watch-list supplier, or one flagged "always needs the director", is promoted to the Standard ladder however small the invoice — a one-rung ladder has nowhere to put Finance or the director.',
            seats_label: 'replace-me-team-leads',
            active: true,
        },
        {
            rank: 2, band: 'Standard', min_amount: BAND_STANDARD, max_amount: BAND_BOARD,
            stages_label: 'Team lead → Budget holder → Finance* → Director*',
            rule_note: `Finance joins from €${BAND_FINANCE} or for a watch-list supplier; the director joins from €${BAND_DIRECTOR} or when the supplier is flagged "always needs the director". Rungs marked * are skipped when their condition is not met — and the skip is recorded.`,
            seats_label: 'replace-me-team-leads, replace-me-budget-holders, replace-me-finance, replace-me-director',
            active: true,
        },
        {
            rank: 3, band: 'Board', min_amount: BAND_BOARD, max_amount: null,
            stages_label: 'Team lead → Budget holder → Finance (2 of 3) → Directors (both) → Board*',
            rule_note: `Finance needs two of its three seats; both directors must agree; the board itself only joins from €${BAND_FULL_BOARD}. Two weeks to answer.`,
            seats_label: 'replace-me-team-leads, replace-me-budget-holders, replace-me-finance, replace-me-financial-controller, replace-me-cfo, replace-me-director, replace-me-managing-director, replace-me-board',
            active: true,
        },
        {
            rank: 4, band: 'Blocked supplier', min_amount: null, max_amount: null,
            stages_label: 'Nobody — the invoice is parked',
            rule_note: 'A supplier marked "Blocked — do not pay" never reaches an approver. The invoice goes on hold and the trail says why, because asking someone to approve a payment we have already decided not to make wastes their time and muddies the record.',
            seats_label: '—',
            active: true,
        },
    ],

    tbl_iainv: [
        {
            $id: 'iv_kwartel1', invoice_no: 'INV-2026-0431', supplier: { $ref: 'sup_kwartel' }, supplier_name: 'Kwartel Kantoorservice B.V.',
            invoice_date: '2026-07-02', due_date: '2026-08-01', currency: 'EUR',
            amount_excl_vat: 341, vat_amount: 71.61, amount_total: 412.61,
            cost_center: 'cc_fac', po_number: 'PO-2026-0288', status: 'paid',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Fast track', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-07-03T08:14:00Z',
            decided_by_name: 'Joris Hendriks', decided_at: '2026-07-03T11:02:00Z', decision_note: 'Standing order, nothing unusual.',
            goods_received: true, approved_pay_by: '2026-08-01',
            payment_date: '2026-07-29', payment_reference: 'BATCH-2026-07-29/014', paid_by_name: 'Marieke Doorn', paid_at: '2026-07-29T15:40:00Z',
        },
        {
            $id: 'iv_nord1', invoice_no: 'NF-88213', supplier: { $ref: 'sup_nordfjell' }, supplier_name: 'Nordfjell Energi AS',
            invoice_date: '2026-07-05', due_date: '2026-07-26', currency: 'EUR',
            amount_excl_vat: 2480, vat_amount: 520.8, amount_total: 3000.8,
            cost_center: 'cc_fac', po_number: '', status: 'approved',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Standard', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-07-06T09:20:00Z',
            decided_by_name: 'Marieke Doorn', decided_at: '2026-07-07T16:31:00Z', decision_note: 'Meter readings match the quarterly statement.',
            goods_received: true, approved_pay_by: '2026-07-26',
        },
        {
            $id: 'iv_stroom1', invoice_no: 'SC-2026-114', supplier: { $ref: 'sup_stroomlijn' }, supplier_name: 'Stroomlijn Cloud B.V.',
            invoice_date: '2026-07-08', due_date: '2026-08-07', currency: 'EUR',
            amount_excl_vat: 1450, vat_amount: 304.5, amount_total: 1754.5,
            cost_center: 'cc_it', po_number: 'PO-2026-0301', status: 'in_approval',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Standard', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-08-18T07:55:00Z',
        },
        {
            $id: 'iv_berg1', invoice_no: 'BT-4471', supplier: { $ref: 'sup_bergveld' }, supplier_name: 'Bergveld Techniek B.V.',
            invoice_date: '2026-07-11', due_date: '2026-08-10', currency: 'EUR',
            amount_excl_vat: 6800, vat_amount: 1428, amount_total: 8228,
            cost_center: 'cc_ops', po_number: 'PO-2026-0304', status: 'in_approval',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Standard', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-08-17T13:12:00Z',
            extraction_note: 'The PDF is a scan; the PO number was read from the covering letter rather than the invoice header.',
        },
        {
            $id: 'iv_verm1', invoice_no: 'VK-2026-077', supplier: { $ref: 'sup_vermeer' }, supplier_name: 'Vermeer & Kaptein Advocaten',
            invoice_date: '2026-07-14', due_date: '2026-07-28', currency: 'EUR',
            amount_excl_vat: 3900, vat_amount: 819, amount_total: 4719,
            cost_center: 'cc_fin', po_number: '', status: 'in_approval',
            supplier_risk: 'standard',
            // Under €5,000 — the amount alone would not reach the director.
            // The SUPPLIER lever is what puts the director rung in this chain.
            director_rule: 'always',
            approval_route: 'Standard', submitted_by_name: 'Marieke Doorn', submitted_at: '2026-08-19T10:05:00Z',
        },
        {
            $id: 'iv_march1', invoice_no: 'MC-2026-0090', supplier: { $ref: 'sup_marchetti' }, supplier_name: 'Marchetti Consulting Srl',
            invoice_date: '2026-07-16', due_date: '2026-08-15', currency: 'EUR',
            amount_excl_vat: 12500, vat_amount: 2625, amount_total: 15125,
            cost_center: 'cc_mkt', po_number: '', status: 'rejected',
            supplier_risk: 'watch', director_rule: 'auto',
            approval_route: 'Standard', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-07-17T09:40:00Z',
            decided_by_name: 'Marieke Doorn', decided_at: '2026-07-20T14:22:00Z',
            rejection_reason: 'No purchase order, and the day rate is €150 above the signed retainer. Send it back and ask for a corrected invoice with the PO on it.',
        },
        {
            $id: 'iv_duin1', invoice_no: 'DF-3390', supplier: { $ref: 'sup_duinlicht' }, supplier_name: 'Duinlicht Facilitair B.V.',
            invoice_date: '2026-07-20', due_date: '2026-09-03', currency: 'EUR',
            amount_excl_vat: 890, vat_amount: 186.9, amount_total: 1076.9,
            cost_center: 'cc_fac', po_number: 'PO-2026-0311', status: 'approved',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Standard', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-08-04T08:31:00Z',
            decided_by_name: 'Petra Sanders', decided_at: '2026-08-05T09:12:00Z', decision_note: 'July cleaning hours agree with the roster.',
            goods_received: true, approved_pay_by: '2026-09-03',
        },
        {
            $id: 'iv_kwartel2', invoice_no: 'INV-2026-0502', supplier: { $ref: 'sup_kwartel' }, supplier_name: 'Kwartel Kantoorservice B.V.',
            invoice_date: '2026-07-24', due_date: '2026-08-23', currency: 'EUR',
            amount_excl_vat: 220, vat_amount: 46.2, amount_total: 266.2,
            cost_center: 'cc_ops', po_number: '', status: 'needs_review',
            supplier_risk: 'standard', director_rule: 'auto',
            extraction_note: 'No PO number anywhere on the invoice — check with Operations before sending it on.',
        },
        {
            $id: 'iv_berg2', invoice_no: 'BT-4502', supplier: { $ref: 'sup_bergveld' }, supplier_name: 'Bergveld Techniek B.V.',
            invoice_date: '2026-07-28', due_date: '2026-08-27', currency: 'EUR',
            amount_excl_vat: 28400, vat_amount: 5964, amount_total: 34364,
            cost_center: 'cc_ops', po_number: 'PO-2026-0318', status: 'in_approval',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Board', submitted_by_name: 'Marieke Doorn', submitted_at: '2026-08-14T11:47:00Z',
        },
        {
            $id: 'iv_stroom2', invoice_no: 'SC-2026-131', supplier: { $ref: 'sup_stroomlijn' }, supplier_name: 'Stroomlijn Cloud B.V.',
            invoice_date: '2026-08-01', due_date: '2026-08-31', currency: 'EUR',
            amount_excl_vat: 1450, vat_amount: 304.5, amount_total: 1754.5,
            cost_center: 'cc_it', po_number: 'PO-2026-0301', status: 'approved',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Standard', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-08-06T08:02:00Z',
            decided_by_name: 'Rian de Kort', decided_at: '2026-08-06T15:18:00Z', decision_note: 'Same fixed price as SC-2026-114.',
            goods_received: true, approved_pay_by: '2026-08-31',
        },
        {
            $id: 'iv_haven1', invoice_no: 'HK-2026-0031', supplier: { $ref: 'sup_havenkade' }, supplier_name: 'Havenkade Logistiek B.V.',
            invoice_date: '2026-08-03', due_date: '2026-09-02', currency: 'EUR',
            amount_excl_vat: 1740, vat_amount: 365.4, amount_total: 2105.4,
            cost_center: 'cc_ops', po_number: 'PO-2026-0322', status: 'on_hold',
            // The blocked-supplier branch: no approval was ever requested, and
            // the trail below says so in as many words.
            supplier_risk: 'blocked', director_rule: 'auto',
            approval_route: 'Blocked supplier — parked, nobody asked',
            submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-08-04T09:03:00Z',
            decision_note: 'Bank details on this invoice differ from the account on file. Parked until the change is confirmed by phone on a number we already had.',
        },
        {
            $id: 'iv_nord2', invoice_no: 'NF-88940', supplier: { $ref: 'sup_nordfjell' }, supplier_name: 'Nordfjell Energi AS',
            invoice_date: '2026-08-05', due_date: '2026-08-26', currency: 'EUR',
            amount_excl_vat: 2610, vat_amount: 548.1, amount_total: 3158.1,
            cost_center: 'cc_fac', po_number: '', status: 'in_approval',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Standard', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-08-20T07:41:00Z',
        },
        {
            $id: 'iv_march2', invoice_no: 'MC-2026-0104', supplier: { $ref: 'sup_marchetti' }, supplier_name: 'Marchetti Consulting Srl',
            invoice_date: '2026-08-10', due_date: '2026-09-09', currency: 'EUR',
            amount_excl_vat: 4200, vat_amount: 882, amount_total: 5082,
            cost_center: 'cc_mkt', po_number: '', status: 'draft',
            supplier_risk: 'watch', director_rule: 'auto',
        },
        {
            $id: 'iv_verm2', invoice_no: 'VK-2026-091', supplier: { $ref: 'sup_vermeer' }, supplier_name: 'Vermeer & Kaptein Advocaten',
            invoice_date: '2026-08-12', due_date: '2026-08-26', currency: 'EUR',
            amount_excl_vat: 96000, vat_amount: 20160, amount_total: 116160,
            cost_center: 'cc_fin', po_number: '', status: 'in_approval',
            supplier_risk: 'standard', director_rule: 'always',
            approval_route: 'Board', submitted_by_name: 'Marieke Doorn', submitted_at: '2026-08-13T16:20:00Z',
            extraction_note: 'Settlement instalment. The board rung applies from €100,000, so this one goes all the way up.',
        },
        {
            $id: 'iv_duin2', invoice_no: 'DF-3455', supplier: { $ref: 'sup_duinlicht' }, supplier_name: 'Duinlicht Facilitair B.V.',
            invoice_date: '2026-08-14', due_date: '2026-09-28', currency: 'EUR',
            amount_excl_vat: 640, vat_amount: 134.4, amount_total: 774.4,
            cost_center: 'cc_fac', po_number: 'PO-2026-0329', status: 'scheduled',
            supplier_risk: 'standard', director_rule: 'auto',
            approval_route: 'Fast track', submitted_by_name: 'Ilse Vermaat', submitted_at: '2026-08-15T08:44:00Z',
            decided_by_name: 'Petra Sanders', decided_at: '2026-08-15T12:07:00Z', decision_note: 'Reception cover for the summer weeks.',
            goods_received: true, approved_pay_by: '2026-09-28',
            payment_date: '2026-09-25', payment_reference: 'RUN-2026-09-25',
        },
    ],

    tbl_ialine: [
        { invoice: { $ref: 'iv_kwartel1' }, invoice_no: 'INV-2026-0431', line_no: 1, description: 'A4 paper, 80 gsm, box of 5 reams', quantity: 12, unit_price: 18.5, line_total: 222, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4310' },
        { invoice: { $ref: 'iv_kwartel1' }, invoice_no: 'INV-2026-0431', line_no: 2, description: 'Toner cartridge, black', quantity: 2, unit_price: 59.5, line_total: 119, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4310' },
        { invoice: { $ref: 'iv_nord1' }, invoice_no: 'NF-88213', line_no: 1, description: 'Electricity, June 2026, 18,400 kWh', quantity: 18400, unit_price: 0.11, line_total: 2024, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4210' },
        { invoice: { $ref: 'iv_nord1' }, invoice_no: 'NF-88213', line_no: 2, description: 'District heating, June 2026', quantity: 1, unit_price: 456, line_total: 456, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4210' },
        { invoice: { $ref: 'iv_stroom1' }, invoice_no: 'SC-2026-114', line_no: 1, description: 'Managed hosting, Q3 2026', quantity: 1, unit_price: 950, line_total: 950, vat_rate: 21, cost_center: 'cc_it', gl_account: '4510' },
        { invoice: { $ref: 'iv_stroom1' }, invoice_no: 'SC-2026-114', line_no: 2, description: 'Seat licences, 25 seats, July 2026', quantity: 25, unit_price: 20, line_total: 500, vat_rate: 21, cost_center: 'cc_it', gl_account: '4520' },
        { invoice: { $ref: 'iv_berg1' }, invoice_no: 'BT-4471', line_no: 1, description: 'Annual overhaul, line 2 — labour', quantity: 64, unit_price: 82.5, line_total: 5280, vat_rate: 21, cost_center: 'cc_ops', gl_account: '4120' },
        { invoice: { $ref: 'iv_berg1' }, invoice_no: 'BT-4471', line_no: 2, description: 'Replacement bearings and seals', quantity: 1, unit_price: 1220, line_total: 1220, vat_rate: 21, cost_center: 'cc_ops', gl_account: '4130' },
        { invoice: { $ref: 'iv_berg1' }, invoice_no: 'BT-4471', line_no: 3, description: 'Travel and call-out', quantity: 4, unit_price: 75, line_total: 300, vat_rate: 21, cost_center: 'cc_ops', gl_account: '4140' },
        { invoice: { $ref: 'iv_verm1' }, invoice_no: 'VK-2026-077', line_no: 1, description: 'Advice on the Havenkade contract — 13 hours', quantity: 13, unit_price: 300, line_total: 3900, vat_rate: 21, cost_center: 'cc_fin', gl_account: '4610' },
        { invoice: { $ref: 'iv_march1' }, invoice_no: 'MC-2026-0090', line_no: 1, description: 'Brand positioning workshop — 10 days', quantity: 10, unit_price: 1250, line_total: 12500, vat_rate: 21, cost_center: 'cc_mkt', gl_account: '4710' },
        { invoice: { $ref: 'iv_duin1' }, invoice_no: 'DF-3390', line_no: 1, description: 'Cleaning, July 2026', quantity: 1, unit_price: 640, line_total: 640, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4230' },
        { invoice: { $ref: 'iv_duin1' }, invoice_no: 'DF-3390', line_no: 2, description: 'Reception cover, 10 hours', quantity: 10, unit_price: 25, line_total: 250, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4240' },
        { invoice: { $ref: 'iv_kwartel2' }, invoice_no: 'INV-2026-0502', line_no: 1, description: 'Workwear, size L, 10 sets', quantity: 10, unit_price: 22, line_total: 220, vat_rate: 21, cost_center: 'cc_ops', gl_account: '4320' },
        { invoice: { $ref: 'iv_berg2' }, invoice_no: 'BT-4502', line_no: 1, description: 'Line 3 conveyor replacement — parts', quantity: 1, unit_price: 21800, line_total: 21800, vat_rate: 21, cost_center: 'cc_ops', gl_account: '4130' },
        { invoice: { $ref: 'iv_berg2' }, invoice_no: 'BT-4502', line_no: 2, description: 'Installation and commissioning', quantity: 66, unit_price: 100, line_total: 6600, vat_rate: 21, cost_center: 'cc_ops', gl_account: '4120' },
        { invoice: { $ref: 'iv_stroom2' }, invoice_no: 'SC-2026-131', line_no: 1, description: 'Managed hosting, Q3 2026 (second instalment)', quantity: 1, unit_price: 950, line_total: 950, vat_rate: 21, cost_center: 'cc_it', gl_account: '4510' },
        { invoice: { $ref: 'iv_stroom2' }, invoice_no: 'SC-2026-131', line_no: 2, description: 'Seat licences, 25 seats, August 2026', quantity: 25, unit_price: 20, line_total: 500, vat_rate: 21, cost_center: 'cc_it', gl_account: '4520' },
        { invoice: { $ref: 'iv_haven1' }, invoice_no: 'HK-2026-0031', line_no: 1, description: 'Groupage transport, week 30–31', quantity: 1, unit_price: 1740, line_total: 1740, vat_rate: 21, cost_center: 'cc_ops', gl_account: '4410' },
        { invoice: { $ref: 'iv_nord2' }, invoice_no: 'NF-88940', line_no: 1, description: 'Electricity, July 2026, 19,600 kWh', quantity: 19600, unit_price: 0.11, line_total: 2156, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4210' },
        { invoice: { $ref: 'iv_nord2' }, invoice_no: 'NF-88940', line_no: 2, description: 'District heating, July 2026', quantity: 1, unit_price: 454, line_total: 454, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4210' },
        { invoice: { $ref: 'iv_verm2' }, invoice_no: 'VK-2026-091', line_no: 1, description: 'Settlement instalment — Havenkade dispute', quantity: 1, unit_price: 92000, line_total: 92000, vat_rate: 21, cost_center: 'cc_fin', gl_account: '4620' },
        { invoice: { $ref: 'iv_verm2' }, invoice_no: 'VK-2026-091', line_no: 2, description: 'Court and bailiff fees', quantity: 1, unit_price: 4000, line_total: 4000, vat_rate: 21, cost_center: 'cc_fin', gl_account: '4630' },
        { invoice: { $ref: 'iv_duin2' }, invoice_no: 'DF-3455', line_no: 1, description: 'Reception cover, summer weeks', quantity: 32, unit_price: 20, line_total: 640, vat_rate: 21, cost_center: 'cc_fac', gl_account: '4240' },
    ],

    tbl_iaevt: [
        { invoice: { $ref: 'iv_kwartel1' }, invoice_no: 'INV-2026-0431', at: '2026-07-03T08:02:00Z', actor: 'Ilse Vermaat', kind: 'uploaded', detail: 'INV-2026-0431.pdf' },
        { invoice: { $ref: 'iv_kwartel1' }, invoice_no: 'INV-2026-0431', at: '2026-07-03T08:04:00Z', actor: 'Ilse Vermaat', kind: 'extracted', detail: 'Header and 2 lines read from the PDF.' },
        { invoice: { $ref: 'iv_kwartel1' }, invoice_no: 'INV-2026-0431', at: '2026-07-03T08:14:00Z', actor: 'Ilse Vermaat', kind: 'submitted', detail: 'Fast track · Team lead' },
        { invoice: { $ref: 'iv_kwartel1' }, invoice_no: 'INV-2026-0431', at: '2026-07-03T11:02:00Z', actor: 'Joris Hendriks', kind: 'decided', detail: 'Approved · Standing order, nothing unusual.' },
        { invoice: { $ref: 'iv_kwartel1' }, invoice_no: 'INV-2026-0431', at: '2026-07-29T15:40:00Z', actor: 'Marieke Doorn', kind: 'paid', detail: 'BATCH-2026-07-29/014' },
        { invoice: { $ref: 'iv_nord1' }, invoice_no: 'NF-88213', at: '2026-07-06T09:20:00Z', actor: 'Ilse Vermaat', kind: 'submitted', detail: 'Standard · Team lead → Budget holder → Finance' },
        { invoice: { $ref: 'iv_nord1' }, invoice_no: 'NF-88213', at: '2026-07-07T16:31:00Z', actor: 'Marieke Doorn', kind: 'decided', detail: 'Approved · Meter readings match the quarterly statement.' },
        { invoice: { $ref: 'iv_stroom1' }, invoice_no: 'SC-2026-114', at: '2026-08-18T07:55:00Z', actor: 'Ilse Vermaat', kind: 'submitted', detail: 'Standard · Finance rung skipped (under €2,500, standard supplier)' },
        { invoice: { $ref: 'iv_berg1' }, invoice_no: 'BT-4471', at: '2026-08-17T13:05:00Z', actor: 'Ilse Vermaat', kind: 'edited', detail: 'PO number corrected by hand — the scan lost it.' },
        { invoice: { $ref: 'iv_berg1' }, invoice_no: 'BT-4471', at: '2026-08-17T13:12:00Z', actor: 'Ilse Vermaat', kind: 'submitted', detail: 'Standard · Director rung applies (€8,228 is over €5,000)' },
        { invoice: { $ref: 'iv_verm1' }, invoice_no: 'VK-2026-077', at: '2026-08-19T10:05:00Z', actor: 'Marieke Doorn', kind: 'submitted', detail: 'Standard · Director rung applies (supplier is flagged "always needs the director")' },
        { invoice: { $ref: 'iv_march1' }, invoice_no: 'MC-2026-0090', at: '2026-07-17T09:40:00Z', actor: 'Ilse Vermaat', kind: 'submitted', detail: 'Standard · Finance rung applies (watch-list supplier)' },
        { invoice: { $ref: 'iv_march1' }, invoice_no: 'MC-2026-0090', at: '2026-07-20T14:22:00Z', actor: 'Marieke Doorn', kind: 'decided', detail: 'Rejected · No purchase order, and the day rate is above the signed retainer.' },
        { invoice: { $ref: 'iv_duin1' }, invoice_no: 'DF-3390', at: '2026-08-05T09:12:00Z', actor: 'Petra Sanders', kind: 'decided', detail: 'Approved · July cleaning hours agree with the roster.' },
        { invoice: { $ref: 'iv_kwartel2' }, invoice_no: 'INV-2026-0502', at: '2026-07-25T10:10:00Z', actor: 'Ilse Vermaat', kind: 'extracted', detail: 'Header read; no PO number found anywhere on the invoice.' },
        { invoice: { $ref: 'iv_berg2' }, invoice_no: 'BT-4502', at: '2026-08-14T11:47:00Z', actor: 'Marieke Doorn', kind: 'submitted', detail: 'Board · Board rung skipped (€34,364 is under €100,000)' },
        { invoice: { $ref: 'iv_haven1' }, invoice_no: 'HK-2026-0031', at: '2026-08-04T09:03:00Z', actor: 'Ilse Vermaat', kind: 'hold', detail: 'Supplier is blocked — no approval requested. Bank details on the invoice differ from the account on file.' },
        { invoice: { $ref: 'iv_nord2' }, invoice_no: 'NF-88940', at: '2026-08-20T07:41:00Z', actor: 'Ilse Vermaat', kind: 'submitted', detail: 'Standard · Finance rung applies (€3,158 is over €2,500)' },
        { invoice: { $ref: 'iv_march2' }, invoice_no: 'MC-2026-0104', at: '2026-08-21T15:02:00Z', actor: 'Ilse Vermaat', kind: 'uploaded', detail: 'MC-2026-0104.pdf — not read yet.' },
        { invoice: { $ref: 'iv_verm2' }, invoice_no: 'VK-2026-091', at: '2026-08-13T16:20:00Z', actor: 'Marieke Doorn', kind: 'submitted', detail: 'Board · every rung including the board (€116,160)' },
        { invoice: { $ref: 'iv_duin2' }, invoice_no: 'DF-3455', at: '2026-08-15T12:07:00Z', actor: 'Petra Sanders', kind: 'decided', detail: 'Approved · Reception cover for the summer weeks.' },
        { invoice: { $ref: 'iv_duin2' }, invoice_no: 'DF-3455', at: '2026-08-15T12:20:00Z', actor: 'Marieke Doorn', kind: 'note', detail: 'Scheduled for the payment run of 25 September — 45-day terms.' },
    ],
};

// ---------------------------------------------------------------------------
// Binding helpers.
//
// `vars.invoice` is the SELECTION and nothing more: only its `id` is ever
// read, and every value on the invoice screen comes from a live read of the
// row through openInvoice(). That is what makes a decision that lands while
// you are looking at the screen appear on the next refetch instead of leaving
// a stale copy from the moment you clicked.
//
// A binding's filter formula may only read currentUser / vars / forms /
// screen / today — anything else diverges the fetch and read cache keys and
// the component loads forever.
// ---------------------------------------------------------------------------

const INVOICE_SCOPE = [
    { field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.invoice.id' }, required: true },
];

/** The open invoice's whole row, or one column of it. */
const openInvoice = (path) => (path
    ? { kind: 'record', tableId: 'tbl_iainv', filter: INVOICE_SCOPE, limit: 1, path }
    : { kind: 'record', tableId: 'tbl_iainv', filter: INVOICE_SCOPE, limit: 1 });

/** Rows of a child table belonging to the open invoice. */
const forOpenInvoice = (tableId, sort, limit) => ({
    kind: 'records',
    tableId,
    filter: [{ field: 'invoice', op: 'eq', value: { kind: 'formula', expr: 'vars.invoice.id' }, required: true }],
    sort,
    limit,
});

/** A count of invoices matching one extra clause. Always limited. */
const invoiceCount = (filter) => ({
    kind: 'aggregate',
    tableId: 'tbl_iainv',
    aggregates: [{ fn: 'count', field: '*', as: 'n' }],
    filter,
    limit: 1,
});

/** The money behind that count — the number an AP manager actually reports. */
const invoiceSum = (filter) => ({
    kind: 'aggregate',
    tableId: 'tbl_iainv',
    aggregates: [{ fn: 'sum', field: 'amount_total', as: 'value' }],
    filter,
    limit: 1,
    pick: { row: 'first', column: 'value' },
});

// ---------------------------------------------------------------------------
// The routing expressions.
//
// Both read `form.*` rather than the invoice row, and that is not a shortcut:
// a request_approval step runs SERVER-side, where the scope pins `records` to
// {} — a formula there cannot read a table. Putting the levers on the
// send-for-approval form is also the better product: the person sending an
// invoice up the ladder confirms the number that is about to be approved,
// which is the last cheap moment to catch a mis-read total.
// ---------------------------------------------------------------------------

/**
 * The two tests the flow-level switch is built from, written once so the
 * switch, the label on the record and the on-screen preview cannot drift.
 * `scope` is 'form' inside an action and 'forms.send' for a component reading
 * the same form from elsewhere on the screen.
 *
 * Note that the STANDARD test reads the supplier levers as well as the
 * amount: a €400 invoice from a watch-list supplier, or from one flagged
 * "always needs the director", is promoted off the one-rung fast track — a
 * ladder with no Finance and no Director rung on it has nowhere to put them,
 * which is precisely why this decision belongs at the flow level and not in a
 * stage condition.
 */
const isBoardBand = (scope) => `number(${scope}.amount_total) >= ${BAND_BOARD}`;
const isStandardBand = (scope) => `(number(${scope}.amount_total) >= ${BAND_STANDARD} || ${scope}.supplier_check === 'watch' || ${scope}.director_rule === 'always')`;

/** Which chain the switch picks. Total: every amount, missing included, lands in a case. */
const ROUTE_KEY_EXPR = `${isBoardBand('form')} ? 'board' : (${isStandardBand('form')} ? 'standard' : 'fast')`;

/** The same decision, as the label written onto the invoice and shown in the grid. */
const ROUTE_LABEL_EXPR = `${isBoardBand('form')} ? 'Board' : (${isStandardBand('form')} ? 'Standard' : 'Fast track')`;

// ---------------------------------------------------------------------------
// The approval chains.
//
// Factories, not constants: a definition that used the same object twice would
// still serialise correctly, but a chain is the kind of thing an author edits
// in one branch and is then surprised to find changed in another.
//
// PER-STAGE `when` lives here. Every condition reads the same two levers the
// switch reads, and every one of them is a rung that belongs to THIS ladder
// and is sometimes not needed — which is exactly the case `when` is for.
// A stage whose condition is false is kept and marked `skipped`, so the
// finished approval still answers "why did this never reach Finance?".
// ---------------------------------------------------------------------------

/**
 * The questions the approver answers as they decide. Two, deliberately: an
 * approval is a decision, not a form, and these are the only two things the
 * person deciding is the only one who can answer. Both land on the invoice as
 * columns through the on_decided hook rather than as prose in a comment.
 */
const APPROVAL_QUESTIONS = [
    {
        name: 'goods_received', type: 'checkbox',
        label: 'The goods or services on this invoice were received as ordered',
        help: 'Leave this unticked and say why in the note if you are approving on trust.',
    },
    {
        name: 'pay_by', type: 'date',
        label: 'Pay no later than',
        help: 'Defaults to nothing — set it when the supplier’s terms are shorter than ours, or when a discount depends on it.',
    },
];

/**
 * What the record learns when the chain finishes, whichever way it finishes.
 * Snapshotted at request time and executed inside the decision as the app
 * OWNER, so an approver who is not the owner still flips the invoice.
 *
 * `expired` and `cancelled` deliberately do NOT invent a decision: they send
 * the invoice back to 'needs_review' with a note saying which of the two it
 * was, because "nobody answered" and "somebody said no" are different facts.
 */
const onDecidedHook = () => ({
    tableId: 'tbl_iainv',
    recordId: { kind: 'formula', expr: 'vars.invoice.id' },
    set: {
        approved: {
            status: 'approved',
            decided_by_name: '{{decidedByName}}',
            decided_at: '{{decidedAt}}',
            decision_note: '{{reason}}',
            // An exact "{{path}}" resolves to the RAW value, so a checkbox
            // stays a boolean and a date stays a date instead of arriving as
            // the string "true".
            goods_received: '{{answers.goods_received}}',
            approved_pay_by: '{{answers.pay_by}}',
            // A re-submitted invoice that was rejected once must not keep the
            // old reason next to a green status.
            rejection_reason: null,
        },
        rejected: {
            status: 'rejected',
            decided_by_name: '{{decidedByName}}',
            decided_at: '{{decidedAt}}',
            rejection_reason: '{{reason}}',
        },
        expired: {
            status: 'needs_review',
            decision_note: 'Nobody decided before the deadline — the request expired and the invoice came back for review.',
        },
        cancelled: {
            status: 'needs_review',
            decision_note: 'The approval request was withdrawn — the invoice came back for review.',
        },
    },
});

/** Band 1 — under €1,000. One rung; anything more is ceremony. */
const STAGES_FAST = () => ([
    {
        key: 'lead', name: 'Team lead',
        description: 'Confirm we ordered this and the amount looks right.',
        approvers: [SEAT_TEAM_LEAD], rule: 'first',
    },
]);

/**
 * Band 2 — €1,000 up to €25,000. Four authored rungs, two of them conditional.
 * This is the chain the owner described: "over €5,000 also needs the
 * director", written as a `when` on the director rung rather than as a second
 * branch, because it is the SAME ladder with one more step on it.
 */
const STAGES_STANDARD = () => ([
    {
        key: 'lead', name: 'Team lead',
        description: 'Confirm we ordered this and the amount looks right.',
        approvers: [SEAT_TEAM_LEAD], rule: 'first',
    },
    {
        key: 'budget', name: 'Budget holder',
        description: 'Confirm the cost centre and that there is budget left for it.',
        approvers: [SEAT_BUDGET_HOLDER], rule: 'first',
    },
    {
        key: 'finance', name: 'Finance',
        description: 'Check the coding, the VAT and the supplier’s bank details against the account on file.',
        // Two seats, whoever is at their desk first.
        approvers: [SEAT_FINANCE, SEAT_CONTROLLER], rule: 'first',
        // PER-STAGE ROUTING #1 — the amount, and the supplier.
        when: `number(form.amount_total) >= ${BAND_FINANCE} || form.supplier_check === 'watch'`,
    },
    {
        key: 'director', name: 'Director',
        description: 'Sign off the commitment.',
        approvers: [SEAT_DIRECTOR], rule: 'first',
        // PER-STAGE ROUTING #2 — the owner's own sentence, in one line:
        // over €5,000, OR whenever the supplier is flagged as one that always
        // goes to the director (external counsel, say).
        when: `number(form.amount_total) >= ${BAND_DIRECTOR} || form.director_rule === 'always'`,
    },
]);

/**
 * Band 3 — €25,000 and up. Five rungs, and a different SHAPE rather than a
 * longer version of the same one: Finance votes as a quorum, both directors
 * must agree, and the board joins only for the genuinely large ones. That
 * shape change is why this is a separate branch of the switch and not three
 * more conditions on the standard chain.
 */
const STAGES_BOARD = () => ([
    {
        key: 'lead', name: 'Team lead',
        description: 'Confirm we ordered this and the amount looks right.',
        approvers: [SEAT_TEAM_LEAD], rule: 'first',
    },
    {
        key: 'budget', name: 'Budget holder',
        description: 'Confirm the cost centre and that there is budget left for it.',
        approvers: [SEAT_BUDGET_HOLDER], rule: 'first',
    },
    {
        key: 'finance', name: 'Finance — two of three',
        description: 'Coding, VAT, bank details and the contract behind the commitment.',
        approvers: [SEAT_FINANCE, SEAT_CONTROLLER, SEAT_CFO], rule: 'quorum', quorum: 2,
    },
    {
        key: 'directors', name: 'Both directors',
        description: 'A commitment of this size is signed by both, not by whoever is nearest.',
        approvers: [SEAT_DIRECTOR, SEAT_MD], rule: 'all',
    },
    {
        key: 'board', name: 'Board',
        description: 'Reserved for the very large ones.',
        approvers: [SEAT_BOARD], rule: 'first',
        // PER-STAGE ROUTING #3 — a rung most invoices in this band skip.
        when: `number(form.amount_total) >= ${BAND_FULL_BOARD}`,
    },
]);

/**
 * The markdown an approver reads before deciding. Built with concat() because
 * App Studio has no `{{…}}` templating on the app side — every dynamic value
 * is an explicit binding, and a formula is how you interpolate one.
 */
const DETAILS_EXPR = "concat("
    + "'**', default(form.supplier_name, 'Unknown supplier'), '** — invoice **', default(form.invoice_no, '(no number)'), '**\\n\\n',"
    + "'| | |\\n|---|---|\\n',"
    + "'| Total | ', default(form.currency, 'EUR'), ' ', toStr(default(form.amount_total, 0)), ' |\\n',"
    + "'| Cost centre | ', default(form.cost_center, '—'), ' |\\n',"
    + "'| Supplier check | ', default(form.supplier_check, 'standard'), ' |\\n',"
    + "'| Director rule | ', default(form.director_rule, 'auto'), ' |\\n\\n',"
    + "default(form.submit_note, ''))";

/**
 * One request_approval step, differing only in its chain and its clocks. The
 * prompt, the details, the questions, the attachment, the context and the
 * on_decided hook are the same whichever ladder the invoice is on — a
 * decision is a decision.
 */
const approvalStep = (routeLabel, stages, expiresInHours, remindAfterHours) => ({
    kind: 'request_approval',
    prompt: {
        kind: 'formula',
        expr: "concat('Approve payment of ', default(form.currency, 'EUR'), ' ', toStr(default(form.amount_total, 0)), ' to ', default(form.supplier_name, 'this supplier'), ' — invoice ', default(form.invoice_no, '(no number)'), '?')",
    },
    details: { kind: 'formula', expr: DETAILS_EXPR },
    fields: APPROVAL_QUESTIONS,
    // stages ONLY — setting assigneeUserId / approverUserIds /
    // finalApproverUserId / escalateTo* alongside them is
    // action.approval_stages_conflict, and rightly so: it would leave a
    // configured approver nobody ever asks.
    stages,
    expiresInHours,
    remindAfterHours,
    // The PDF travels with the request, so an approver decides on the document
    // rather than on somebody's summary of it.
    //
    // A FORMULA, not a record binding: a server step resolves only static /
    // field / formula bindings (buildServerScope pins `records` to {}), so a
    // {kind:'record'} here would silently resolve to null and the approver
    // would get a request with no invoice attached. `vars.invoice` carries the
    // whole row — every route into the invoice screen publishes it that way.
    attachments: { kind: 'formula', expr: 'vars.invoice.document' },
    context: {
        invoice_id: { kind: 'formula', expr: 'vars.invoice.id' },
        invoice_no: { kind: 'formula', expr: 'form.invoice_no' },
        supplier: { kind: 'formula', expr: 'form.supplier_name' },
        amount: { kind: 'formula', expr: 'form.amount_total' },
        route: { kind: 'static', value: routeLabel },
    },
    onDecided: onDecidedHook(),
    resultVar: 'approval',
});

/**
 * Copy the two policy levers off the picked supplier onto the invoice.
 *
 * There are no joins in a records binding, so the routing cannot follow the
 * relation at request time — the values have to LIVE on the invoice. This
 * loop is how they get there: `records.<tableId>` is the client-side row
 * cache, and a `loop` is a client step, so it resolves. Both screens that use
 * it put a suppliers grid on the same screen, which is what fills that cache.
 */
const copySupplierLevers = (formField, recordIdExpr = 'vars.invoice.id') => ({
    kind: 'loop',
    source: { kind: 'formula', expr: 'records.tbl_iasup' },
    itemVar: 'sup',
    maxIterations: 100,
    steps: [
        {
            kind: 'condition',
            expr: `vars.sup.id === form.${formField}`,
            then: [
                {
                    kind: 'update_record', tableId: 'tbl_iainv',
                    recordId: { kind: 'formula', expr: recordIdExpr },
                    values: {
                        supplier: { kind: 'formula', expr: 'vars.sup.id' },
                        supplier_name: { kind: 'formula', expr: 'vars.sup.name' },
                        supplier_risk: { kind: 'formula', expr: "default(vars.sup.risk, 'standard')" },
                        director_rule: { kind: 'formula', expr: "vars.sup.always_director ? 'always' : 'auto'" },
                    },
                },
            ],
        },
    ],
});

/**
 * One append-only trail row. Every action that changes an invoice writes one.
 *
 * Both references are FORMULAS over the action scope for the same reason the
 * attachment is: a create_record step runs server-side, where a record
 * binding resolves to null. `invoice_no` is denormalised onto the trail row
 * because there is no join to follow later, and a trail whose rows can only
 * say "rec_9f3c…" is not a trail anybody reads.
 */
const trailStep = (kind, detailExpr, {
    recordIdExpr = 'vars.invoice.id',
    invoiceNoExpr = 'vars.invoice.invoice_no',
} = {}) => ({
    kind: 'create_record', tableId: 'tbl_iaevt',
    values: {
        invoice: { kind: 'formula', expr: recordIdExpr },
        invoice_no: { kind: 'formula', expr: invoiceNoExpr },
        at: { kind: 'formula', expr: 'now' },
        actor: { kind: 'formula', expr: 'currentUser.name' },
        kind: { kind: 'static', value: kind },
        detail: typeof detailExpr === 'string'
            ? { kind: 'formula', expr: detailExpr }
            : detailExpr,
    },
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** One single-column inline commit for a data_grid cell edit. */
const cellCommit = (tableId, column, { numeric = false, bool = false } = {}) => ({
    value: column,
    steps: [{
        kind: 'update_record', tableId,
        recordId: { kind: 'formula', expr: 'form.id' },
        // Compare-and-set: two people editing the SAME cell no longer clobber
        // each other — the second write is refused instead of winning silently.
        expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
        values: {
            // A number cell commits '' when emptied. The STRICT comparison
            // matters: 0 == '' is true, so a loose test would null out a
            // legitimate zero.
            [column]: numeric
                ? { kind: 'formula', expr: `form.${column} === '' ? null : form.${column}` }
                : (bool
                    ? { kind: 'formula', expr: `form.${column} === true || form.${column} === 'true'` }
                    : { kind: 'formula', expr: `form.${column}` }),
        },
    }],
});

const actions = {
    // ── getting around ────────────────────────────────────────────────────
    /**
     * Open an invoice. `item` is the whole row, and publishing it BEFORE the
     * jump matters twice: the screen would otherwise render the previous
     * invoice for a frame, and the send-for-approval step reads
     * `vars.invoice.document` for the attachment.
     */
    act_iaopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'invoice', value: { kind: 'formula', expr: 'item' } },
            { kind: 'navigate', screenId: 'scr_iadetail' },
        ],
    },
    act_iaback: { kind: 'navigate', screenId: 'scr_iainvs' },
    act_iagonew: { kind: 'navigate', screenId: 'scr_iaintake' },
    act_iagoappr: { kind: 'navigate', screenId: 'scr_iaappr' },
    act_iagopay: { kind: 'navigate', screenId: 'scr_iapay' },
    act_iagopol: { kind: 'navigate', screenId: 'scr_iapol' },
    act_iarefresh: { kind: 'sequence', steps: [{ kind: 'refresh' }, { kind: 'toast', message: 'Reloaded.', tone: 'info' }] },

    /** Hand the stored PDF straight to the browser — no detour via a link. */
    act_iadl: {
        kind: 'sequence',
        steps: [{
            kind: 'download_file',
            file: { kind: 'formula', expr: 'vars.invoice.document' },
            fileName: { kind: 'formula', expr: "concat(default(vars.invoice.invoice_no, 'invoice'), '.pdf')" },
        }],
    },

    // ── intake: the PDF becomes an invoice ────────────────────────────────
    /**
     * Two extractions rather than one. The header is a single row and wants a
     * tight prompt; the lines are a table and want a different one, with the
     * header as promptContext so a line can be checked against the total it is
     * supposed to add up to. One combined schema would return an array of
     * objects nested in an object, which aiSchema cannot describe.
     */
    act_iaread: {
        kind: 'sequence',
        steps: [
            {
                kind: 'ai_extract',
                source: { kind: 'formula', expr: 'form.document' },
                // 'auto': a supplier invoice is a text PDF nine times out of
                // ten and rendering pages for those is money for nothing;
                // 'auto' still falls back to images for a scan.
                documentMode: 'auto',
                promptContext: { kind: 'static', value: 'This is ONE supplier invoice — a bill this company has to pay. Return exactly one row. Amounts are decimal numbers without currency symbols or thousands separators. amount_total is the gross amount payable including VAT; amount_excl_vat is the net. Dates are ISO (YYYY-MM-DD). If a value is genuinely not on the document, leave it out rather than guessing, and say what was missing in extraction_note.' },
                schema: [
                    { name: 'supplier_name', type: 'string', description: 'The name of the company sending the invoice (the payee), exactly as printed', required: true },
                    { name: 'invoice_no', type: 'string', description: 'The invoice number the supplier gave it', required: true },
                    { name: 'invoice_date', type: 'date', description: 'The invoice date' },
                    { name: 'due_date', type: 'date', description: 'The payment due date, or the invoice date plus the stated payment term' },
                    { name: 'currency', type: 'string', description: 'Three-letter currency code: EUR, USD or GBP. Use EUR when the document shows € or says euro.' },
                    { name: 'amount_excl_vat', type: 'number', description: 'Net total, excluding VAT' },
                    { name: 'vat_amount', type: 'number', description: 'The VAT amount' },
                    { name: 'amount_total', type: 'number', description: 'Gross total payable, including VAT', required: true },
                    { name: 'po_number', type: 'string', description: 'Purchase order number, if the invoice quotes one' },
                    { name: 'extraction_note', type: 'string', description: 'Anything you could not read or had to infer — one short sentence, empty if the invoice was clean' },
                ],
                modelTier: 'thinking',
                knowledgeBaseIds: [],
                resultVar: 'head',
            },
            {
                kind: 'create_record', tableId: 'tbl_iainv', resultVar: 'inv',
                values: {
                    invoice_no: { kind: 'formula', expr: 'vars.head.rows[0].invoice_no' },
                    supplier: { kind: 'formula', expr: 'form.supplier' },
                    supplier_name: { kind: 'formula', expr: 'vars.head.rows[0].supplier_name' },
                    invoice_date: { kind: 'formula', expr: 'vars.head.rows[0].invoice_date' },
                    due_date: { kind: 'formula', expr: 'vars.head.rows[0].due_date' },
                    // aiSchema has no enum support, so the vocabulary is
                    // enforced HERE rather than hoped for in the prompt: an
                    // off-vocabulary answer becomes EUR instead of a select
                    // value nothing can render.
                    currency: { kind: 'formula', expr: "vars.head.rows[0].currency === 'USD' ? 'USD' : (vars.head.rows[0].currency === 'GBP' ? 'GBP' : 'EUR')" },
                    amount_excl_vat: { kind: 'formula', expr: 'vars.head.rows[0].amount_excl_vat' },
                    vat_amount: { kind: 'formula', expr: 'vars.head.rows[0].vat_amount' },
                    amount_total: { kind: 'formula', expr: 'vars.head.rows[0].amount_total' },
                    po_number: { kind: 'formula', expr: 'vars.head.rows[0].po_number' },
                    cost_center: { kind: 'formula', expr: 'form.cost_center' },
                    extraction_note: { kind: 'formula', expr: 'vars.head.rows[0].extraction_note' },
                    document: { kind: 'formula', expr: 'form.document' },
                    // 'needs_review', never 'in_approval': a machine read it,
                    // a person has not looked at it yet, and the difference is
                    // the whole reason this screen exists.
                    status: { kind: 'static', value: 'needs_review' },
                },
            },
            // The routing levers, copied off the supplier the clerk picked.
            copySupplierLevers('supplier', 'vars.inv.id'),
            {
                kind: 'ai_extract',
                source: { kind: 'formula', expr: 'form.document' },
                documentMode: 'auto',
                // The header travels with the line prompt: a line total that
                // does not fit the invoice total is the single most useful
                // thing a second pass can notice.
                promptContext: { kind: 'formula', expr: 'vars.head' },
                schema: [
                    { name: 'line_no', type: 'number', description: 'Position number of the line on the invoice, counting from 1' },
                    { name: 'description', type: 'string', description: 'What the line is for, as printed', required: true },
                    { name: 'quantity', type: 'number', description: 'Quantity billed' },
                    { name: 'unit_price', type: 'number', description: 'Price per unit, excluding VAT' },
                    { name: 'line_total', type: 'number', description: 'Line total excluding VAT' },
                    { name: 'vat_rate', type: 'number', description: 'VAT percentage for this line, as a number (21, 9, 0)' },
                ],
                modelTier: 'thinking',
                knowledgeBaseIds: [],
                writeTo: {
                    tableId: 'tbl_ialine',
                    mapping: {
                        line_no: 'line_no',
                        description: 'description',
                        quantity: 'quantity',
                        unit_price: 'unit_price',
                        line_total: 'line_total',
                        vat_rate: 'vat_rate',
                    },
                    constants: {
                        invoice: { kind: 'formula', expr: 'vars.inv.id' },
                        invoice_no: { kind: 'formula', expr: 'vars.head.rows[0].invoice_no' },
                    },
                },
                resultVar: 'lines',
            },
            trailStep('uploaded', "concat('Uploaded ', default(vars.head.rows[0].invoice_no, 'an invoice'), '.')",
                { recordIdExpr: 'vars.inv.id', invoiceNoExpr: 'vars.head.rows[0].invoice_no' }),
            trailStep('extracted', "concat('Read by AI: header plus ', toStr(default(vars.lines.count, 0)), ' line(s).')",
                { recordIdExpr: 'vars.inv.id', invoiceNoExpr: 'vars.head.rows[0].invoice_no' }),
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_ialine' },
            {
                // Re-read the row we just created so `vars.invoice` carries the
                // WHOLE invoice — the file descriptor included, which the
                // approval attachment needs. set_variable is a client step, so
                // a record binding really does resolve here.
                kind: 'set_variable', name: 'invoice',
                value: {
                    kind: 'record', tableId: 'tbl_iainv', limit: 1,
                    filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.inv.id' }, required: true }],
                },
            },
            { kind: 'reset_form', form: 'intake' },
            { kind: 'toast', message: 'Invoice read and filed — check what the AI could not read before you send it on.', tone: 'success' },
            { kind: 'navigate', screenId: 'scr_iadetail' },
        ],
    },

    // ── correcting what the AI read ───────────────────────────────────────
    act_iasave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record', tableId: 'tbl_iainv',
                recordId: { kind: 'formula', expr: 'vars.invoice.id' },
                values: {
                    invoice_no: { kind: 'formula', expr: 'form.invoice_no' },
                    invoice_date: { kind: 'formula', expr: 'form.invoice_date' },
                    due_date: { kind: 'formula', expr: 'form.due_date' },
                    currency: { kind: 'formula', expr: 'form.currency' },
                    amount_excl_vat: { kind: 'formula', expr: "form.amount_excl_vat === '' ? null : form.amount_excl_vat" },
                    vat_amount: { kind: 'formula', expr: "form.vat_amount === '' ? null : form.vat_amount" },
                    amount_total: { kind: 'formula', expr: "form.amount_total === '' ? null : form.amount_total" },
                    cost_center: { kind: 'formula', expr: 'form.cost_center' },
                    po_number: { kind: 'formula', expr: 'form.po_number' },
                    extraction_note: { kind: 'formula', expr: 'form.extraction_note' },
                },
            },
            trailStep('edited', { kind: 'static', value: 'Invoice header corrected by hand.' }),
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_iaevt' },
            { kind: 'toast', message: 'Saved.', tone: 'success' },
        ],
    },

    /** Link (or re-link) the supplier, and take its two policy levers with it. */
    act_iasetsup: {
        kind: 'sequence',
        steps: [
            copySupplierLevers('supplier'),
            trailStep('edited', { kind: 'static', value: 'Supplier linked — the supplier check and the director rule were copied from the supplier master.' }),
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_iaevt' },
            { kind: 'toast', message: 'Supplier linked.', tone: 'success' },
        ],
    },

    // ══ THE ROUTING SHOWCASE ══════════════════════════════════════════════
    /**
     * Send an invoice up the ladder.
     *
     * This one action carries BOTH kinds of routing, and the split between
     * them is the point of the template:
     *
     *   · the `condition` step routes on the SUPPLIER, because "do not ask
     *     anybody at all" has no expression inside a chain — a blocked
     *     supplier's invoice is parked, and the trail says so;
     *   · the `switch` step routes on the AMOUNT BAND, because the three
     *     bands want genuinely different LADDERS (one rung; four rungs with
     *     two conditional ones; five rungs with a quorum and a unanimous
     *     pair). Squeezing those into one chain would mean nine conditions on
     *     five stages, which nobody could read and nobody would trust;
     *   · and inside the chains, `when` conditions turn individual rungs on
     *     and off — see STAGES_STANDARD and STAGES_BOARD above.
     *
     * The corrections the sender made on the form are written FIRST, so the
     * amount that gets approved is the amount that is on the record.
     */
    act_iasubmit: {
        kind: 'sequence',
        steps: [
            {
                kind: 'confirm',
                title: 'Send for approval',
                message: 'The people on the ladder will be asked in order, and the invoice PDF goes with the request. Send it?',
                confirmLabel: 'Send it',
                cancelLabel: 'Not yet',
            },
            {
                // The last cheap moment to catch a mis-read total.
                kind: 'update_record', tableId: 'tbl_iainv',
                recordId: { kind: 'formula', expr: 'vars.invoice.id' },
                values: {
                    invoice_no: { kind: 'formula', expr: 'form.invoice_no' },
                    supplier_name: { kind: 'formula', expr: 'form.supplier_name' },
                    currency: { kind: 'formula', expr: 'form.currency' },
                    amount_total: { kind: 'formula', expr: "form.amount_total === '' ? null : form.amount_total" },
                    cost_center: { kind: 'formula', expr: 'form.cost_center' },
                    supplier_risk: { kind: 'formula', expr: 'form.supplier_check' },
                    director_rule: { kind: 'formula', expr: 'form.director_rule' },
                    submitted_by_name: { kind: 'formula', expr: 'currentUser.name' },
                    submitted_at: { kind: 'formula', expr: 'now' },
                    approval_route: { kind: 'formula', expr: ROUTE_LABEL_EXPR },
                },
            },
            {
                // ── FLOW-LEVEL ROUTING · lever one: the supplier ──────────
                kind: 'condition',
                expr: "form.supplier_check === 'blocked'",
                then: [
                    {
                        kind: 'update_record', tableId: 'tbl_iainv',
                        recordId: { kind: 'formula', expr: 'vars.invoice.id' },
                        values: {
                            status: { kind: 'static', value: 'on_hold' },
                            approval_route: { kind: 'static', value: 'Blocked supplier — parked, nobody asked' },
                            decision_note: { kind: 'formula', expr: "concat('Parked on ', formatDate(now, 'YYYY-MM-DD'), ': the supplier is marked \"Blocked — do not pay\". ', default(form.submit_note, ''))" },
                        },
                    },
                    trailStep('hold', "concat('Supplier is blocked — no approval requested. ', default(form.submit_note, ''))"),
                    {
                        kind: 'toast',
                        message: 'This supplier is blocked, so nobody was asked — the invoice is on hold and the trail says why.',
                        tone: 'warning',
                    },
                ],
                else: [
                    {
                        // ── FLOW-LEVEL ROUTING · lever two: the amount ────
                        kind: 'switch',
                        expr: ROUTE_KEY_EXPR,
                        cases: [
                            // Under €1,000 — one rung. A week to answer, a
                            // nudge after two days.
                            { value: 'fast', steps: [approvalStep('Fast track', STAGES_FAST(), 168, 48)] },
                            // €1,000 – €25,000 — the everyday ladder, with the
                            // Finance and Director rungs conditional.
                            { value: 'standard', steps: [approvalStep('Standard', STAGES_STANDARD(), 168, 48)] },
                            // €25,000 and up — a different shape, and two
                            // weeks, because these need people in a room.
                            { value: 'board', steps: [approvalStep('Board', STAGES_BOARD(), 336, 72)] },
                        ],
                        // The fail-safe. ROUTE_KEY_EXPR is total — even a
                        // missing amount lands in 'fast' — but a switch that
                        // matched nothing would leave an invoice marked "in
                        // approval" that nobody was ever asked about, and that
                        // is the one failure this app must not have. The
                        // default is the ordinary ladder, never "nobody".
                        default: [approvalStep('Standard (fallback)', STAGES_STANDARD(), 168, 48)],
                    },
                    {
                        kind: 'update_record', tableId: 'tbl_iainv',
                        recordId: { kind: 'formula', expr: 'vars.invoice.id' },
                        values: { status: { kind: 'static', value: 'in_approval' } },
                    },
                    // The trail names the ladder the invoice actually went
                    // up, derived from the SAME expression the switch used —
                    // a trail that says "Standard" where the switch chose
                    // "Board" is worse than no trail.
                    trailStep('submitted', `concat('Sent up the ', (${ROUTE_LABEL_EXPR}), ' ladder. ', default(form.submit_note, ''))`),
                    { kind: 'toast', message: 'Sent for approval — the first rung has been asked.', tone: 'success' },
                ],
            },
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_iaevt' },
        ],
    },

    /**
     * The approval_list component's own event, fired after a decision lands in
     * the app. The RECORD is already updated by the on_decided hook — this is
     * the TRAIL row, which the hook cannot write because a hook writes exactly
     * one row to one table.
     *
     * Honest limitation: a decision made in the Approvals section rather than
     * on this screen updates the invoice (the hook runs wherever the decision
     * is made) but writes no trail row here. The trail says who decided and
     * when either way, because the invoice itself carries decided_by_name.
     */
    act_iadecided: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record', tableId: 'tbl_iaevt',
                values: {
                    invoice: { kind: 'formula', expr: 'form.context.invoice_id' },
                    invoice_no: { kind: 'formula', expr: 'form.context.invoice_no' },
                    at: { kind: 'formula', expr: 'now' },
                    actor: { kind: 'formula', expr: 'currentUser.name' },
                    kind: { kind: 'static', value: 'decided' },
                    // `contains` ignores case and matches both 'approve' and
                    // 'approved', so the row reads correctly whichever verb
                    // the component hands over.
                    detail: { kind: 'formula', expr: "concat(contains(toStr(form.decision), 'approv') ? 'Approved' : 'Rejected', ' · ', default(form.reason, 'no note given'))" },
                },
            },
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_iaevt' },
            { kind: 'toast', message: 'Decision recorded on the invoice.', tone: 'success' },
        ],
    },

    // ── holding, releasing ────────────────────────────────────────────────
    act_iahold: { kind: 'open_modal', modalId: 'cmp_iaholdm' },
    act_iaholdsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record', tableId: 'tbl_iainv',
                recordId: { kind: 'formula', expr: 'vars.invoice.id' },
                values: {
                    status: { kind: 'static', value: 'on_hold' },
                    decision_note: { kind: 'formula', expr: 'form.hold_reason' },
                },
            },
            trailStep('hold', 'form.hold_reason'),
            { kind: 'close_modal', modalId: 'cmp_iaholdm' },
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_iaevt' },
            { kind: 'toast', message: 'Invoice put on hold.', tone: 'warning' },
        ],
    },
    act_iaunhold: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', title: 'Take it off hold', message: 'The invoice goes back to "Needs review" so it can be checked and sent on. Continue?', confirmLabel: 'Take it off hold', cancelLabel: 'Leave it' },
            {
                kind: 'update_record', tableId: 'tbl_iainv',
                recordId: { kind: 'formula', expr: 'vars.invoice.id' },
                values: { status: { kind: 'static', value: 'needs_review' } },
            },
            trailStep('note', { kind: 'static', value: 'Taken off hold and returned for review.' }),
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_iaevt' },
            { kind: 'toast', message: 'Back in the review queue.', tone: 'success' },
        ],
    },

    // ── paying ────────────────────────────────────────────────────────────
    /**
     * Schedule an approved invoice into a payment run. A row action, so `item`
     * is the whole row and no variable has to be published first — and the
     * date it schedules to is the approver's own "pay no later than" when they
     * gave one, the supplier's due date otherwise.
     */
    act_iaschedule: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record', tableId: 'tbl_iainv',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: {
                    status: { kind: 'static', value: 'scheduled' },
                    payment_date: { kind: 'formula', expr: 'default(item.approved_pay_by, item.due_date)' },
                },
            },
            trailStep('note', "concat('Scheduled for payment on ', toStr(default(item.approved_pay_by, item.due_date)), '.')",
                { recordIdExpr: 'item.id', invoiceNoExpr: 'item.invoice_no' }),
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_iaevt' },
            { kind: 'toast', message: 'Scheduled.', tone: 'success' },
        ],
    },
    act_iapayopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'payinv', value: { kind: 'formula', expr: 'item' } },
            { kind: 'open_modal', modalId: 'cmp_iapaym' },
        ],
    },
    act_iapaysave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record', tableId: 'tbl_iainv',
                recordId: { kind: 'formula', expr: 'vars.payinv.id' },
                values: {
                    status: { kind: 'static', value: 'paid' },
                    payment_date: { kind: 'formula', expr: 'form.payment_date' },
                    payment_reference: { kind: 'formula', expr: 'form.payment_reference' },
                    paid_by_name: { kind: 'formula', expr: 'currentUser.name' },
                    paid_at: { kind: 'formula', expr: 'now' },
                },
            },
            trailStep('paid', "concat('Paid on ', toStr(form.payment_date), ' · ', default(form.payment_reference, 'no reference'))",
                { recordIdExpr: 'vars.payinv.id', invoiceNoExpr: 'vars.payinv.invoice_no' }),
            { kind: 'close_modal', modalId: 'cmp_iapaym' },
            { kind: 'refresh', tableId: 'tbl_iainv' },
            { kind: 'refresh', tableId: 'tbl_iaevt' },
            { kind: 'toast', message: 'Payment recorded.', tone: 'success' },
        ],
    },

    // ── invoice lines ─────────────────────────────────────────────────────
    act_ialineadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record', tableId: 'tbl_ialine',
                values: {
                    invoice: { kind: 'formula', expr: 'vars.invoice.id' },
                    invoice_no: { kind: 'formula', expr: 'vars.invoice.invoice_no' },
                    description: { kind: 'static', value: 'New line' },
                    cost_center: { kind: 'formula', expr: 'vars.invoice.cost_center' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_ialine' },
            { kind: 'toast', message: 'Line added — fill it in below.', tone: 'info' },
        ],
    },
    /**
     * The inline grid commit. With selectable:'none' a data_grid's onRowSelect
     * fires ONLY for a cell edit, with { ...row, [col]: next, __edited: col },
     * so one switch over form.__edited gives every editable column its own
     * SINGLE-COLUMN write — two people editing different cells of the same row
     * no longer clobber each other, and expectedUpdatedAt stops them clobbering
     * each other on the same cell.
     */
    act_ialineedit: {
        kind: 'sequence',
        steps: [
            {
                kind: 'switch',
                expr: 'form.__edited',
                cases: [
                    cellCommit('tbl_ialine', 'line_no', { numeric: true }),
                    cellCommit('tbl_ialine', 'description'),
                    cellCommit('tbl_ialine', 'quantity', { numeric: true }),
                    cellCommit('tbl_ialine', 'unit_price', { numeric: true }),
                    cellCommit('tbl_ialine', 'line_total', { numeric: true }),
                    cellCommit('tbl_ialine', 'vat_rate', { numeric: true }),
                    cellCommit('tbl_ialine', 'cost_center'),
                    cellCommit('tbl_ialine', 'gl_account'),
                ],
            },
            { kind: 'refresh', tableId: 'tbl_ialine' },
        ],
    },
    act_ialinedel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', title: 'Delete this line', message: 'The line is removed from the invoice. This cannot be undone.', confirmLabel: 'Delete', cancelLabel: 'Keep it' },
            { kind: 'delete_record', tableId: 'tbl_ialine', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_ialine' },
            { kind: 'toast', message: 'Line deleted.', tone: 'success' },
        ],
    },

    // ── the supplier master ───────────────────────────────────────────────
    act_iasupadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record', tableId: 'tbl_iasup',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    supplier_no: { kind: 'formula', expr: 'form.supplier_no' },
                    category: { kind: 'formula', expr: 'form.category' },
                    contact_email: { kind: 'formula', expr: 'form.contact_email' },
                    payment_terms_days: { kind: 'formula', expr: "form.payment_terms_days === '' ? null : form.payment_terms_days" },
                    risk: { kind: 'formula', expr: 'form.risk' },
                    always_director: { kind: 'formula', expr: "form.always_director === true || form.always_director === 'true'" },
                    active: { kind: 'static', value: true },
                    notes: { kind: 'formula', expr: 'form.notes' },
                },
            },
            { kind: 'reset_form', form: 'newsupplier' },
            { kind: 'refresh', tableId: 'tbl_iasup' },
            { kind: 'toast', message: 'Supplier added.', tone: 'success' },
        ],
    },
    act_iasupedit: {
        kind: 'sequence',
        steps: [
            {
                kind: 'switch',
                expr: 'form.__edited',
                cases: [
                    cellCommit('tbl_iasup', 'supplier_no'),
                    cellCommit('tbl_iasup', 'category'),
                    cellCommit('tbl_iasup', 'contact_email'),
                    cellCommit('tbl_iasup', 'payment_terms_days', { numeric: true }),
                    cellCommit('tbl_iasup', 'bank_reference'),
                    cellCommit('tbl_iasup', 'risk'),
                    cellCommit('tbl_iasup', 'always_director', { bool: true }),
                    cellCommit('tbl_iasup', 'active', { bool: true }),
                    cellCommit('tbl_iasup', 'notes'),
                ],
            },
            { kind: 'refresh', tableId: 'tbl_iasup' },
        ],
    },

    // ── the written-down policy ───────────────────────────────────────────
    act_iapoledit: {
        kind: 'sequence',
        steps: [
            {
                kind: 'switch',
                expr: 'form.__edited',
                cases: [
                    cellCommit('tbl_iapol', 'band'),
                    cellCommit('tbl_iapol', 'min_amount', { numeric: true }),
                    cellCommit('tbl_iapol', 'max_amount', { numeric: true }),
                    cellCommit('tbl_iapol', 'stages_label'),
                    cellCommit('tbl_iapol', 'rule_note'),
                    cellCommit('tbl_iapol', 'seats_label'),
                    cellCommit('tbl_iapol', 'active', { bool: true }),
                ],
            },
            { kind: 'refresh', tableId: 'tbl_iapol' },
        ],
    },
};

// ---------------------------------------------------------------------------
// Screens
//
// Ten of them, in four nav groups. `sidebar` rather than tabs: at ten screens
// a flat tab row is a wall of words, and the group labels (Work / Decide /
// Insight / Setup) are the app's own table of contents.
// ---------------------------------------------------------------------------

/** The setup notice, shown wherever somebody might be about to send a real invoice. */
const SETUP_CALLOUT_TEXT = 'The approval ladder ships with **placeholder approver groups** (every seat is named `replace-me-…`). Until you replace them with your own groups, every rung falls back to the app owner — the ladder still runs, in order, and nothing is skipped, but the same person is asked each time. Open **Approval policy** for the ladder and the list of groups to create.';

const SCREEN_HOME = {
    id: 'scr_iahome', name: 'Today', icon: 'LayoutDashboard', showInNav: true, maxWidth: 'wide',
    description: 'What is waiting on you, what is stuck, and what is about to be late',
    kind: 'dashboard',
    refreshInterval: 60,
    sections: [
        {
            id: 'sec_iahhdr', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iahhdr', type: 'page_header',
                    props: {
                        look: 'banner',
                        title: 'Invoice approvals',
                        subtitle: 'Read the PDF, check the numbers, send it up the ladder — and keep the record of who said yes.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'FileCheck', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [
                        { id: 'cmp_iahnew', type: 'button', props: { label: 'New invoice', variant: 'primary', iconLeft: 'Plus', role: 'button' }, style: { span: 3 }, visible: true, onClick: 'act_iagonew' },
                        { id: 'cmp_iahgoap', type: 'button', props: { label: 'Approvals', variant: 'soft', iconLeft: 'ShieldCheck', role: 'button' }, style: { span: 3 }, visible: true, onClick: 'act_iagoappr' },
                        { id: 'cmp_iahgopy', type: 'button', props: { label: 'Payments', variant: 'soft', iconLeft: 'Banknote', role: 'button' }, style: { span: 3 }, visible: true, onClick: 'act_iagopay' },
                        { id: 'cmp_iahref', type: 'button', props: { label: 'Refresh', variant: 'ghost', iconLeft: 'RefreshCw', role: 'button' }, style: { span: 3 }, visible: true, onClick: 'act_iarefresh' },
                    ],
                },
                {
                    id: 'cmp_iahsetup', type: 'callout',
                    props: { title: 'Before the first real invoice', text: SETUP_CALLOUT_TEXT, tone: 'info' },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iahkpi', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iahk1', type: 'stat',
                    props: {
                        label: 'Needs review',
                        value: invoiceCount([{ field: 'status', op: 'eq', value: 'needs_review' }]),
                        caption: 'read by AI, not yet checked by a person',
                        icon: 'FileSearch', look: 'tile',
                        delta: { kind: 'static', value: null }, deltaFormat: 'number',
                        trend: { kind: 'static', value: null }, positiveIsGood: true,
                    },
                    style: { span: 3 }, visible: true,
                },
                {
                    id: 'cmp_iahk2', type: 'stat',
                    props: {
                        label: 'In approval',
                        value: invoiceCount([{ field: 'status', op: 'eq', value: 'in_approval' }]),
                        caption: 'somewhere on the ladder',
                        icon: 'Hourglass', look: 'tile',
                        delta: { kind: 'static', value: null }, deltaFormat: 'number',
                        trend: { kind: 'static', value: null }, positiveIsGood: true,
                    },
                    style: { span: 3 }, visible: true,
                },
                {
                    id: 'cmp_iahk3', type: 'stat',
                    props: {
                        label: 'Value awaiting approval',
                        value: invoiceSum([{ field: 'status', op: 'eq', value: 'in_approval' }]),
                        caption: 'gross, all currencies added as given',
                        icon: 'Euro', look: 'accent',
                        delta: { kind: 'static', value: null }, deltaFormat: 'number',
                        trend: { kind: 'static', value: null }, positiveIsGood: true,
                    },
                    style: { span: 3 }, visible: true,
                },
                {
                    id: 'cmp_iahk4', type: 'stat',
                    props: {
                        label: 'Past due, unpaid',
                        // `today` is a declared formula root, so "late" is
                        // computed against the day it is read rather than
                        // against whenever the app was built.
                        value: invoiceCount([
                            { field: 'due_date', op: 'lt', value: { kind: 'formula', expr: 'today' } },
                            { field: 'status', op: 'neq', value: 'paid' },
                        ]),
                        caption: 'due date passed and still not paid',
                        icon: 'AlertTriangle', look: 'tile',
                        delta: { kind: 'static', value: null }, deltaFormat: 'number',
                        trend: { kind: 'static', value: null }, positiveIsGood: false,
                    },
                    style: { span: 3, color: 'danger' }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iahmine', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iahmh', type: 'heading', props: { text: 'Waiting on you', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    // The whole point of the screen. `approval_list` fetches as
                    // the REAL signed-in viewer (not acts-as-owner like every
                    // data binding), so this shows what is on THIS person and
                    // lets them decide it here rather than in another section.
                    id: 'cmp_iahappr', type: 'approval_list',
                    props: { scope: 'mine', show: 'waiting', limit: 8, showDetails: true, emptyText: 'Nothing is waiting on you right now.' },
                    style: { span: 12 }, visible: true,
                    onDecided: 'act_iadecided',
                },
            ],
        },
        {
            id: 'sec_iahwork', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iahwh', type: 'heading', props: { text: 'Needs a person', level: 2, accent: 'bar' }, style: { span: 8 }, visible: true },
                { id: 'cmp_iahall', type: 'button', props: { label: 'All invoices', variant: 'ghost', iconLeft: 'ArrowRight', role: 'button' }, style: { span: 4, align: 'end' }, visible: true, onClick: 'act_iaback' },
                {
                    id: 'cmp_iahgrid', type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records', tableId: 'tbl_iainv',
                            filter: [{ field: 'status', op: 'in', value: ['draft', 'needs_review', 'on_hold', 'rejected'] }],
                            sort: [{ field: 'due_date', dir: 'asc' }],
                            limit: 50,
                        },
                        columns: [
                            { key: 'invoice_no', label: 'Invoice', format: 'text', sortable: true },
                            { key: 'supplier_name', label: 'Supplier', format: 'text', sortable: true },
                            { key: 'amount_total', label: 'Total', format: 'currency', align: 'right', sortable: true },
                            { key: 'due_date', label: 'Due', format: 'date', sortable: true },
                            { key: 'status', label: 'Status', format: 'badge', toneMap: STATUS_TONES },
                            { key: 'extraction_note', label: 'What the AI flagged', format: 'text', truncate: true },
                        ],
                        pageSize: 10, selectable: 'none', searchable: false,
                        density: 'comfortable', clamp: '2', zebra: false, look: 'default',
                        rowTone: [
                            { field: 'status', value: 'on_hold', tone: 'danger' },
                            { field: 'status', value: 'rejected', tone: 'danger' },
                            { field: 'status', value: 'needs_review', tone: 'warning' },
                        ],
                        emptyText: 'Nothing needs a person right now.',
                    },
                    style: { span: 8 }, visible: true,
                    onRowClick: 'act_iaopen',
                },
                {
                    id: 'cmp_iahchart', type: 'chart',
                    props: {
                        chartType: 'donut',
                        source: {
                            kind: 'aggregate', tableId: 'tbl_iainv',
                            groupBy: [{ field: 'status', as: 'status' }],
                            aggregates: [{ fn: 'count', as: 'invoices' }],
                            limit: 12,
                        },
                        title: 'Where everything is',
                        xKey: 'status', xType: 'category',
                        series: [{ key: 'invoices', label: 'Invoices' }],
                        stacked: false, showLegend: true, showGrid: false,
                        valueFormat: 'number', yMin: null, yMax: null,
                        referenceLines: [], referenceBands: [], unitLabel: null,
                    },
                    style: { span: 4, height: 'md' }, visible: true,
                },
            ],
        },
    ],
};

/**
 * The suppliers grid appears on two screens. On Setup it is the master list;
 * on New invoice and on the invoice's Supplier tab it is ALSO what fills
 * `records.tbl_iasup`, which the copy-the-levers loop reads. Same component,
 * different id per screen (ids are unique across the app).
 */
const supplierGrid = (id, { editable = false, span = 12 } = {}) => ({
    id, type: 'data_grid',
    props: {
        source: { kind: 'records', tableId: 'tbl_iasup', sort: [{ field: 'name', dir: 'asc' }], limit: 200 },
        columns: [
            { key: 'name', label: 'Supplier', format: 'text', sortable: true },
            { key: 'supplier_no', label: 'No.', format: 'text', editable, width: 90 },
            { key: 'category', label: 'Category', format: 'badge', editable, filterable: true },
            {
                key: 'risk', label: 'Supplier check', format: 'badge', editable, toneMap: RISK_TONES,
                help: 'Copied onto every invoice from this supplier. "Watch list" adds the Finance rung; "Blocked" means no approval is requested at all.',
            },
            {
                key: 'always_director', label: 'Always director', format: 'check', editable, align: 'center',
                help: 'Puts the director rung in the chain whatever the amount is — the way external counsel works.',
            },
            { key: 'payment_terms_days', label: 'Terms', format: 'number', editable, align: 'right', width: 80 },
            { key: 'bank_reference', label: 'Bank account on file', format: 'text', editable },
            { key: 'active', label: 'Active', format: 'check', editable, align: 'center', width: 70 },
        ],
        pageSize: 25, selectable: 'none', searchable: true,
        density: 'comfortable', clamp: '2', zebra: false, look: 'default',
        rowTone: [
            { field: 'risk', value: 'blocked', tone: 'danger' },
            { field: 'risk', value: 'watch', tone: 'warning' },
        ],
        emptyText: 'No suppliers yet.',
    },
    style: { span }, visible: true,
    ...(editable ? { onRowSelect: 'act_iasupedit' } : {}),
});

const SCREEN_INTAKE = {
    id: 'scr_iaintake', name: 'New invoice', icon: 'FilePlus2', showInNav: true, maxWidth: 'wide',
    description: 'Drop the PDF, let the AI read it, check what it got',
    sections: [
        {
            id: 'sec_iainhdr', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iainhdr', type: 'page_header',
                    props: {
                        look: 'split', title: 'New invoice',
                        subtitle: 'One PDF at a time. Pick the supplier first — that is what tells the ladder whether this one needs the director.',
                        titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null },
                        icon: 'FilePlus2', showDivider: true,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [
                        { id: 'cmp_iainall', type: 'button', props: { label: 'All invoices', variant: 'ghost', iconLeft: 'List', role: 'button' }, style: { span: 5 }, visible: true, onClick: 'act_iaback' },
                    ],
                },
            ],
        },
        {
            id: 'sec_iainform', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iaincard', type: 'card',
                    props: { title: 'Read an invoice', description: 'The AI reads the header and the lines; you check them on the next screen before anything is sent.', look: 'accent' },
                    style: { span: 7, padding: 3, gap: 3, background: 'surface' }, visible: true,
                    children: [
                        {
                            id: 'cmp_iainfrm', type: 'form',
                            props: { name: 'intake', submitLabel: 'Read the invoice', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 }, visible: true,
                            onSubmit: 'act_iaread',
                            children: [
                                {
                                    id: 'cmp_iainfile', type: 'input_file',
                                    props: { name: 'document', label: 'Invoice PDF', accept: 'application/pdf,.pdf', multiple: false, required: true, buttonLabel: 'Choose the PDF' },
                                    style: { span: 12 }, visible: true,
                                },
                                {
                                    id: 'cmp_iainsup', type: 'input_relation',
                                    props: { name: 'supplier', label: 'Supplier', tableId: 'tbl_iasup', displayField: 'name', multiple: false, required: true, filter: 'item.active' },
                                    style: { span: 7 }, visible: true,
                                },
                                {
                                    id: 'cmp_iaincc', type: 'input_select',
                                    props: {
                                        name: 'cost_center', label: 'Cost centre', options: COST_CENTRE_OPTIONS,
                                        required: false, defaultValue: null, placeholder: 'Pick one (you can change it later)',
                                        valueFrom: { kind: 'static', value: null },
                                    },
                                    style: { span: 5 }, visible: true,
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_iainhow', type: 'card',
                    props: { title: 'What happens next', description: null, look: 'tinted' },
                    style: { span: 5, padding: 3, gap: 2, background: 'surface' }, visible: true,
                    children: [
                        {
                            id: 'cmp_iainmd', type: 'markdown',
                            props: {
                                content: [
                                    '1. **Two reads, not one.** The header is one row and gets a tight prompt; the lines are a table and get their own, with the header as context so a line that does not fit the total stands out.',
                                    '2. **Nothing is sent yet.** The invoice lands on *Needs review*. A machine read it; a person has not looked at it.',
                                    '3. **The supplier comes with policy.** Linking the supplier copies its *supplier check* and *director rule* onto the invoice — the two levers the ladder reads.',
                                    '',
                                    'Anything the AI could not read is written into **What the AI could not read** rather than guessed at.',
                                ].join('\n'),
                                contentFrom: { kind: 'static', value: null },
                            },
                            style: { span: 12 }, visible: true,
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_iainsup', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iainsh', type: 'heading', props: { text: 'Suppliers on file', level: 3, accent: 'bar' }, style: { span: 12 }, visible: true },
                supplierGrid('cmp_iainsgrid'),
            ],
        },
    ],
};

const SCREEN_INVOICES = {
    id: 'scr_iainvs', name: 'Invoices', icon: 'Files', showInNav: true, maxWidth: 'full',
    description: 'Every invoice, whatever state it is in',
    sections: [
        {
            id: 'sec_iaivhdr', style: { padding: 4, gap: 2, background: 'none' },
            children: [
                {
                    id: 'cmp_iaivhdr', type: 'page_header',
                    props: {
                        look: 'split', title: 'Invoices',
                        subtitle: 'Click a row to open the invoice beside its PDF.',
                        titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null },
                        icon: 'Files', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [
                        { id: 'cmp_iaivnew', type: 'button', props: { label: 'New invoice', variant: 'primary', iconLeft: 'Plus', role: 'button' }, style: { span: 5 }, visible: true, onClick: 'act_iagonew' },
                    ],
                },
                {
                    // filter_bar publishes to ONE hardcoded variable,
                    // vars.filters — one bar per screen, and the records
                    // binding below reads it.
                    id: 'cmp_iaivfil', type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Invoice number', type: 'search', options: [] },
                            { name: 'supplier', label: 'Supplier', type: 'search', options: [] },
                            { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
                            { name: 'cc', label: 'Cost centre', type: 'select', options: COST_CENTRE_OPTIONS },
                        ],
                    },
                    style: { span: 12, gap: 2 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iaivgrid', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iaivgrid', type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records', tableId: 'tbl_iainv',
                            filter: [
                                { field: 'invoice_no', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' } },
                                { field: 'supplier_name', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.supplier' } },
                                { field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.status' } },
                                { field: 'cost_center', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.cc' } },
                            ],
                            sort: [{ field: 'created_at', dir: 'desc' }],
                            limit: 500,
                        },
                        columns: [
                            { key: 'invoice_no', label: 'Invoice', format: 'text', sortable: true, width: 140 },
                            { key: 'supplier_name', label: 'Supplier', format: 'text', sortable: true },
                            { key: 'invoice_date', label: 'Date', format: 'date', sortable: true, width: 110 },
                            { key: 'due_date', label: 'Due', format: 'date', sortable: true, width: 110 },
                            { key: 'amount_total', label: 'Total', format: 'currency', align: 'right', sortable: true, width: 120 },
                            { key: 'cost_center', label: 'Cost centre', format: 'badge', filterable: true },
                            {
                                key: 'band', label: 'Band', format: 'badge', width: 110,
                                help: 'Worked out in SQL from the total, so it is filterable and groupable without every screen repeating the thresholds.',
                                toneMap: [
                                    { value: 'fast', label: 'Fast track', tone: 'neutral' },
                                    { value: 'standard', label: 'Standard', tone: 'info' },
                                    { value: 'director', label: 'Director', tone: 'warning' },
                                    { value: 'board', label: 'Board', tone: 'danger' },
                                    { value: 'unknown', label: 'No amount', tone: 'neutral' },
                                ],
                            },
                            { key: 'approval_route', label: 'Route taken', format: 'text', truncate: true },
                            { key: 'status', label: 'Status', format: 'badge', sortable: true, toneMap: STATUS_TONES },
                            { key: 'decided_by_name', label: 'Decided by', format: 'text' },
                        ],
                        pageSize: 25, selectable: 'none', searchable: false,
                        density: 'comfortable', clamp: '1', zebra: false, look: 'default',
                        rowTone: [
                            { field: 'status', value: 'on_hold', tone: 'danger' },
                            { field: 'status', value: 'rejected', tone: 'danger' },
                            { field: 'status', value: 'needs_review', tone: 'warning' },
                            { field: 'status', value: 'paid', tone: 'success' },
                        ],
                        emptyText: 'No invoices match those filters.',
                    },
                    style: { span: 12 }, visible: true,
                    onRowClick: 'act_iaopen',
                },
            ],
        },
    ],
};

/**
 * A live preview of the ladder this invoice is about to go up, rendered from
 * the send-for-approval form as the sender types. It reads `forms.send.*` —
 * the whole form's values are addressable from anywhere on the screen, which
 * is what lets a markdown block react to a number field beside it.
 *
 * The thresholds are interpolated from the same constants the switch and the
 * stage conditions use, so the preview cannot drift from the ladder; the
 * accompanying test asserts every threshold appears in all three places.
 */
const LADDER_PREVIEW_EXPR = "concat("
    + "(forms.send.supplier_check === 'blocked'"
    + " ? '**Route:** none. This supplier is **blocked**, so nobody will be asked — the invoice is parked on hold and the trail records why.'"
    + " : concat("
    + `'**Route:** ', (${isBoardBand('forms.send')} ? 'Board' : (${isStandardBand('forms.send')} ? 'Standard' : 'Fast track')), ' ladder\\n\\n',`
    + "'Who will be asked, in order:\\n\\n- Team lead\\n',"
    + `((${isBoardBand('forms.send')} || ${isStandardBand('forms.send')}) ? '- Budget holder\\n' : ''),`
    + `(${isBoardBand('forms.send')}`
    + " ? '- Finance — two of three\\n- Both directors\\n'"
    + `  : ((${isStandardBand('forms.send')} && (number(forms.send.amount_total) >= ${BAND_FINANCE} || forms.send.supplier_check === 'watch')) ? '- Finance\\n' : '')),`
    + `(${isBoardBand('forms.send')}`
    + `  ? (number(forms.send.amount_total) >= ${BAND_FULL_BOARD} ? '- Board\\n' : '')`
    + `  : ((${isStandardBand('forms.send')} && (number(forms.send.amount_total) >= ${BAND_DIRECTOR} || forms.send.director_rule === 'always')) ? '- Director\\n' : ''))`
    + ")))";

const SCREEN_DETAIL = {
    id: 'scr_iadetail', name: 'Invoice', icon: 'FileText', showInNav: false, maxWidth: 'full',
    description: 'The document beside the numbers',
    sections: [
        {
            id: 'sec_iaddhdr', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iadhdr', type: 'page_header',
                    props: {
                        look: 'split', title: 'Invoice', subtitle: null,
                        // titleFrom/subtitleFrom name the THING on screen
                        // rather than the screen: without them the header
                        // would say "Invoice" over every invoice in the app.
                        titleFrom: openInvoice('invoice_no'),
                        subtitleFrom: openInvoice('supplier_name'),
                        icon: 'FileText', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [
                        { id: 'cmp_iadback', type: 'button', props: { label: 'Back', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' }, style: { span: 3 }, visible: true, onClick: 'act_iaback' },
                        { id: 'cmp_iaddl', type: 'button', props: { label: 'Download PDF', variant: 'secondary', iconLeft: 'Download', role: 'button' }, style: { span: 3 }, visible: true, onClick: 'act_iadl' },
                        { id: 'cmp_iadhold', type: 'button', props: { label: 'Put on hold', variant: 'outline', iconLeft: 'PauseCircle', role: 'button' }, style: { span: 3 }, visible: true, onClick: 'act_iahold' },
                        { id: 'cmp_iadunh', type: 'button', props: { label: 'Take off hold', variant: 'ghost', iconLeft: 'PlayCircle', role: 'button' }, style: { span: 3 }, visible: true, onClick: 'act_iaunhold' },
                    ],
                },
                {
                    // Where the invoice IS, which a status dropdown never says.
                    id: 'cmp_iadstep', type: 'stepper',
                    props: {
                        value: openInvoice('status'),
                        steps: [
                            { value: 'draft', label: 'Uploaded', icon: 'Upload' },
                            { value: 'needs_review', label: 'Needs review', icon: 'FileSearch' },
                            { value: 'in_approval', label: 'In approval', icon: 'Hourglass' },
                            { value: 'approved', label: 'Approved', icon: 'CheckCircle2' },
                            { value: 'scheduled', label: 'Scheduled', icon: 'CalendarClock' },
                            { value: 'paid', label: 'Paid', icon: 'Banknote' },
                        ],
                        orientation: 'horizontal', tone: 'primary', showLabels: true,
                    },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iaddbody', style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_iaddoc', type: 'container',
                    props: { look: 'panel' },
                    style: { span: 5, padding: 3, gap: 2, background: 'surface', height: 'fill' }, visible: true,
                    children: [
                        { id: 'cmp_iaddoch', type: 'heading', props: { text: 'The document', level: 3, accent: 'none' }, style: { span: 12 }, visible: true },
                        {
                            id: 'cmp_iadprev', type: 'file_preview',
                            props: {
                                source: openInvoice('document'),
                                emptyText: 'No PDF on this invoice — upload one from New invoice.',
                                allowDownload: true,
                            },
                            style: { span: 12, height: 'fill' }, visible: true,
                        },
                    ],
                },
                {
                    id: 'cmp_iadtabs', type: 'tabs',
                    props: { look: 'underline' },
                    style: { span: 7, gap: 3, padding: 0, height: 'fill' }, visible: true,
                    children: [
                        // ── Tab 1 · the numbers ───────────────────────────
                        {
                            id: 'cmp_iadtf', type: 'tab',
                            props: { label: 'Fields', icon: 'Table2' },
                            style: { gap: 3, padding: 0 }, visible: true,
                            children: [
                                {
                                    id: 'cmp_iadfrm', type: 'form',
                                    props: { name: 'iafields', submitLabel: 'Save corrections', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                                    onSubmit: 'act_iasave',
                                    children: [
                                        { id: 'cmp_iadf01', type: 'input_text', props: { name: 'invoice_no', label: 'Invoice number', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: openInvoice('invoice_no') }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_iadf02', type: 'input_text', props: { name: 'po_number', label: 'PO number', placeholder: 'If the invoice quotes one', required: false, defaultValue: null, inputType: 'text', valueFrom: openInvoice('po_number') }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_iadf03', type: 'input_date', props: { name: 'invoice_date', label: 'Invoice date', required: false, defaultValue: null, valueFrom: openInvoice('invoice_date') }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_iadf04', type: 'input_date', props: { name: 'due_date', label: 'Due date', required: false, defaultValue: null, valueFrom: openInvoice('due_date') }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_iadf05', type: 'input_select', props: { name: 'currency', label: 'Currency', options: CURRENCY_OPTIONS, required: false, defaultValue: 'EUR', placeholder: null, valueFrom: openInvoice('currency') }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_iadf06', type: 'input_number', props: { name: 'amount_excl_vat', label: 'Net', min: null, max: null, step: 0.01, required: false, defaultValue: null }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_iadf07', type: 'input_number', props: { name: 'vat_amount', label: 'VAT', min: null, max: null, step: 0.01, required: false, defaultValue: null }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_iadf08', type: 'input_number', props: { name: 'amount_total', label: 'Gross total', min: null, max: null, step: 0.01, required: true, defaultValue: null }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_iadf09', type: 'input_select', props: { name: 'cost_center', label: 'Cost centre', options: COST_CENTRE_OPTIONS, required: false, defaultValue: null, placeholder: 'Not coded yet', valueFrom: openInvoice('cost_center') }, style: { span: 8 }, visible: true },
                                        { id: 'cmp_iadf10', type: 'input_textarea', props: { name: 'extraction_note', label: 'What the AI could not read', placeholder: null, required: false, rows: 2, valueFrom: openInvoice('extraction_note'), snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                                {
                                    // The numbers the app itself wrote — never
                                    // typed twice, so they are shown rather
                                    // than offered as fields.
                                    id: 'cmp_iadro', type: 'record_detail',
                                    props: {
                                        source: openInvoice(),
                                        fields: [
                                            { key: 'status', label: 'Status', format: 'badge' },
                                            { key: 'approval_route', label: 'Route taken', format: 'text' },
                                            { key: 'submitted_by_name', label: 'Sent by', format: 'text' },
                                            { key: 'submitted_at', label: 'Sent', format: 'datetime' },
                                            { key: 'decided_by_name', label: 'Decided by', format: 'text' },
                                            { key: 'decided_at', label: 'Decided', format: 'datetime' },
                                            { key: 'decision_note', label: 'Decision note', format: 'text' },
                                            { key: 'rejection_reason', label: 'Reason rejected', format: 'text' },
                                            { key: 'goods_received', label: 'Goods received (approver)', format: 'text' },
                                            { key: 'approved_pay_by', label: 'Pay no later than (approver)', format: 'date' },
                                        ],
                                        columns: 2,
                                        emptyText: 'Open an invoice from the list.',
                                    },
                                    style: { span: 12, padding: 3, background: 'surface' }, visible: true,
                                },
                            ],
                        },
                        // ── Tab 2 · the ladder ────────────────────────────
                        {
                            id: 'cmp_iadta', type: 'tab',
                            props: { label: 'Approval', icon: 'ShieldCheck' },
                            style: { gap: 3, padding: 0 }, visible: true,
                            children: [
                                {
                                    id: 'cmp_iadsend', type: 'form',
                                    props: { name: 'send', submitLabel: 'Send for approval', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                                    onSubmit: 'act_iasubmit',
                                    children: [
                                        {
                                            id: 'cmp_iadsn0', type: 'callout',
                                            props: {
                                                title: 'Check the number before you send it',
                                                text: 'Whatever is in these fields is what gets written to the invoice and what the ladder is chosen from. The gross total and the supplier check are the two levers — everything else on the ladder follows from them.',
                                                tone: 'info',
                                            },
                                            style: { span: 12 }, visible: true,
                                        },
                                        { id: 'cmp_iadsn1', type: 'input_text', props: { name: 'invoice_no', label: 'Invoice number', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: openInvoice('invoice_no') }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_iadsn2', type: 'input_text', props: { name: 'supplier_name', label: 'Supplier', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: openInvoice('supplier_name') }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_iadsn3', type: 'input_select', props: { name: 'currency', label: 'Currency', options: CURRENCY_OPTIONS, required: false, defaultValue: 'EUR', placeholder: null, valueFrom: openInvoice('currency') }, style: { span: 3 }, visible: true },
                                        { id: 'cmp_iadsn4', type: 'input_number', props: { name: 'amount_total', label: 'Gross total', min: 0, max: null, step: 0.01, required: true, defaultValue: null }, style: { span: 4 }, visible: true },
                                        { id: 'cmp_iadsn5', type: 'input_select', props: { name: 'cost_center', label: 'Cost centre', options: COST_CENTRE_OPTIONS, required: true, defaultValue: null, placeholder: 'Pick the budget it comes out of', valueFrom: openInvoice('cost_center') }, style: { span: 5 }, visible: true },
                                        {
                                            id: 'cmp_iadsn6', type: 'input_select',
                                            props: {
                                                name: 'supplier_check', label: 'Supplier check', options: RISK_OPTIONS,
                                                required: true, defaultValue: 'standard', placeholder: null,
                                                valueFrom: openInvoice('supplier_risk'),
                                            },
                                            style: { span: 6 }, visible: true,
                                        },
                                        {
                                            id: 'cmp_iadsn7', type: 'input_select',
                                            props: {
                                                name: 'director_rule', label: 'Director rule', options: DIRECTOR_RULE_OPTIONS,
                                                required: true, defaultValue: 'auto', placeholder: null,
                                                valueFrom: openInvoice('director_rule'),
                                            },
                                            style: { span: 6 }, visible: true,
                                        },
                                        { id: 'cmp_iadsn8', type: 'input_textarea', props: { name: 'submit_note', label: 'Note for the approvers', placeholder: 'Anything they should know before they decide', required: false, rows: 3, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                                {
                                    id: 'cmp_iadprev2', type: 'card',
                                    props: { title: 'Who will be asked', description: 'Worked out from the fields above as you change them.', look: 'tinted' },
                                    style: { span: 12, padding: 3, gap: 2, background: 'surface' }, visible: true,
                                    children: [
                                        {
                                            id: 'cmp_iadladder', type: 'markdown',
                                            props: {
                                                content: 'Fill in the gross total above and the ladder appears here.',
                                                contentFrom: { kind: 'formula', expr: LADDER_PREVIEW_EXPR },
                                            },
                                            style: { span: 12 }, visible: true,
                                        },
                                    ],
                                },
                                {
                                    // This app's OWN requests, decided in
                                    // place: the requester's side of the desk.
                                    id: 'cmp_iadappr', type: 'approval_list',
                                    props: { scope: 'app', show: 'all', limit: 10, showDetails: true, emptyText: 'This app has not asked for anything yet.' },
                                    style: { span: 12 }, visible: true,
                                    onDecided: 'act_iadecided',
                                },
                            ],
                        },
                        // ── Tab 3 · the lines ─────────────────────────────
                        {
                            id: 'cmp_iadtl', type: 'tab',
                            props: { label: 'Lines', icon: 'List' },
                            style: { gap: 3, padding: 0 }, visible: true,
                            children: [
                                {
                                    id: 'cmp_iadlines', type: 'data_grid',
                                    props: {
                                        source: forOpenInvoice('tbl_ialine', [{ field: 'line_no', dir: 'asc' }], 200),
                                        columns: [
                                            { key: 'line_no', label: '#', format: 'number', editable: true, align: 'right', width: 60 },
                                            { key: 'description', label: 'Description', format: 'text', editable: true },
                                            { key: 'quantity', label: 'Qty', format: 'number', editable: true, align: 'right', width: 90 },
                                            { key: 'unit_price', label: 'Unit price', format: 'currency', editable: true, align: 'right', width: 110 },
                                            { key: 'line_total', label: 'Line total', format: 'currency', editable: true, align: 'right', width: 110 },
                                            { key: 'vat_rate', label: 'VAT %', format: 'number', editable: true, align: 'right', width: 80 },
                                            { key: 'cost_center', label: 'Cost centre', format: 'badge', editable: true },
                                            { key: 'gl_account', label: 'GL', format: 'text', editable: true, width: 90 },
                                        ],
                                        pageSize: 25,
                                        // 'none' with editable columns is what
                                        // makes onRowSelect fire ONLY for a
                                        // cell edit — the inline commit.
                                        selectable: 'none',
                                        searchable: false, density: 'compact', clamp: '2', zebra: true, look: 'default',
                                        addRowLabel: 'Add a line',
                                        addRowActionId: 'act_ialineadd',
                                        rowActions: [{ label: 'Delete', actionId: 'act_ialinedel' }],
                                        rowTone: [], bulkActions: [], toolbarActions: [],
                                        emptyText: 'No lines yet — the AI found none, or nobody has added any.',
                                    },
                                    style: { span: 12 }, visible: true,
                                    onRowSelect: 'act_ialineedit',
                                },
                            ],
                        },
                        // ── Tab 4 · the supplier ──────────────────────────
                        {
                            id: 'cmp_iadts', type: 'tab',
                            props: { label: 'Supplier', icon: 'Building2' },
                            style: { gap: 3, padding: 0 }, visible: true,
                            children: [
                                {
                                    id: 'cmp_iadsupf', type: 'form',
                                    props: { name: 'iasupplier', submitLabel: 'Link this supplier', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                                    onSubmit: 'act_iasetsup',
                                    children: [
                                        {
                                            id: 'cmp_iadsupn', type: 'callout',
                                            props: {
                                                title: 'Linking copies the policy',
                                                text: 'A records binding has no joins, so the ladder cannot follow the link at the moment it asks. Picking the supplier here copies its **supplier check** and **director rule** onto this invoice, which is where the routing reads them.',
                                                tone: 'info',
                                            },
                                            style: { span: 12 }, visible: true,
                                        },
                                        {
                                            id: 'cmp_iadsupp', type: 'input_relation',
                                            props: { name: 'supplier', label: 'Supplier', tableId: 'tbl_iasup', displayField: 'name', multiple: false, required: true, filter: null },
                                            style: { span: 8 }, visible: true,
                                        },
                                    ],
                                },
                                supplierGrid('cmp_iadsupg'),
                            ],
                        },
                        // ── Tab 5 · the trail ─────────────────────────────
                        {
                            id: 'cmp_iadtt', type: 'tab',
                            props: { label: 'Trail', icon: 'History' },
                            style: { gap: 3, padding: 0 }, visible: true,
                            children: [
                                {
                                    id: 'cmp_iadtl2', type: 'timeline',
                                    props: {
                                        source: forOpenInvoice('tbl_iaevt', [{ field: 'at', dir: 'desc' }], 100),
                                        titleKey: 'detail',
                                        dateKey: 'at',
                                        descriptionKey: null,
                                        metaKey: 'actor',
                                        icon: 'Dot',
                                        rowLimit: 100,
                                        emptyText: 'Nothing has happened to this invoice yet.',
                                    },
                                    style: { span: 12, height: 'lg' }, visible: true,
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_iadmodal', style: { padding: 0, gap: 0, background: 'none' },
            children: [
                {
                    id: 'cmp_iaholdm', type: 'modal',
                    props: { title: 'Put this invoice on hold', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 4 }, visible: true,
                    children: [
                        {
                            id: 'cmp_iaholdf', type: 'form',
                            props: { name: 'hold', submitLabel: 'Put on hold', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 }, visible: true,
                            onSubmit: 'act_iaholdsave',
                            children: [
                                { id: 'cmp_iaholdr', type: 'input_textarea', props: { name: 'hold_reason', label: 'Why is it on hold?', placeholder: 'A disputed line, unverified bank details, waiting for a credit note…', required: true, rows: 3, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

const SCREEN_APPROVALS = {
    id: 'scr_iaappr', name: 'Approvals', icon: 'ShieldCheck', showInNav: true, maxWidth: 'wide',
    description: 'What is waiting on you, and everything this app has asked for',
    refreshInterval: 60,
    sections: [
        {
            id: 'sec_iaaphdr', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iaaphdr', type: 'page_header',
                    props: {
                        look: 'split', title: 'Approvals',
                        subtitle: 'Decide here, or in the Approvals section — either way the invoice updates.',
                        titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null },
                        icon: 'ShieldCheck', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [
                        { id: 'cmp_iaappol', type: 'button', props: { label: 'The ladder', variant: 'ghost', iconLeft: 'Scale', role: 'button' }, style: { span: 4 }, visible: true, onClick: 'act_iagopol' },
                    ],
                },
                {
                    id: 'cmp_iaapnote', type: 'callout',
                    props: {
                        title: 'How a staged approval behaves',
                        text: 'Only the CURRENT rung is asked. When it passes, the next rung is asked; when a rung rejects, the whole request is rejected and the invoice comes back marked *Rejected* with the reason on it. A rung whose condition was not met is kept and marked skipped, so the record can still answer “why did this never reach Finance?”.',
                        tone: 'info',
                    },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iaapmine', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iaapmh', type: 'heading', props: { text: 'Waiting on you', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    id: 'cmp_iaapmine', type: 'approval_list',
                    props: { scope: 'mine', show: 'waiting', limit: 25, showDetails: true, emptyText: 'Nothing is waiting on you.' },
                    style: { span: 12 }, visible: true,
                    onDecided: 'act_iadecided',
                },
            ],
        },
        {
            id: 'sec_iaapapp', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iaapah', type: 'heading', props: { text: 'Everything this app has asked for', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    // scope 'app' is the REQUESTER's view — including requests
                    // that are waiting on somebody else. showDetails:false
                    // keeps it a list rather than 25 open decision panels.
                    id: 'cmp_iaapall', type: 'approval_list',
                    props: { scope: 'app', show: 'all', limit: 25, showDetails: false, emptyText: 'No requests yet.' },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iaapinv', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iaapih', type: 'heading', props: { text: 'Invoices somewhere on the ladder', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    id: 'cmp_iaapgrid', type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records', tableId: 'tbl_iainv',
                            filter: [{ field: 'status', op: 'eq', value: 'in_approval' }],
                            sort: [{ field: 'submitted_at', dir: 'asc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'invoice_no', label: 'Invoice', format: 'text', sortable: true, width: 140 },
                            { key: 'supplier_name', label: 'Supplier', format: 'text', sortable: true },
                            { key: 'amount_total', label: 'Total', format: 'currency', align: 'right', sortable: true, width: 120 },
                            { key: 'approval_route', label: 'Ladder', format: 'text' },
                            { key: 'submitted_by_name', label: 'Sent by', format: 'text' },
                            { key: 'submitted_at', label: 'Waiting since', format: 'relative', sortable: true, width: 140 },
                            { key: 'due_date', label: 'Due', format: 'date', sortable: true, width: 110 },
                        ],
                        pageSize: 25, selectable: 'none', searchable: true,
                        density: 'comfortable', clamp: '1', zebra: false, look: 'default',
                        rowTone: [], bulkActions: [], toolbarActions: [], rowActions: [],
                        emptyText: 'Nothing is on the ladder right now.',
                    },
                    style: { span: 12 }, visible: true,
                    onRowClick: 'act_iaopen',
                },
            ],
        },
    ],
};

const SCREEN_PAYMENTS = {
    id: 'scr_iapay', name: 'Payments', icon: 'Banknote', showInNav: true, maxWidth: 'wide',
    description: 'What is approved and still owed, and what has gone out',
    sections: [
        {
            id: 'sec_iapyhdr', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iapyhdr', type: 'page_header',
                    props: {
                        look: 'split', title: 'Payments',
                        subtitle: 'An approved invoice is not a paid invoice. This is the gap between the two.',
                        titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null },
                        icon: 'Banknote', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [
                        { id: 'cmp_iapyref', type: 'button', props: { label: 'Refresh', variant: 'ghost', iconLeft: 'RefreshCw', role: 'button' }, style: { span: 4 }, visible: true, onClick: 'act_iarefresh' },
                    ],
                },
                {
                    id: 'cmp_iapyk1', type: 'stat',
                    props: {
                        label: 'Approved, not scheduled',
                        value: invoiceCount([{ field: 'status', op: 'eq', value: 'approved' }]),
                        caption: 'signed off, no payment date yet',
                        icon: 'CheckCircle2', look: 'tile',
                        delta: { kind: 'static', value: null }, deltaFormat: 'number',
                        trend: { kind: 'static', value: null }, positiveIsGood: true,
                    },
                    style: { span: 4 }, visible: true,
                },
                {
                    id: 'cmp_iapyk2', type: 'stat',
                    props: {
                        label: 'Owed and approved',
                        value: invoiceSum([{ field: 'status', op: 'in', value: ['approved', 'scheduled'] }]),
                        caption: 'gross, approved but not yet paid',
                        icon: 'Euro', look: 'accent',
                        delta: { kind: 'static', value: null }, deltaFormat: 'number',
                        trend: { kind: 'static', value: null }, positiveIsGood: false,
                    },
                    style: { span: 4 }, visible: true,
                },
                {
                    id: 'cmp_iapyk3', type: 'stat',
                    props: {
                        label: 'Paid',
                        value: invoiceSum([{ field: 'status', op: 'eq', value: 'paid' }]),
                        caption: 'everything recorded as paid',
                        icon: 'BadgeCheck', look: 'tile',
                        delta: { kind: 'static', value: null }, deltaFormat: 'number',
                        trend: { kind: 'static', value: null }, positiveIsGood: true,
                    },
                    style: { span: 4 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iapyq', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iapyqh', type: 'heading', props: { text: 'Approved and waiting to be paid', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    id: 'cmp_iapygrid', type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records', tableId: 'tbl_iainv',
                            filter: [{ field: 'status', op: 'in', value: ['approved', 'scheduled'] }],
                            sort: [{ field: 'due_date', dir: 'asc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'invoice_no', label: 'Invoice', format: 'text', sortable: true, width: 140 },
                            { key: 'supplier_name', label: 'Supplier', format: 'text', sortable: true },
                            { key: 'amount_total', label: 'Total', format: 'currency', align: 'right', sortable: true, width: 120 },
                            { key: 'due_date', label: 'Due', format: 'date', sortable: true, width: 110 },
                            { key: 'approved_pay_by', label: 'Approver said pay by', format: 'date', width: 150, help: 'The approver’s own answer at decision time — it beats the supplier’s due date when it is earlier.' },
                            { key: 'payment_date', label: 'Scheduled for', format: 'date', width: 130 },
                            { key: 'decided_by_name', label: 'Approved by', format: 'text' },
                            { key: 'status', label: 'Status', format: 'badge', toneMap: STATUS_TONES, width: 120 },
                        ],
                        pageSize: 25, selectable: 'none', searchable: true,
                        density: 'comfortable', clamp: '1', zebra: false, look: 'default',
                        rowActions: [
                            { label: 'Schedule', actionId: 'act_iaschedule' },
                            { label: 'Record payment', actionId: 'act_iapayopen' },
                        ],
                        rowTone: [{ field: 'status', value: 'scheduled', tone: 'info' }],
                        bulkActions: [], toolbarActions: [],
                        emptyText: 'Nothing approved is waiting — either everything is paid or nothing has been approved yet.',
                    },
                    style: { span: 12 }, visible: true,
                    // Row ACTIONS and a row CLICK together: the buttons do the
                    // two things you came here for, and the row still opens the
                    // invoice — a grid that lists invoices and does nothing when
                    // you click one is a dead end people have to be taught.
                    onRowClick: 'act_iaopen',
                },
            ],
        },
        {
            id: 'sec_iapypaid', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iapyph', type: 'heading', props: { text: 'Recently paid', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    id: 'cmp_iapyplist', type: 'list',
                    props: {
                        source: {
                            kind: 'records', tableId: 'tbl_iainv',
                            filter: [{ field: 'status', op: 'eq', value: 'paid' }],
                            sort: [{ field: 'paid_at', dir: 'desc' }],
                            limit: 25,
                        },
                        titleKey: 'supplier_name',
                        subtitleKey: 'invoice_no',
                        metaKey: 'payment_reference',
                        timestampKey: 'paid_at',
                        badgeKey: 'status',
                        badgeToneMap: STATUS_TONES,
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'Banknote',
                        emptyText: 'Nothing has been recorded as paid yet.',
                        look: 'rows',
                    },
                    style: { span: 12 }, visible: true,
                    onRowClick: 'act_iaopen',
                },
            ],
        },
        {
            id: 'sec_iapymod', style: { padding: 0, gap: 0, background: 'none' },
            children: [
                {
                    id: 'cmp_iapaym', type: 'modal',
                    props: { title: 'Record a payment', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 4 }, visible: true,
                    children: [
                        {
                            id: 'cmp_iapayf', type: 'form',
                            props: { name: 'payment', submitLabel: 'Record it', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 }, visible: true,
                            onSubmit: 'act_iapaysave',
                            children: [
                                { id: 'cmp_iapayd', type: 'input_date', props: { name: 'payment_date', label: 'Paid on', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_iapayr', type: 'input_text', props: { name: 'payment_reference', label: 'Payment reference', placeholder: 'Batch or transaction reference', required: false, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

const SCREEN_REPORTING = {
    id: 'scr_iarep', name: 'Reporting', icon: 'BarChart3', showInNav: true, maxWidth: 'wide',
    description: 'What we spend, with whom, and how long the ladder takes',
    sections: [
        {
            id: 'sec_iarphdr', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iarphdr', type: 'page_header',
                    props: {
                        look: 'banner', title: 'Reporting',
                        subtitle: 'Every number here is the invoice table grouped in SQL — nothing is copied into a second place to be reported on.',
                        titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null },
                        icon: 'BarChart3', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [],
                },
            ],
        },
        {
            id: 'sec_iarpch', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iarpm', type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate', tableId: 'tbl_iainv',
                            groupBy: [{ field: 'invoice_date', bucket: 'month', as: 'month' }],
                            aggregates: [{ fn: 'sum', field: 'amount_total', as: 'spend' }],
                            sort: [{ field: 'month', dir: 'asc' }],
                            limit: 24,
                        },
                        title: 'Invoiced per month',
                        xKey: 'month',
                        // 'time', not 'category': a month with no invoices is a
                        // gap, and under 'category' it would silently close up.
                        xType: 'time',
                        series: [{ key: 'spend', label: 'Gross invoiced' }],
                        stacked: false, showLegend: false, showGrid: true,
                        valueFormat: 'currency', yMin: 0, yMax: null,
                        referenceLines: [], referenceBands: [], unitLabel: null,
                    },
                    style: { span: 8, height: 'md' }, visible: true,
                },
                {
                    id: 'cmp_iarpb', type: 'chart',
                    props: {
                        chartType: 'donut',
                        source: {
                            kind: 'aggregate', tableId: 'tbl_iainv',
                            groupBy: [{ field: 'band', as: 'band' }],
                            aggregates: [{ fn: 'count', as: 'invoices' }],
                            limit: 8,
                        },
                        title: 'How many take each ladder',
                        xKey: 'band', xType: 'category',
                        series: [{ key: 'invoices', label: 'Invoices' }],
                        stacked: false, showLegend: true, showGrid: false,
                        valueFormat: 'number', yMin: null, yMax: null,
                        referenceLines: [], referenceBands: [], unitLabel: null,
                    },
                    style: { span: 4, height: 'md' }, visible: true,
                },
                {
                    id: 'cmp_iarps', type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate', tableId: 'tbl_iainv',
                            groupBy: [{ field: 'supplier_name', as: 'supplier' }],
                            aggregates: [{ fn: 'sum', field: 'amount_total', as: 'spend' }],
                            sort: [{ field: 'spend', dir: 'desc' }],
                            limit: 12,
                        },
                        title: 'Spend by supplier',
                        xKey: 'supplier', xType: 'category',
                        series: [{ key: 'spend', label: 'Gross invoiced' }],
                        stacked: false, showLegend: false, showGrid: true,
                        valueFormat: 'currency', yMin: 0, yMax: null,
                        referenceLines: [], referenceBands: [], unitLabel: null,
                    },
                    style: { span: 6, height: 'md' }, visible: true,
                },
                {
                    id: 'cmp_iarpc', type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate', tableId: 'tbl_iainv',
                            groupBy: [{ field: 'cost_center', as: 'cost_centre' }],
                            aggregates: [{ fn: 'sum', field: 'amount_total', as: 'spend' }],
                            sort: [{ field: 'spend', dir: 'desc' }],
                            limit: 12,
                        },
                        title: 'Spend by cost centre',
                        xKey: 'cost_centre', xType: 'category',
                        series: [{ key: 'spend', label: 'Gross invoiced' }],
                        stacked: false, showLegend: false, showGrid: true,
                        valueFormat: 'currency', yMin: 0, yMax: null,
                        referenceLines: [], referenceBands: [], unitLabel: null,
                    },
                    style: { span: 6, height: 'md' }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iarppv', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iarpph', type: 'heading', props: { text: 'Cost centre against status', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    id: 'cmp_iarppiv', type: 'pivot',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_iainv', sort: [{ field: 'invoice_date', dir: 'desc' }], limit: 500 },
                        rows: [{ key: 'cost_center', label: 'Cost centre' }],
                        columns: [{ key: 'status', label: 'Status' }],
                        values: [{ key: 'amount_total', agg: 'sum', label: 'Gross', format: 'currency' }],
                        showTotals: true,
                        emptyText: 'No invoices to cross-tabulate yet.',
                    },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
    ],
};

const SCREEN_SUPPLIERS = {
    id: 'scr_iasupp', name: 'Suppliers', icon: 'Building2', showInNav: true, maxWidth: 'wide',
    description: 'The supplier master — and the two levers the ladder reads',
    sections: [
        {
            id: 'sec_iasuhdr', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iasuhdr', type: 'page_header',
                    props: {
                        look: 'split', title: 'Suppliers',
                        subtitle: 'Two of these columns are policy, not description.',
                        titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null },
                        icon: 'Building2', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [],
                },
                {
                    id: 'cmp_iasunote', type: 'callout',
                    props: {
                        title: 'Supplier check and Always director',
                        text: '**Supplier check** is copied onto every invoice from this supplier: *Watch list* adds the Finance rung whatever the amount, and *Blocked — do not pay* means no approval is requested at all — the invoice is parked on hold with the reason on its trail. **Always director** puts the director rung in the chain regardless of amount. Both are editable in place; edits are single-column writes with a compare-and-set token, so two people on the same row do not overwrite each other.',
                        tone: 'warning',
                    },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iasugrid', style: { padding: 4, gap: 3, background: 'none' },
            children: [supplierGrid('cmp_iasugrid', { editable: true })],
        },
        {
            id: 'sec_iasunew', style: { padding: 4, gap: 3, background: 'surface' },
            children: [
                {
                    id: 'cmp_iasunewf', type: 'form',
                    props: { name: 'newsupplier', submitLabel: 'Add supplier', showReset: true, showSubmit: true },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    onSubmit: 'act_iasupadd',
                    children: [
                        { id: 'cmp_iasunh', type: 'heading', props: { text: 'Add a supplier', level: 3, accent: 'none' }, style: { span: 12 }, visible: true },
                        { id: 'cmp_iasun1', type: 'input_text', props: { name: 'name', label: 'Supplier', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 5 }, visible: true },
                        { id: 'cmp_iasun2', type: 'input_text', props: { name: 'supplier_no', label: 'Supplier no.', placeholder: null, required: false, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 3 }, visible: true },
                        { id: 'cmp_iasun3', type: 'input_select', props: { name: 'category', label: 'Category', options: SUPPLIER_CATEGORY_OPTIONS, required: false, defaultValue: 'services', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                        { id: 'cmp_iasun4', type: 'input_text', props: { name: 'contact_email', label: 'Contact e-mail', placeholder: null, required: false, defaultValue: null, inputType: 'email', valueFrom: { kind: 'static', value: null } }, style: { span: 5 }, visible: true },
                        { id: 'cmp_iasun5', type: 'input_number', props: { name: 'payment_terms_days', label: 'Payment terms (days)', min: 0, max: 365, step: 1, required: false, defaultValue: 30 }, style: { span: 3 }, visible: true },
                        { id: 'cmp_iasun6', type: 'input_select', props: { name: 'risk', label: 'Supplier check', options: RISK_OPTIONS, required: false, defaultValue: 'standard', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 4 }, visible: true },
                        { id: 'cmp_iasun7', type: 'input_checkbox', props: { name: 'always_director', label: 'Every invoice from this supplier also needs the director', defaultChecked: false }, style: { span: 12 }, visible: true },
                        { id: 'cmp_iasun8', type: 'input_textarea', props: { name: 'notes', label: 'Notes', placeholder: 'Why this supplier is on the watch list, what the framework agreement says…', required: false, rows: 2, valueFrom: { kind: 'static', value: null }, snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title' }, style: { span: 12 }, visible: true },
                    ],
                },
            ],
        },
    ],
};

/**
 * The policy screen. Half of it is the setup checklist for the approver
 * groups, because "the ladder falls back to the owner" has to be findable by
 * somebody who never reads a template's source.
 */
const SCREEN_POLICY = {
    id: 'scr_iapol', name: 'Approval policy', icon: 'Scale', showInNav: true, maxWidth: 'wide',
    description: 'The ladder, written down — and the groups it expects',
    sections: [
        {
            id: 'sec_iaplhdr', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iaplhdr', type: 'page_header',
                    props: {
                        look: 'split', title: 'Approval policy',
                        subtitle: 'Who has to say yes, and when.',
                        titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null },
                        icon: 'Scale', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [],
                },
                {
                    id: 'cmp_iaplsetup', type: 'callout',
                    props: { title: 'Set up the approver groups', text: SETUP_CALLOUT_TEXT, tone: 'warning' },
                    style: { span: 12 }, visible: true,
                },
                {
                    id: 'cmp_iaplmd', type: 'markdown',
                    props: {
                        content: [
                            '### The groups to create',
                            '',
                            'Create these in **Organisation → Groups**, put the right people in them, then open **App Studio → this app → Actions → *Send for approval*** and swap each placeholder for the real group.',
                            '',
                            '| Rung | Placeholder group | Who it means |',
                            '|---|---|---|',
                            '| Team lead | `replace-me-team-leads` | The person who ordered it, or their lead |',
                            '| Budget holder | `replace-me-budget-holders` | Whoever owns the cost centre it is coded to |',
                            '| Finance | `replace-me-finance` | AP / bookkeeping |',
                            '| Finance (2nd seat) | `replace-me-financial-controller` | The controller |',
                            '| Finance (3rd seat) | `replace-me-cfo` | CFO, for the quorum on large invoices |',
                            '| Director | `replace-me-director` | The director who signs commitments |',
                            '| Director (2nd) | `replace-me-managing-director` | The second signature above €25,000 |',
                            '| Board | `replace-me-board` | Only above €100,000 |',
                            '',
                            '### Two ways the route is chosen, and why there are two',
                            '',
                            '**The band picks a ladder.** Under €1,000 one rung; €1,000–€25,000 the everyday four-rung ladder; €25,000 and up a different shape entirely — Finance votes two of three, both directors must agree. Those are different *ladders*, not longer versions of one, which is why the action branches between them with a `switch`.',
                            '',
                            '**A rung can be conditional.** On the everyday ladder, Finance joins from €2,500 (or immediately for a watch-list supplier) and the director joins from €5,000 (or immediately when the supplier is flagged *Always director*). Those are the same ladder with a rung switched on, so they are conditions on the rung — and a rung that is skipped is *kept and marked skipped*, so the finished approval can still answer “why did this never reach Finance?”.',
                            '',
                            '**And a blocked supplier gets no ladder at all.** There is no rung that means “ask nobody”, so that decision is made before the chain exists: the invoice is parked on hold and the trail records why.',
                            '',
                            '_Editing the table below changes what this screen SAYS, not what the app DOES — the chain itself lives in the action, because approver seats and stage rules are step fields rather than data. Keep the two in step; that is what the accompanying test checks._',
                        ].join('\n'),
                        contentFrom: { kind: 'static', value: null },
                    },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iaplgrid', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iaplgh', type: 'heading', props: { text: 'The ladder', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    id: 'cmp_iaplgrid', type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_iapol', sort: [{ field: 'rank', dir: 'asc' }], limit: 50 },
                        columns: [
                            { key: 'rank', label: '#', format: 'number', align: 'right', width: 50 },
                            { key: 'band', label: 'Band', format: 'text', editable: true, width: 150 },
                            { key: 'min_amount', label: 'From', format: 'currency', editable: true, align: 'right', width: 110 },
                            { key: 'max_amount', label: 'Up to', format: 'currency', editable: true, align: 'right', width: 110 },
                            { key: 'stages_label', label: 'Who has to approve', format: 'text', editable: true },
                            { key: 'rule_note', label: 'How it resolves', format: 'text', editable: true },
                            { key: 'seats_label', label: 'Groups to fill in', format: 'text', editable: true },
                            { key: 'active', label: 'Active', format: 'check', editable: true, align: 'center', width: 70 },
                        ],
                        pageSize: 25, selectable: 'none', searchable: false,
                        density: 'comfortable', clamp: '3', zebra: false, look: 'default',
                        rowTone: [], rowActions: [], bulkActions: [], toolbarActions: [],
                        emptyText: 'No policy rows.',
                    },
                    style: { span: 12 }, visible: true,
                    onRowSelect: 'act_iapoledit',
                },
            ],
        },
        {
            id: 'sec_iaplcc', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                { id: 'cmp_iaplcch', type: 'heading', props: { text: 'Cost centres and their budget holders', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                {
                    id: 'cmp_iaplccn', type: 'callout',
                    props: {
                        title: 'One seam, called out on purpose',
                        text: 'The cost-centre CODES also live as a dropdown in the app definition, because a select needs its options at build time. The table below owns the budget holder and the budget; the codes have to agree with the dropdown, and the template’s test asserts they do on install.',
                        tone: 'info',
                    },
                    style: { span: 12 }, visible: true,
                },
                {
                    id: 'cmp_iaplccg', type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_iacc', sort: [{ field: 'key', dir: 'asc' }], limit: 100 },
                        columns: [
                            { key: 'key', label: 'Code', format: 'text', width: 110 },
                            { key: 'name', label: 'Cost centre', format: 'text' },
                            { key: 'owner_name', label: 'Budget holder', format: 'text' },
                            { key: 'budget_year', label: 'Budget this year', format: 'currency', align: 'right' },
                            { key: 'active', label: 'Active', format: 'check', align: 'center', width: 70 },
                        ],
                        pageSize: 25, selectable: 'none', searchable: false,
                        density: 'compact', clamp: '1', zebra: false, look: 'minimal',
                        rowTone: [], rowActions: [], bulkActions: [], toolbarActions: [],
                        emptyText: 'No cost centres.',
                    },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
    ],
};

const SCREEN_AUDIT = {
    id: 'scr_iaaudit', name: 'Audit trail', icon: 'History', showInNav: true, maxWidth: 'wide',
    description: 'Append-only: who did what to which invoice',
    // Finance only. Everyone can WRITE to the trail (every role does something
    // it records); reading the whole company's payment history is a different
    // question from reading the invoice in front of you.
    visibleToRoles: ['finance'],
    sections: [
        {
            id: 'sec_iaauhdr', style: { padding: 4, gap: 2, background: 'none' },
            children: [
                {
                    id: 'cmp_iaauhdr', type: 'page_header',
                    props: {
                        look: 'split', title: 'Audit trail',
                        subtitle: 'Append-only by access matrix, not by convention — nobody, the controller included, can edit a row here.',
                        titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null },
                        icon: 'History', showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 }, visible: true,
                    children: [],
                },
                {
                    id: 'cmp_iaaufil', type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Invoice number', type: 'search', options: [] },
                            { name: 'kind', label: 'What happened', type: 'select', options: EVENT_KIND_OPTIONS },
                        ],
                    },
                    style: { span: 12, gap: 2 }, visible: true,
                },
            ],
        },
        {
            id: 'sec_iaaugrid', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_iaaugrid', type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records', tableId: 'tbl_iaevt',
                            filter: [
                                { field: 'invoice_no', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' } },
                                { field: 'kind', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.kind' } },
                            ],
                            sort: [{ field: 'at', dir: 'desc' }],
                            limit: 500,
                        },
                        columns: [
                            { key: 'at', label: 'When', format: 'datetime', sortable: true, width: 170 },
                            { key: 'invoice_no', label: 'Invoice', format: 'text', sortable: true, width: 140 },
                            { key: 'actor', label: 'Who', format: 'text', width: 160 },
                            { key: 'kind', label: 'What', format: 'badge', toneMap: EVENT_KIND_TONES, width: 150 },
                            { key: 'detail', label: 'Detail', format: 'text' },
                        ],
                        pageSize: 50, selectable: 'none', searchable: false,
                        density: 'compact', clamp: '2', zebra: true, look: 'default',
                        rowTone: [{ field: 'kind', value: 'hold', tone: 'danger' }],
                        rowActions: [], bulkActions: [], toolbarActions: [],
                        emptyText: 'Nothing recorded yet.',
                    },
                    style: { span: 12 }, visible: true,
                },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'Invoice approvals',
        description: 'PDF invoices in, an approval ladder that fits the amount and the supplier, and a record of who said yes.',
        icon: 'FileCheck',
    },
    theme: { primary: '#0F766E', ...THEME_DEFAULTS },
    // Identity: "cloud" in teal — a finance tool that reads as a product
    // rather than as an admin console, with soft surfaces so the KPI tiles and
    // the document pane sit apart from the page.
    design: { preset: 'cloud', font: 'inter', surface: 'soft', motion: 'full', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
    nav: {
        style: 'sidebar',
        groups: [
            { id: 'nvg_iawork', label: 'Work', icon: 'Inbox', screens: ['scr_iahome', 'scr_iaintake', 'scr_iainvs'] },
            { id: 'nvg_iadec', label: 'Decide', icon: 'ShieldCheck', screens: ['scr_iaappr', 'scr_iapay'] },
            { id: 'nvg_iains', label: 'Insight', icon: 'BarChart3', screens: ['scr_iarep'] },
            { id: 'nvg_iaset', label: 'Setup', icon: 'Settings', screens: ['scr_iasupp', 'scr_iapol', 'scr_iaaudit'] },
        ],
    },
    homeScreenId: 'scr_iahome',
    roles: [
        { id: 'finance', name: 'Finance (controller)' },
        { id: 'ap', name: 'Accounts payable' },
        { id: 'approver', name: 'Approver' },
    ],
    /**
     * `filters` is NOT declared — it is reserved, owned by filter_bar, which
     * republishes the whole object on every keystroke.
     *
     * Both variables hold a SELECTION. `invoice` is the important one: the
     * detail screen reads only its `id` and re-reads the row for every value
     * on screen, so a decision that lands while you are looking at it appears
     * on the next refetch instead of leaving a stale copy. The one exception
     * is the approval attachment, which reads `vars.invoice.document` because
     * a server step cannot resolve a record binding.
     */
    variables: [
        { name: 'invoice', label: 'Open invoice', type: 'record', default: null, description: 'The invoice the detail screen is scoped to, published by every route into it.' },
        { name: 'payinv', label: 'Invoice being paid', type: 'record', default: null, description: 'The row the Record-payment dialog is about.' },
    ],
    screens: [
        SCREEN_HOME,
        SCREEN_INTAKE,
        SCREEN_INVOICES,
        SCREEN_DETAIL,
        SCREEN_APPROVALS,
        SCREEN_PAYMENTS,
        SCREEN_REPORTING,
        SCREEN_SUPPLIERS,
        SCREEN_POLICY,
        SCREEN_AUDIT,
    ],
    actions,
};

module.exports = {
    id: 'app-invoice-approvals',
    version: 1,
    title: 'Invoice approvals',
    description: 'Drop a supplier invoice in as a PDF, let AI read the supplier, number, dates, VAT and line items off it, then send it up an approval ladder that fits the amount and the supplier — one rung for a small one, four for the everyday case with Finance and the director joining only when they have to, five with a Finance quorum and two director signatures for the large ones. A blocked supplier is parked and nobody is asked. The decision writes itself back onto the invoice, and Payments tracks what is approved but still owed.',
    category: 'Data',
    icon: 'FileCheck',
    tags: ['invoices', 'approvals', 'finance', 'accounts-payable', 'pdf', 'ai', 'workflow'],
    definition,
    dataModel,
    seed,
};
