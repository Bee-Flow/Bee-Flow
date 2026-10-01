/**
 * Approval + form-page pause steps (extracted verbatim from engine.js): the
 * two run-pause sentinels (ApprovalRequiredError, FormInputRequiredError),
 * their renderers, and the isRunPause predicate every dispatcher checks.
 */

const { interpolateTemplate, isTextValue } = require('../../automation/bind');
const { evaluate } = require('../../automation/expr');
const { desugarApprovalStages } = require('../../automation/approvalStages');
const { resolveApprovalTtlMs } = require('./shared');

// ── Approval step ───────────────────────────────────────
//
// Pauses the run by throwing a sentinel that executeAutomation catches.
// The caller persists the awaiting state + a single-use approval token,
// then finalises the run row in 'awaiting_approval'. A subsequent
// POST /runs/:runId/approve-step starts a fresh executeAutomation that
// uses resumeFromStep to skip everything up to and including the
// approval step.

class ApprovalRequiredError extends Error {
    constructor(stepId, prompt, expiresAt = null, extras = {}) {
        super(`Approval required at step ${stepId}`);
        this.name = 'ApprovalRequiredError';
        this.stepId = stepId;
        this.prompt = prompt;
        // ISO deadline after which the reaper expires this paused run (§WS2.2),
        // or null when approval expiry is disabled.
        this.expiresAt = expiresAt;
        // Everything below is RENDERED AT PAUSE TIME and snapshotted onto the
        // approval row by the finalize path. The run state the templates
        // referenced is unrecoverable later (the same reason a paused form
        // page snapshots its rendered config), so this sentinel is the one
        // moment the material can be captured.
        this.detailsMd = extras.detailsMd ?? null;         // rendered markdown, or null
        this.fields = extras.fields ?? null;               // rendered field declaration, or null
        this.attachmentFileIds = extras.attachmentFileIds ?? []; // resolved generated-file ids
        this.assignee = extras.assignee ?? null;           // { userId } | { groupId } | null
        // Reminder + escalation clocks, in hours from the pause — turned into
        // timestamps (and the target org-checked) by createApprovalOnPause.
        this.remindAfterHours = extras.remindAfterHours ?? null;
        this.escalateTo = extras.escalateTo ?? null;       // { userId } | { groupId } | null
        this.escalateAfterHours = extras.escalateAfterHours ?? null;
        // Panel: seats, the decision rule, and the optional final sign-off.
        this.approvers = extras.approvers ?? null;         // [ {userId}|{groupId}, … ] | null
        this.rule = extras.rule ?? null;                   // 'all' | 'first' | 'quorum' | null
        this.quorum = extras.quorum ?? null;
        this.finalApprover = extras.finalApprover ?? null; // { userId } | { groupId } | null
    }
}

/**
 * The question the approver reads, rendered against the paused run.
 *
 * Interpolated for the same reason a notification body is: this string is the
 * ONLY thing a human sees before deciding, so "Send the {{steps.t.output.total}}
 * invoice?" has to name the amount. Un-rendered it asks someone to approve a
 * pair of braces — templates.js already ships an approval whose prompt carries
 * bindings, so the raw-braces version was reaching real approvers.
 *
 * Secrets are stripped first (`{ ...runState, secrets: {} }` — the same
 * allowSecrets:false idiom renderFormPage uses), because this text is read by a
 * person and leaves the platform in the approval email.
 */
function renderApprovalPrompt(step, runState) {
    // A compose (a text with picked values) renders through the same call.
    if (isTextValue(step.prompt) && (typeof step.prompt !== 'string' || step.prompt.trim())) {
        const safeState = { ...runState, secrets: {} };
        return interpolateTemplate(step.prompt, safeState);
    }
    // `title` is the legacy field: still read so imported and pre-editor
    // definitions keep working, never written by the builder.
    return step.title || 'Approval requested';
}

/**
 * The rich half of the approval: everything BEYOND the one-line question,
 * rendered against the paused run with the renderFormPage idiom (secrets
 * stripped, listAsMarkdown so interpolated arrays read as bullets — this text
 * is read by a person deciding something).
 *
 *   details     — a markdown template; rendered and length-capped.
 *   fields      — extra questions for the approver, in the form-contract
 *                 vocabulary; labels/help are interpolated, option VALUES stay
 *                 raw (they are the closed vocabulary coerceSubmission checks
 *                 the decision against).
 *   attachments — bindings that resolve to generated-file ids; resolved here,
 *                 verified and enriched (filename/size) by the finalize path,
 *                 which is where the run's file ledger is in reach.
 */
function renderApprovalExtras(step, runState) {
    const a = (step && step.approval) || {};
    const safeState = { ...runState, secrets: {} };
    const interpolate = (s) => interpolateTemplate(s, safeState, { listAsMarkdown: true });
    const { renderFormConfig, MAX_RENDERED_DESCRIPTION_LEN } = require('../../automation/formTriggerContract');

    const detailsMd = (typeof a.details === 'string' && a.details.trim())
        ? interpolate(a.details).slice(0, MAX_RENDERED_DESCRIPTION_LEN)
        : null;

    let fields = null;
    if (Array.isArray(a.fields) && a.fields.length) {
        fields = renderFormConfig({ fields: a.fields }, { interpolate }).fields || null;
        if (fields && !fields.length) fields = null;
    }

    const attachmentFileIds = [];
    if (Array.isArray(a.attachments)) {
        for (const att of a.attachments) {
            const raw = att && typeof att.binding === 'string' ? interpolate(att.binding).trim() : '';
            if (raw) attachmentFileIds.push({ fileId: raw, label: typeof att?.label === 'string' ? att.label : null });
        }
    }

    const oneOf = (v) => (v && typeof v === 'object')
        ? (typeof v.userId === 'string' && v.userId
            ? { userId: v.userId }
            : (typeof v.groupId === 'string' && v.groupId ? { groupId: v.groupId } : null))
        : null;
    const assignee = oneOf(a.assignee);

    // Panel: seats + rule + optional final sign-off. Carried raw — the
    // lifecycle validates each seat's org membership when the row is created.
    const approvers = Array.isArray(a.approvers)
        ? a.approvers.map(oneOf).filter(Boolean).slice(0, 10)
        : null;
    const rule = ['all', 'first', 'quorum'].includes(a.rule) ? a.rule : null;
    const quorum = Number.isFinite(Number(a.quorum)) ? Math.round(Number(a.quorum)) : null;
    const finalApprover = oneOf(a.finalApprover);

    // The stage chain, resolved HERE — once, against the paused run.
    //
    // Stage names and descriptions are interpolated like the prompt (an
    // approver reading "Finance sign-off for {{steps.x.output.supplier}}"
    // must see the supplier), and each stage's `when` is evaluated against
    // the run state with the same expression engine a condition step uses.
    // Resolving conditions at request time rather than at hand-over time is
    // deliberate: the chain an approver is shown is the chain that will run,
    // and a value that changes mid-approval cannot silently re-route a
    // request someone is already looking at. A stage whose condition is false
    // is kept and marked skipped — "why did this never reach finance?" is an
    // audit question, and a stage that vanished cannot answer it.
    //
    // This also subsumes the legacy shapes: a panel becomes a one-stage
    // chain, a panel with a final approver a two-stage one, under the very
    // keys ('panel', 'final') the panel release already filed its votes
    // under. The five panel fields above stay populated as legacy mirrors.
    const stages = desugarApprovalStages(a, {
        interpolate,
        evaluateWhen: (expr) => !!evaluate(expr, safeState),
    });

    // Reminder + escalation clocks (hours from the pause). Carried raw here;
    // approvalLifecycle turns them into timestamps and validates the
    // escalation target's org membership when the row is created.
    const clampHours = (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.min(Math.round(Number(v)), 720) : null);
    const remindAfterHours = clampHours(a.remindAfterHours);
    const escalateTo = oneOf(a.escalateTo);
    const escalateAfterHours = escalateTo ? clampHours(a.escalateAfterHours) : null;

    return {
        detailsMd, fields, attachmentFileIds, assignee,
        remindAfterHours,
        escalateTo: escalateAfterHours ? escalateTo : null,
        escalateAfterHours,
        approvers: approvers && approvers.length ? approvers : null,
        rule: approvers && approvers.length ? (rule || 'all') : null,
        quorum,
        finalApprover,
        stages,
    };
}

async function execApproval(step, ctx, runState, mode) {
    // Runtime backstop (validation also rejects this at save time): the
    // approve/resume flow replays the PARENT graph from the paused step id —
    // a pause inside a layer's sub-graph has no resumable address.
    if (ctx.layerStack?.length) {
        throw new Error('Approval steps are not supported inside layers');
    }
    // Approvals are an Enterprise capability, and the gate belongs HERE —
    // before the run pauses, not after. Checking it in createApprovalOnPause
    // would leave a run parked in awaiting_approval with no record and nobody
    // able to list it: the worst of both outcomes. Failing the step instead
    // stops the run with something a person can read and act on.
    //
    // Note what is NOT gated: an approval already pending keeps its detail
    // page, its decide route and its withdraw route. A licence that lapses
    // must let the work already in flight finish, never strand it.
    if (mode !== 'dry_run') {
        const { hasCapability } = require('../entitlements/entitlements');
        const licensed = await hasCapability('approvals', { userId: ctx.userId, orgId: ctx.orgId, session: ctx.session });
        if (!licensed) {
            const err = new Error('Approvals are an Enterprise feature — this routine cannot ask for one on the current plan.');
            err.errorClass = 'license_required';
            throw err;
        }
    }
    const prompt = renderApprovalPrompt(step, runState);
    if (mode === 'dry_run') {
        // In dry-run we synthesise auto-approve so the rest of the flow
        // can preview without a human in the loop. The prompt is rendered
        // here too — previewing an approval is largely about checking that
        // the question reads correctly once its bindings resolve. Answers
        // are an empty object so a downstream binding of output.answers.x
        // previews as blank rather than crashing the dry run.
        return { output: { approved: true, _dryRun: true, prompt, answers: {} } };
    }
    // The deadline (§WS2.2) is computed here from the step config; the
    // finalize path persists it, creates the durable approval row from the
    // extras on this sentinel, and sends the notification with the live link.
    const ttlMs = resolveApprovalTtlMs(step);
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
    throw new ApprovalRequiredError(step.id, prompt, expiresAt, renderApprovalExtras(step, runState));
}

// ── Form page step ──────────────────────────────────────
//
// The mid-workflow half of the form trigger: a second (third, …) page shown
// on the SAME /f/<token> URL the visitor is already on.
//
//   mode 'input'  — pause the run and wait for the visitor's answers. Same
//                   sentinel-throw mechanism as approval; the answers come
//                   back as the step's synthetic output via resumeFromStep,
//                   so downstream binds steps.<id>.output.<fieldName>.
//   mode 'ending' — the closing page (typically a summary of what ran). It
//                   does NOT pause: it records the page it wants shown and
//                   lets the run finish, so work after it still happens.
//
// The page's text is TEMPLATED against the paused run — that is what makes
// "show a summary of the execution" possible without a second contract.

const FORM_WAIT_DEFAULT_MS = 60 * 60_000;          // 1 hour
const FORM_WAIT_MIN_MS = 60_000;                   // 1 minute
const FORM_WAIT_MAX_MS = 7 * 24 * 60 * 60_000;     // 7 days

/** Deadline (ms from now) for a paused form step. Always finite: a visitor is waiting. */
function resolveFormWaitMs(step) {
    const secs = Number(step?.waitSeconds);
    if (!Number.isFinite(secs) || secs <= 0) return FORM_WAIT_DEFAULT_MS;
    return Math.min(FORM_WAIT_MAX_MS, Math.max(FORM_WAIT_MIN_MS, Math.round(secs) * 1000));
}

class FormInputRequiredError extends Error {
    constructor(stepId, form, expiresAt = null) {
        super(`Form input required at step ${stepId}`);
        this.name = 'FormInputRequiredError';
        this.stepId = stepId;
        // The fully rendered, visitor-safe page config. It is persisted on the
        // awaiting step row and served verbatim by the public poll endpoint —
        // re-deriving it later is impossible, because by then the run state
        // that the templates referenced is only in the step-output history.
        this.form = form;
        this.expiresAt = expiresAt;
    }
}

/**
 * True for either sentinel that PAUSES a run rather than failing it.
 *
 * Both must bypass on_error routing, per-item loop retry and parallel's
 * allSettled flattening — an error branch that "handled" a pause would walk
 * straight past a human who is still waiting. Keep every call site using this
 * predicate so a third pause kind can never be half-wired.
 */
function isRunPause(e) {
    return e instanceof ApprovalRequiredError || e instanceof FormInputRequiredError;
}

/**
 * Render a form_page's declaration against the run.
 *
 * Secrets are stripped from the state FIRST — `{ ...runState, secrets: {} }` is
 * the same allowSecrets:false idiom resolveValue uses for notification bodies.
 * This config is served to an ANONYMOUS visitor, so `{{secrets.x}}` must render
 * blank, never the value.
 *
 * `listAsMarkdown` because a form page's text is the one place interpolation
 * output is READ BY A PERSON, and is rendered as markdown. A step that produced
 * a list of findings used to drop `["Productaanbod van RVS platen…","Algemene
 * bedrijfspresentatie…"]` — brackets, quotes and all — into the middle of a
 * sentence the customer was asked to act on. As bullets it is the same data,
 * legible. Nowhere else gets this: JSON is the right rendering for a prompt,
 * a URL or a header.
 */
function renderFormPage(step, runState, { baseTheme = null } = {}) {
    const { renderFormConfig } = require('../../automation/formTriggerContract');
    const safeState = { ...runState, secrets: {} };
    return renderFormConfig(step.form, {
        interpolate: (s) => interpolateTemplate(s, safeState, { listAsMarkdown: true }),
        baseTheme,
    });
}

async function execFormPage(step, ctx, runState, mode) {
    // Runtime backstop (validate.js rejects this at save time too): resume
    // replays the PARENT graph by step id, so a pause inside a layer's
    // sub-graph has no resumable address — same reason as approval.
    if (ctx.layerStack?.length) {
        throw new Error('Form steps are not supported inside layers');
    }

    const baseTheme = ctx.formBaseTheme || null;
    const isEnding = step.mode === 'ending';
    const rendered = renderFormPage(step, runState, { baseTheme });

    if (isEnding) {
        // Nothing to wait for. The public poll endpoint picks this row up once
        // the run goes terminal and shows it instead of the generic thank-you.
        return { output: { shown: true, mode: 'ending', form: rendered } };
    }

    if (mode === 'dry_run') {
        // Synthesise blank answers so downstream bindings resolve in a preview
        // rather than pausing a run nobody is watching.
        const blank = {};
        for (const f of rendered.fields) {
            blank[f.name] = f.type === 'checkbox' ? false : (f.type === 'file' ? null : '');
        }
        return { output: { ...blank, _dryRun: true } };
    }

    throw new FormInputRequiredError(step.id, rendered, new Date(Date.now() + resolveFormWaitMs(step)).toISOString());
}

module.exports = {
    ApprovalRequiredError, renderApprovalPrompt, renderApprovalExtras, execApproval,
    FORM_WAIT_DEFAULT_MS, FORM_WAIT_MIN_MS, FORM_WAIT_MAX_MS,
    resolveFormWaitMs, FormInputRequiredError, isRunPause, execFormPage,
};
