// @typecheck strict
/**
 * App Studio catalog — what every BASE step kind is, beyond its fields
 * (actionSpecs.js STEP_SPECS): where it runs, which execution form may run it,
 * which budget it spends and the flags the validators and summaries read.
 * A step kind of the registry (steps/<kind>.js) carries the same keys in its own
 * file; stepRegistry.js joins the two and derives every kind list from them.
 *
 * The key order is the order of STEP_KINDS (componentSpecs.test.js holds it).
 *
 * `policy` has one row per execution form. A kind without a row is refused in
 * that form (stepRegistry.stepPolicy), so a missing answer never runs a step.
 *   click        a person clicks, signed in: 'browser' (the browser runs it), 'step' (POST /step),
 *                'stream' (the streaming endpoint only), 'refuse'
 *   background   a sequence with background: true: 'run', 'defer' (replayed by the browser when
 *                the job ends), 'lead' (only as the leading steps, asked before the job starts), 'refuse'
 *   mailboxHook  the mailbox "new record" hook: 'run', 'refuse'
 *   unattended   reserved for later triggers (schedule, record change, webhook); nothing reads it yet
 *   mcpRun       app_run_action with dryRun: false: 'run', 'draft' (send_email: a draft only), 'skip', 'refuse'
 *   mcpDryRun    app_run_action with dryRun: true: 'mock' (runs, a test may give it a fixed answer),
 *                'run' (runs, never mocked), 'skip'
 *   public       an anonymous visitor of a public page: 'browser', 'step', 'stream', 'refuse'
 */

'use strict';

/** @typedef {'client' | 'server' | 'control'} StepSide */
/** @typedef {{ click: string, background: string, mailboxHook: string, unattended: string, mcpRun: string, mcpDryRun: string, public: string }} StepPolicy */
/** @typedef {{ severity: 'error' | 'warning', code: string, message: string, hint: string }} InLoopFinding */
/** @typedef {{ field: string, as?: string, where?: string, loop?: boolean }} VarWrite */
/**
 * What the catalogue says about one step kind:
 *   side           client: browser chrome; control: flow the walkers evaluate; server: executed on the API
 *   retrySafe      a failed step may be tried again (false: its effect leaves Bee Flow or waits on a person)
 *   budget         server kinds: the limiter bucket (routes/studioAppStepBudget.mts)
 *   handler        server kinds: a case in actionExecutor/dispatch.js, or actionExecutor/steps/<kind>.mts
 *   writesRecords  writes rows of the app table its `tableId` names
 *   noLoop         may never sit inside a loop (an error)
 *   inLoop         the finding a loop holding this kind gets
 *   summary        its text in the builder's one-line step summary (default: the kind)
 *   writesVars     fields naming a variable the step writes (next to `resultVar`)
 *   since          the schema version that introduced it (registry kinds only)
 *
 * @typedef {{
 *   side: StepSide,
 *   policy: StepPolicy,
 *   retrySafe: boolean,
 *   budget?: 'ai' | 'heavy' | 'light',
 *   handler?: 'builtin' | 'file',
 *   writesRecords?: boolean,
 *   noLoop?: boolean,
 *   inLoop?: InLoopFinding,
 *   summary?: (step: Record<string, unknown>) => string,
 *   writesVars?: readonly VarWrite[],
 *   since?: number,
 * }} StepMeta
 */

/** The values a policy row may hold, per execution form. */
const POLICY_FORMS = Object.freeze({
    click: Object.freeze(['browser', 'step', 'stream', 'refuse']),
    background: Object.freeze(['run', 'defer', 'lead', 'refuse']),
    mailboxHook: Object.freeze(['run', 'refuse']),
    unattended: Object.freeze(['run', 'refuse']),
    mcpRun: Object.freeze(['run', 'draft', 'skip', 'refuse']),
    mcpDryRun: Object.freeze(['mock', 'run', 'skip']),
    public: Object.freeze(['browser', 'step', 'stream', 'refuse']),
});

/** @param {StepPolicy} p */
const row = (p) => Object.freeze(p);

// Browser chrome: needs the visitor's page.
const CHROME = row({ click: 'browser', background: 'refuse', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' });
// Browser effects a background job records and the browser replays.
const DEFERRED = row({ ...CHROME, background: 'defer' });
// Flow the server walkers evaluate themselves.
const WALKED = row({ click: 'browser', background: 'run', mailboxHook: 'refuse', unattended: 'refuse', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' });
// The branches an arriving mail may take as well.
const BRANCH = row({ ...WALKED, mailboxHook: 'run' });
// Server work that stays inside Bee Flow: runs wherever a server step runs.
const INTERNAL = row({ click: 'step', background: 'run', mailboxHook: 'run', unattended: 'refuse', mcpRun: 'run', mcpDryRun: 'skip', public: 'step' });
// Reads and model calls: a dry run executes them (and a test may mock them).
const READS = row({ ...INTERNAL, mcpDryRun: 'mock' });
// Reaches people or needs a viewer's session: only a click (or a background job a click started).
const PERSON = row({ ...INTERNAL, mailboxHook: 'refuse', mcpRun: 'refuse' });

/** @param {string} field */
const recordSummary = (field) => (/** @type {Record<string, unknown>} */ s) => `${String(s.kind)}(${String(s[field] || '?')})`;
/** @param {Record<string, unknown>} s */
const branchSummary = (s) => `${String(s.kind)}{…}`;

const CLIENT = Object.freeze({ side: 'client', retrySafe: true });
const CONTROL = Object.freeze({ side: 'control', retrySafe: true });
const SERVER = Object.freeze({ side: 'server', retrySafe: true, handler: 'builtin' });
const RECORD_WRITE = Object.freeze({ ...SERVER, budget: 'light', writesRecords: true, summary: recordSummary('tableId') });

/** @type {Readonly<Record<string, StepMeta>>} */
const BASE_STEP_META = /** @type {Readonly<Record<string, StepMeta>>} */ (Object.freeze({
    navigate: { ...CLIENT, policy: CHROME, summary: (/** @type {Record<string, unknown>} */ s) => `navigate→${String(s.screenId)}` },
    toast: { ...CLIENT, policy: DEFERRED },
    open_url: { ...CLIENT, policy: CHROME },
    open_modal: { ...CLIENT, policy: CHROME },
    close_modal: { ...CLIENT, policy: CHROME },
    reset_form: { ...CLIENT, policy: CHROME },
    download_file: { ...CLIENT, policy: CHROME },
    confirm: { ...CLIENT, policy: row({ ...CHROME, background: 'lead' }) },
    set_variable: { ...CLIENT, policy: WALKED, writesVars: Object.freeze([{ field: 'name', as: 'set_variable', where: '' }]) },
    refresh: { ...CLIENT, policy: DEFERRED },
    run_automation: { ...SERVER, retrySafe: false, policy: PERSON, budget: 'heavy', summary: (/** @type {Record<string, unknown>} */ s) => `run_automation(${String(s.automationId ?? 'null')})` },
    create_record: { ...RECORD_WRITE, policy: INTERNAL },
    update_record: { ...RECORD_WRITE, policy: INTERNAL },
    // Nothing erases data on an arriving mail; an owner's app_run_action may.
    delete_record: { ...RECORD_WRITE, policy: row({ ...INTERNAL, mailboxHook: 'refuse' }) },
    request_approval: { ...SERVER, retrySafe: false, policy: PERSON, budget: 'light' },
    ai_extract: { ...SERVER, policy: READS, budget: 'ai' },
    ai_generate: { ...SERVER, policy: READS, budget: 'ai' },
    kb_query: { ...SERVER, policy: READS, budget: 'ai' },
    // app_run_action only ever saves a draft, and never inside a loop (mcpRunActionPolicy.decideStep).
    send_email: { ...SERVER, retrySafe: false, policy: row({ ...PERSON, mcpRun: 'draft' }), budget: 'heavy', noLoop: true },
    generate_file: {
        ...SERVER, policy: INTERNAL, budget: 'heavy',
        // Legal (one file per order is a real shape) but easy to reach by accident: each iteration
        // writes a blob against the app's attachment quota, and a quota 409 halfway leaves a partial run.
        inLoop: {
            severity: 'warning', code: 'action.generate_file_in_loop',
            message: 'A "generate file" step runs inside a loop — one stored file per iteration.',
            hint: 'Usually one file over all rows is wanted; bind `rows` to the whole set instead of looping.',
        },
    },
    fill_document: {
        ...SERVER, policy: INTERNAL, budget: 'heavy',
        // The same quota shape the other way round: one invoice PER row is the normal thing to
        // want, so it warns about the cost rather than the intent.
        inLoop: {
            severity: 'warning', code: 'action.fill_document_in_loop',
            message: 'A "fill document" step runs inside a loop — one stored PDF per iteration.',
            hint: 'That is usually intended (one invoice per row); keep the list short, since each file counts against the app\'s storage quota.',
        },
    },
    generate_presentation: {
        ...SERVER, policy: INTERNAL, budget: 'heavy',
        // A deck inside a loop is the fill_document shape: one stored file per iteration.
        inLoop: {
            severity: 'warning', code: 'action.generate_presentation_in_loop',
            message: 'A "generate presentation" step runs inside a loop — one stored deck per iteration.',
            hint: 'Usually one deck over all rows is wanted; bind `slides` to the whole set instead of looping.',
        },
    },
    redact_pdf: { ...SERVER, policy: INTERNAL, budget: 'ai' },
    file_intake: { ...SERVER, policy: INTERNAL, budget: 'heavy' },
    dataset_query: { ...SERVER, policy: READS, budget: 'light' },
    // Streams into the visitor's page: the streaming endpoint only.
    ai_browse: { ...SERVER, retrySafe: false, policy: row({ ...PERSON, click: 'stream', background: 'refuse', public: 'stream' }), budget: 'light' },
    copy_document: { ...SERVER, retrySafe: false, policy: PERSON, budget: 'heavy' },
    // The KB query log holds what people asked: never for an anonymous visitor.
    kb_log_query: { ...SERVER, policy: row({ ...PERSON, mcpDryRun: 'run', public: 'refuse' }), budget: 'light' },
    kb_log_review: { ...SERVER, policy: row({ ...PERSON, public: 'refuse' }), budget: 'light' },
    condition: { ...CONTROL, policy: BRANCH, summary: branchSummary },
    loop: {
        ...CONTROL, policy: WALKED, summary: branchSummary,
        writesVars: Object.freeze([{ field: 'itemVar', loop: true }, { field: 'indexVar', loop: true }]),
    },
    switch: { ...CONTROL, policy: BRANCH, summary: branchSummary },
    call_action: { ...CONTROL, policy: WALKED, summary: (/** @type {Record<string, unknown>} */ s) => `call_action→${String(s.actionId)}` },
    transaction: {
        ...SERVER, policy: INTERNAL, budget: 'light',
        summary: (/** @type {Record<string, unknown>} */ s) => `transaction{${Array.isArray(s.steps) ? s.steps.length : 0}}`,
    },
}));

module.exports = { BASE_STEP_META, POLICY_FORMS };
