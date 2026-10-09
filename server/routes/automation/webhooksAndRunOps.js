// §WS5 #4 — webhook management + run details/retry/approve/cancel/agent-invoke,
// extracted verbatim from routes/automation.js.
const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const { webhookUrlForSlug, formUrlForToken } = require('../../automation/publicUrl');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { HttpError } = require('../../core/http/errors');
// Handoff 5 sharing: what a role may do with an automation and its runs.
const { makeAutomationAccess, mayReadRun, roleSatisfies } = require('../../automation/access');
const { isTestRun } = require('../../core/automationRunner/definitionForRun');
const automationAccess = makeAutomationAccess({ store: automationStore });

// The caller's access to the automation behind a RUN, or null after a 403
// (see runGuard in automation/access.js for the 'read' / 'act' / 'edit' rules).
const runAccess = (req, res, run, need) => automationAccess.runGuard(req, res, run, need);

// Per-user throttle for the run-spawning endpoints (retry re-executes a run;
// agent-invoke runs an agent-callable automation). Same budget as the other
// run-trigger endpoints (routes/automation/runs.js). Keyed by session user id.
const RUN_TRIGGER_RPM = parseInt(process.env.AUTOMATION_RUN_TRIGGER_RPM, 10) || 30;
const runTriggerLimiter = perUserRateLimit({ windowMs: 60_000, max: RUN_TRIGGER_RPM });

// ── What a caller may send ──────────────────────────────────────────
//
// Every schema is `.strict()`: a key this router does not read is a client
// bug, and answering 200 to it means the person watches a setting they typed
// fail to stick with nothing on screen to explain it.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/**
 * A body that also accepts NO body at all. Express 5 leaves `req.body`
 * undefined when a POST carries none, and several of these are sent exactly
 * that way — an approve with no body has always meant "approve".
 */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const STEP_ID_TEXT = 'triggerStepId is the id of a trigger on this automation.';
/** Omitted → the primary trigger. Which trigger it names is checked against the graph. */
const TriggerStepBody = bodyOf({
    triggerStepId: worded(STEP_ID_TEXT).trim().min(1, STEP_ID_TEXT).nullish(),
});

const DECISION_TEXT = 'decision is "approve" or "reject".';
/**
 * Absent, blank or null all mean approve: the builder's bar has one button and
 * it approves, and every deployed caller sends no body at all. The default may
 * never be WIDER than an explicit approval — it IS one.
 */
const Decision = z.preprocess((v) => {
    // Case folds, whitespace does NOT: " approve " is a caller that built the
    // value out of something, and on an approval gate an unreadable decision
    // is refused rather than guessed at.
    const said = typeof v === 'string' ? v.toLowerCase() : v;
    return said === undefined || said === null || said === '' ? 'approve' : said;
}, z.enum(['approve', 'reject'], { errorMap: () => ({ message: DECISION_TEXT }) }));
const Reason = worded('reason must be text.').trim().max(2000, 'A reason is at most 2000 characters.').optional();

const ApproveStepBody = bodyOf({
    decision: Decision,
    reason: Reason,
    // The answers belong to the form the approval asked for, and the form
    // contract coerces them field by field.
    answers: z.unknown().optional(),
});

const ApproveRunBody = bodyOf({ decision: Decision, reason: Reason });
const CancelRunBody = bodyOf({ reason: Reason });

const SOURCE_TEXT = 'source is the id of a pick source.';
const FormPickBody = bodyOf({
    source: worded(SOURCE_TEXT).trim().min(1, SOURCE_TEXT),
    // clampQuery and clampLimit in automation/formPickRecord are the one
    // place these two are narrowed; narrowing them again here would be a
    // second answer to the same question.
    query: z.unknown().optional(),
    limit: z.unknown().optional(),
});

const AgentInvokeBody = bodyOf({
    // Whatever this automation's agent_call trigger declares it takes.
    args: z.record(z.unknown(), { invalid_type_error: 'args is an object of the automation\'s own inputs.' }).default({}),
});

const ATTEMPTS_TEXT = 'attempts is the attempt number of the step row, a whole number from 1.';
/** Which attempt's row the full output belongs to; omitted → the first. */
const FullOutputQuery = z.object({
    attempts: z.coerce.number({ invalid_type_error: ATTEMPTS_TEXT })
        .int(ATTEMPTS_TEXT).min(1, ATTEMPTS_TEXT).default(1),
}).strict();

const RunFormBody = bodyOf({
    stepId: worded('stepId is the id of the form page being answered.').trim().min(1, 'stepId is the id of the form page being answered.').optional(),
    values: z.record(z.unknown(), { invalid_type_error: 'values maps a field id to its answer.' }).default({}),
});


router.post('/:id/webhook', validate({ body: TriggerStepBody }), async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;

    // Optional triggerStepId (scoped multi-trigger slice): which trigger
    // node this webhook URL fires. Omitted → the primary trigger (today's
    // sole behavior). When provided, it must name an ACTUAL webhook-kind
    // trigger on this automation — otherwise a typo'd/removed id would
    // silently fire the wrong branch of the graph forever.
    let triggerStepId = null;
    if (req.body.triggerStepId) {
        const candidates = [a.definition?.trigger, ...(Array.isArray(a.definition?.triggers) ? a.definition.triggers : [])];
        const match = candidates.find(t => t?.id === req.body.triggerStepId);
        if (!match) return res.status(400).json({ error: 'triggerStepId does not match any trigger on this automation' });
        if (match.kind !== 'webhook') return res.status(400).json({ error: `Trigger "${req.body.triggerStepId}" is not a webhook trigger` });
        triggerStepId = match.id;
    }

    const wh = await automationStore.createWebhook(a.id, triggerStepId);
    // Absolute, not the relative path this used to return: the client shows
    // this URL for the user to paste into an external system, so a
    // path-only value is unusable (BFSF-320).
    res.json({ webhook: { ...wh, url: webhookUrlForSlug(wh.id, req) }, url: webhookUrlForSlug(wh.id, req) });
});

router.get('/:id/webhooks', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    const list = await automationStore.getWebhooksForAutomation(a.id);
    // Carry the absolute URL on every row so the trigger-node panel can
    // show it without reconstructing the origin client-side (BFSF-320).
    res.json({ webhooks: list.map(w => ({ ...w, url: webhookUrlForSlug(w.id, req) })) });
});

/**
 * Rotate a webhook's HMAC secret. The slug (URL) stays the same; any caller
 * still using the old secret immediately receives 401. The new secret is
 * returned ONCE so the user can copy it before navigating away — we don't
 * store it in plaintext anywhere the UI can re-read.
 */
router.post('/:id/webhook/:slug/rotate', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    const rotated = await automationStore.rotateWebhookSecret(req.params.slug, a.id);
    if (!rotated) return res.status(404).json({ error: 'Webhook not found' });
    res.json({ webhook: rotated });
});

router.delete('/:id/webhook/:slug', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    const ok = await automationStore.deleteWebhook(req.params.slug, a.id);
    if (!ok) return res.status(404).json({ error: 'Webhook not found' });
    res.json({ success: true });
});

// ── Form pages (`kind: 'form'`) ───────────────────────
//
// Same owner-only shape as the webhook endpoints above. The one real
// difference: the form's token IS its URL and its credential in one, so there
// is no secret to rotate — rotating means minting a new row, and the old link
// stops working immediately.

/** Which trigger node on this automation a form URL may be issued for. */
async function resolveFormTrigger(a, requestedId) {
    const candidates = [a.definition?.trigger, ...(Array.isArray(a.definition?.triggers) ? a.definition.triggers : [])];
    if (requestedId === undefined || requestedId === null) {
        const primary = a.definition?.trigger;
        return primary?.kind === 'form' ? { ok: true, id: null } : { ok: false, error: 'This automation does not start with a form trigger' };
    }
    const match = candidates.find(t => t?.id === requestedId);
    if (!match) return { ok: false, error: 'triggerStepId does not match any trigger on this automation' };
    if (match.kind !== 'form') return { ok: false, error: `Trigger "${requestedId}" is not a form trigger` };
    return { ok: true, id: match.id };
}

router.post('/:id/form', validate({ body: TriggerStepBody }), async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;

    const resolved = await resolveFormTrigger(a, req.body.triggerStepId);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });

    // One live URL per trigger node. Asking twice returns the existing one
    // rather than silently orphaning the link the author already published.
    const existing = (await automationStore.getFormPagesForAutomation(a.id))
        .find(p => (p.triggerStepId || null) === resolved.id);
    const page = existing || await automationStore.createFormPage(a.id, resolved.id);
    return res.json({ form: { ...page, url: formUrlForToken(page.id, req) }, url: formUrlForToken(page.id, req) });
});

router.get('/:id/forms', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'view')) return;
    const list = await automationStore.getFormPagesForAutomation(a.id);
    return res.json({ forms: list.map(p => ({ ...p, url: formUrlForToken(p.id, req) })) });
});

router.post('/:id/form/:token/rotate', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    const rotated = await automationStore.rotateFormPage(req.params.token, a.id);
    if (!rotated) return res.status(404).json({ error: 'Form not found' });
    return res.json({ form: { ...rotated, url: formUrlForToken(rotated.id, req) }, url: formUrlForToken(rotated.id, req) });
});

router.delete('/:id/form/:token', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    const ok = await automationStore.deleteFormPage(req.params.token, a.id);
    if (!ok) return res.status(404).json({ error: 'Form not found' });
    return res.json({ success: true });
});

router.get('/runs/:id', async (req, res) => {
    const run = await automationStore.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (!await runAccess(req, res, run, 'read')) return;
    // Opened from the history, this row stands for the whole journey — so
    // it reports the outcome of the leg that ran LAST, not the 'success'
    // this leg recorded when it handed off to the one that continued it.
    const leg = await automationStore.getLatestRunInChain(run.id).catch(() => null);
    if (leg && leg.id !== run.id) {
        Object.assign(run, {
            journeyRunId: leg.id,
            status: leg.status,
            finishedAt: leg.finishedAt,
            summary: leg.summary,
            error: leg.error,
            errorClass: leg.errorClass,
            handledErrorCount: leg.handledErrorCount,
            awaitingStepId: leg.awaitingStepId,
            // Carried for the same reason as awaitingStepId: now that an
            // author can SET a deadline, a journey that paused, continued
            // and paused again would otherwise show the countdown chip
            // empty — a run with a live deadline claiming it has none.
            awaitingStepExpiresAt: leg.awaitingStepExpiresAt,
            // Handoff 5: the sentence is the last leg's too.
            outcome: leg.outcome ?? null,
            durationMs: (leg.finishedAt && run.startedAt)
                ? Math.max(0, new Date(leg.finishedAt).getTime() - new Date(run.startedAt).getTime())
                : null,
        });
    }
    // Handoff 5: the approval a waiting run waits on, for "send reminder".
    if (run.status === 'awaiting_approval' && typeof automationStore.getPendingApprovalIdsForRuns === 'function') {
        const pending = await automationStore.getPendingApprovalIdsForRuns([run.journeyRunId || run.id]).catch(() => null);
        run.approvalId = pending?.get(run.journeyRunId || run.id) || null;
    }
    res.json({ run });
});

router.get('/runs/:id/steps', async (req, res) => {
    const run = await automationStore.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (!await runAccess(req, res, run, 'read')) return;
    // The WHOLE journey, not just this leg. An automation that paused on a form
    // continues in a child run, and each leg only records the steps it
    // dispatched live — so reading one leg shows a timeline full of holes
    // where the earlier pages ran. The history lists a journey as one row;
    // opening it has to show one run's worth of steps.
    const steps = await automationStore.getRunStepsForChain(run.id);
    // Return the flow snapshot AS IT WAS at run time so run history renders
    // the steps that actually existed then, not the current definition.
    // Falls back to the current definition for legacy runs whose version
    // predates version snapshotting.
    let definition = await automationStore.getVersionDefinition(run.automationId, run.version);
    if (!definition) {
        const a = await automationStore.getAutomation(run.automationId);
        definition = a?.definition || null;
    }
    res.json({ steps, definition, version: run.version });
});

/**
 * The full output of one step whose run-history row holds only the truncation
 * sentinel (BFSF-402). The row keeps 256 KB at most; above that the store
 * keeps a full copy beside it and the sentinel says so in `fullOutputRef`,
 * which is where the Output panel gets these three coordinates. `:id` is the
 * LEG that recorded the row (the ref's runId), not necessarily the journey's
 * root. Same owner check as the steps above; the copy is the already-redacted
 * value, exactly what the row would have held without the cap.
 */
router.get('/runs/:id/steps/:stepId/full-output', validate({ query: FullOutputQuery }), async (req, res) => {
    const run = await automationStore.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (!await runAccess(req, res, run, 'read')) return;
    const output = await automationStore.getRunFullOutput(run.id, req.params.stepId, req.query.attempts);
    if (output == null) return res.status(404).json({ error: 'No full copy of this output was kept' });
    res.json({ output });
});

/**
 * "Run again with this input". Re-fires `executeAutomation` with the original
 * triggerKind, payload and entry trigger, and links the new run to the old via
 * `parent_run_id` so the history shows the lineage. Manual user action;
 * synchronous wait capped at 60s to mirror /run.
 *
 * Handoff 5: any FINISHED run may be run again (success, error, cancelled),
 * not only a failed one. A journey that is still running or waiting on a
 * person is refused with 409 run_not_finished: its input is still in use.
 * Both answers carry `runId`, the new run's id (the 202 too, once the run row
 * exists).
 */
const RETRYABLE_STATUSES = new Set(['success', 'error', 'cancelled']);
router.post('/:id/runs/:runId/retry', runTriggerLimiter, async (req, res) => {
    const userId = req.session.user.id;
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await automationAccess.guard(req, res, a, 'run');
    if (!access) return;
    const original = await automationStore.getRun(req.params.runId);
    if (!original) return res.status(404).json({ error: 'Run not found' });
    if (original.automationId !== a.id) return res.status(400).json({ error: 'Run does not belong to this automation' });
    // Only a run this caller may read may be run again: a run-only caller
    // retries the runs they started, nobody else's input.
    if (original.userId !== userId && !mayReadRun(original, access, userId)) {
        return res.status(403).json({ error: 'Forbidden', code: 'automation_forbidden', need: 'view' });
    }
    // Running a TEST run again tests the working copy: that needs `edit`.
    if (isTestRun(original) && !roleSatisfies(access.role, 'edit')) {
        return res.status(403).json({ error: 'Forbidden', code: 'automation_forbidden', need: 'edit' });
    }
    // The journey's status, not the head's: a form journey's head reads
    // 'success' the moment it hands off to the leg still waiting.
    const leg = await automationStore.getLatestRunInChain(original.id).catch(() => null);
    const journeyStatus = (leg && leg.status) || original.status;
    if (!RETRYABLE_STATUSES.has(journeyStatus)) {
        throw new HttpError(409, 'run_not_finished', 'This run has not finished yet, so it cannot be run again.', { status: journeyStatus || null });
    }

    const runner = require('../../core/automationRunner');
    const RESPONSE_TIMEOUT_MS = 60_000;
    let timedOut = false;
    let guardTimer;
    let newRunId = null;
    const guard = new Promise((resolve) => { guardTimer = setTimeout(() => { timedOut = true; resolve(null); }, RESPONSE_TIMEOUT_MS); });
    try {
        const runPromise = runner.executeAutomation(a, {
            triggerKind: original.triggerKind || 'manual',
            triggerPayload: original.triggerPayload || null,
            // A preview run again is a preview again.
            mode: original.mode === 'dry_run' ? 'dry_run' : 'live',
            parentRunId: original.id,
            // The same entry point: a run that came in through a second
            // trigger enters there again (null = the primary).
            rootStepId: original.rootStepId || null,
            // Handoff 5: a retry of a TEST run tests the working copy again; a
            // retry of a live run runs what is live now.
            isTest: !!original.isTest,
            startedByUserId: userId,
            onRunCreated: (created) => { newRunId = created?.id || null; },
        }).catch(e => { log.error('[automation/retry] error:', e.message); return null; });

        const run = await Promise.race([runPromise, guard]);
        if (timedOut || !run) {
            return res.status(202).json({
                accepted: true,
                pending: true,
                runId: newRunId,
                message: 'Retry is still in progress. Check the run history shortly.',
            });
        }
        const steps = await automationStore.getRunSteps(run.id).catch(() => []);
        return res.status(200).json({ accepted: true, runId: run.id, run, steps });
    } finally {
        clearTimeout(guardTimer);
    }
});

/**
 * Approve / reject the step an awaiting_approval run is paused on.
 *
 * Body: { decision: 'approve' | 'reject', reason?: string }
 * Returns the new run row produced by resumeFromStep — note this is a
 * CHILD run, linked to the original via parent_run_id; the original row
 * stays in `awaiting_approval` so the lineage is intact.
 *
 * The user must own the automation (org-level approve-anyone-else's-run
 * is intentionally NOT supported here — that requires per-step ACLs).
 */
/**
 * The run an action addressed at `runId` should actually operate on: the newest
 * leg of its journey. For a run that was never paused this is the run itself.
 * Falls back to the addressed row if the chain lookup fails, so an action never
 * breaks on a bookkeeping problem.
 */
async function resolveActionableRun(runId) {
    const addressed = await automationStore.getRun(runId);
    if (!addressed) return null;
    const leg = await automationStore.getLatestRunInChain(runId).catch(() => null);
    return (leg && leg.userId === addressed.userId) ? leg : addressed;
}

router.post('/runs/:runId/approve-step', validate({ body: ApproveStepBody }), async (req, res) => {
    const userId = req.session.user.id;
    // Address the JOURNEY, not the row. The history collapses a run and
    // everything that continued it into one line, so the id arriving here
    // is often the head — which finished the moment it handed off, and
    // would 409 as 'success, not awaiting_approval' while the leg that is
    // genuinely waiting sits one link further down.
    const original = await resolveActionableRun(req.params.runId);
    if (!original) return res.status(404).json({ error: 'Run not found' });
    // Owner-only here BY DESIGN: runs are owner-scoped surfaces (GET
    // /runs/:id 403s everyone else), so this route can only ever be
    // reached by the owner. Assignees, group members and org admins
    // decide through POST /api/automation/approvals/:id/decide, whose
    // auth matrix lives in approvalService.canDecide.
    if (!await runAccess(req, res, original, 'edit')) return;
    if (original.status !== 'awaiting_approval') {
        return res.status(409).json({ error: `Run is in ${original.status} state, not awaiting_approval` });
    }
    if (!original.awaitingStepId) {
        return res.status(409).json({ error: 'Run has no recorded awaiting step' });
    }

    const { decision, reason, answers } = req.body;
    const approvalService = require('../../automation/approvalService');
    const automation = await automationStore.getAutomation(original.automationId).catch(() => null);
    // Runs paused before the approvals table existed have no row yet —
    // ensure one so the decision lands in the audit trail like any other.
    const approval = await approvalService.ensureApprovalForRun(original, automation);
    if (!approval) return res.status(409).json({ error: 'Run has no recorded awaiting step' });

    const { code, body } = await approvalService.decide({
        approval,
        run: original,
        deciderId: userId,
        decision,
        reason,
        answers,
        source: 'builder',
    });
    return res.status(code).json(body);
});

// ── Testing a form journey from the builder ───────────────────────────────
//
// A form-triggered automation is the one kind you cannot test by pressing Run:
// the trigger IS a page somebody fills in. Its public page is no help while you
// are building — formPublic 404s a draft or deactivated automation on purpose — so
// the builder shows the form itself, in an overlay, and runs the automation with
// what you typed.
//
// These two endpoints are the rest of that journey. An automation can pause again
// at a `form_page` step, and until now a run started from the builder simply
// stopped there with nothing on screen to continue it: the only surface that
// could answer page two was the public page the author cannot reach yet.
//
// Owner-only, like every other run operation here. They are NOT a second public
// form surface: there is no token, no session, no CSRF and no anonymous path —
// the caller is a signed-in owner acting on their own run.

/** The rendered page a run is paused on, read off the awaiting step's row. */
async function pendingFormPage(run) {
    if (!run || run.status !== 'awaiting_form' || !run.awaitingStepId) return null;
    const steps = await automationStore.getRunSteps(run.id).catch(() => []);
    const row = steps.find(st => st.stepId === run.awaitingStepId && st.status === 'awaiting_form');
    // The runner records the page AS RENDERED — labels interpolated against the
    // run that produced them. Reading it back is what makes the builder's
    // overlay show the same words the visitor would see, without this route
    // having to re-run an interpolator over a half-finished run.
    const form = row?.output?.form;
    return form ? { stepId: run.awaitingStepId, form } : null;
}

/**
 * Close out the run that was just continued.
 *
 * resumeFromStep starts a CHILD run and leaves the parent in 'awaiting_form'
 * forever; the reaper would later flip a page the author actually ANSWERED to a
 * "FormExpired" error. Same shape as formPublic's finaliseResumedParent, minus
 * the session — a builder test has no journey row to re-point.
 */
async function finaliseContinuedRun(parentRunId, child) {
    await automationStore.updateRun(parentRunId, {
        status: 'success',
        summary: `Continued from the form — see run ${child.id}`,
        finishedAt: new Date().toISOString(),
    }).catch(() => {});
}

/**
 * Is this run's automation paused on a form page, and if so, which one?
 *
 * The builder's overlay polls this while a test run is in flight. It addresses
 * the JOURNEY (resolveActionableRun), because a run that already handed off to
 * a child finished the moment it did so, and the leg that is genuinely waiting
 * is one link further down.
 */
router.get('/runs/:runId/form', async (req, res) => {
    const run = await resolveActionableRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (!await runAccess(req, res, run, 'read')) return;
    const pending = await pendingFormPage(run);
    return res.json({
        runId: run.id,
        status: run.status,
        ...(pending ? { waiting: true, stepId: pending.stepId, form: pending.form } : { waiting: false }),
    });
});

/**
 * Answer the form page a run is paused on, and continue it.
 *
 * Body: { stepId, values }. `stepId` is checked against the run rather than
 * trusted: it says WHICH page the answers are for, and a stale overlay posting
 * page two's answers at page three would otherwise coerce them against the
 * wrong declaration.
 *
 * Returns the CHILD run, linked to the parent — the same lineage the approval
 * resume produces.
 */
router.post('/runs/:runId/form', runTriggerLimiter, validate({ body: RunFormBody }), async (req, res) => {
    const userId = req.session.user.id;
    const run = await resolveActionableRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (!await runAccess(req, res, run, 'act')) return;
    if (run.status !== 'awaiting_form') {
        return res.status(409).json({ error: `Run is in ${run.status} state, not awaiting_form` });
    }
    const pending = await pendingFormPage(run);
    if (!pending) return res.status(409).json({ error: 'Run has no form page to answer' });
    const wanted = req.body.stepId || '';
    if (wanted && wanted !== pending.stepId) {
        return res.status(409).json({ error: 'That page has already been answered — reload the run.' });
    }

    const { normalizeFields, coerceSubmission } = require('../../automation/formTriggerContract');
    const fields = normalizeFields(pending.form);
    const { values, picks, errors } = coerceSubmission(fields, req.body.values);
    if (errors.length) return res.status(400).json({ error: 'Some answers need attention', fields: errors });

    // Records picked from an app, read as the person testing — the same
    // rule the public page follows, and the reason this cannot be a
    // fire-and-forget resume with the raw body.
    if (picks.length) {
        const { describePick } = require('../../automation/formPickRecord');
        const caller = await formPickCaller(req);
        for (const { field, index, multiple, withText, pick } of picks) {
            const described = await describePick(pick, { withText, caller });
            if (multiple) { if (Array.isArray(values[field])) values[field][index] = described; }
            else values[field] = described;
        }
    }

    const runner = require('../../core/automationRunner');
    const child = await runner.resumeFromStep(run.id, pending.stepId, { decision: { ...values }, userId });
    if (child?.id) await finaliseContinuedRun(run.id, child);
    const steps = child?.id ? await automationStore.getRunSteps(child.id).catch(() => []) : [];
    return res.json({ accepted: true, run: child, steps });
});

/**
 * The picker behind an `app_pick` question, while the automation is being BUILT.
 *
 * The public page's picker (formPublic's /form/:token/pick) is unreachable
 * here: it needs a token, and 404s a draft automation on purpose. So the builder
 * gets its own, and the two differ in exactly one way — this one takes the
 * SOURCE directly instead of resolving it from a declared field.
 *
 * That is deliberate, not a shortcut. On the public page the caller is a
 * visitor, so which app may be searched has to come from the author's
 * declaration and never from the request. Here the caller IS the author, acting
 * on their own account, searching a closed list of read-only sources they could
 * already reach from chat. Insisting on a declared field would only mean the
 * picker stopped working for the question they are in the middle of adding —
 * the form is not saved yet.
 */
router.post('/:id/form-pick', runTriggerLimiter, validate({ body: FormPickBody }), async (req, res) => {
    try {
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        // Searches as the CALLER (their own connected account), so starting it
        // is enough: the picker is part of testing the form.
        if (!await automationAccess.guard(req, res, a, 'run')) return;

        const { searchRecords } = require('../../automation/formPickRecord');
        const caller = await formPickCaller(req);
        if (!caller) return res.status(403).json({ error: 'Forbidden' });
        const out = await searchRecords(req.body.source, req.body.query, caller, { limit: req.body.limit });
        // A refusal is a 200 with a reason — "Fireflies is not connected for
        // your account" is something the picker prints beside its search box.
        return res.json({ results: out.results || [], ...(out.error ? { error: out.error } : {}) });
    } catch (e) {
        log.error('[automation/form-pick] error:', e.message);
        res.status(500).json({ error: 'That app could not be searched' });
    }
});

/** Who the picker searches as: the signed-in owner testing their own automation. */
async function formPickCaller(req) {
    const user = req.session?.user;
    if (!user?.id) return null;
    let access = { orgIds: [], userGroupIds: [], isSuperAdmin: false };
    try { access = await require('../transcriptions/shared').resolveAccessContext(req); } catch (_) { /* narrower, never wider */ }
    return {
        userId: user.id,
        session: req.session,
        isAdmin: !!req.session?.isAdmin,
        orgId: user.organizationId || null,
        orgIds: access.orgIds,
        userGroupIds: access.userGroupIds,
        isSuperAdmin: access.isSuperAdmin,
    };
}

/**
 * Request cancellation of an in-flight run. Honoured at the next "between
 * steps" check on whichever runner pod is executing the run, so cancel
 * latency is bounded by step duration. Acknowledges immediately; the UI
 * polls run status to confirm the cancellation took effect.
 */
router.post('/runs/:runId/cancel', validate({ body: CancelRunBody }), async (req, res) => {
    const userId = req.session.user.id;
    // Same as approve-step: stop the leg that is actually running, not the
    // journey head that finished when it handed off.
    const original = await resolveActionableRun(req.params.runId);
    if (!original) return res.status(404).json({ error: 'Not found' });
    if (!await runAccess(req, res, original, 'act')) return;
    if (!['queued', 'running', 'awaiting_approval'].includes(original.status)) {
        return res.status(409).json({ error: `Run is in ${original.status} state and cannot be cancelled` });
    }
    // A run paused on an approval has no executing pod to honour a cancel
    // flag — withdrawing IS the cancel: it closes the pending approval row
    // (so the inbox agrees), notifies whoever was asked, and flips the run.
    if (original.status === 'awaiting_approval') {
        const approvalService = require('../../automation/approvalService');
        const a = await automationStore.getAutomation(original.automationId).catch(() => null);
        const approval = await approvalService.ensureApprovalForRun(original, a);
        if (!approval) return res.status(409).json({ error: 'Run is not awaiting approval.' });
        const { code, body } = await approvalService.withdraw({
            approval, deciderId: userId, reason: req.body.reason, source: 'builder',
        });
        if (code !== 200) return res.status(code).json(body);
        const fresh = await automationStore.getRun(original.id).catch(() => null);
        return res.status(202).json({ accepted: true, run: fresh || original });
    }
    const runner = require('../../core/automationRunner');
    const updated = await runner.requestCancel(original.id);
    return res.status(202).json({ accepted: true, run: updated || original });
});

/**
 * Decide the RUN-level first-run confirmation (`awaiting_confirm`).
 *
 * Body: { decision?: 'approve' | 'reject', reason?: string }
 *
 *  - approve — promote the automation to live: clear `needsFirstRunConfirm` on
 *    the automation and execute it once, as this route has always done.
 *  - reject  — a decision about THIS run only. Nothing is executed, and the
 *    gate STAYS on the automation: a refusal is not a reconfiguration of the
 *    automation, and a gate that disappears when you say "no" is not a gate.
 *    The waiting row is closed as `cancelled` + `summary` + `finishedAt` —
 *    the same shape approvalService.withdraw() gives a paused run that a
 *    human closed without letting it continue. Deliberately NOT `error` /
 *    `ApprovalRejected`: that status is for a journey that broke mid-flight,
 *    and it would light up the failure notification, the error facet and the
 *    "Run it again" button. Here the dry run finished fine; it just is not
 *    being promoted. Note this is today the ONLY way to close such a row —
 *    POST /runs/:runId/cancel refuses `awaiting_confirm` on purpose.
 *
 * WHY A MISSING DECISION DEFAULTS TO 'approve'. Not because silence means
 * consent, but because of the factual caller list for this path: agent-hub's
 * `useAutomationApi.approveRun(runId)` sends NO body, and its two callers are
 * ExecutionsTable's ⋯ "Approve" (means approve) and ExecutionView's bar (the
 * bug repaired alongside this, in the same build). Nothing else in the repo,
 * mobile included, calls it. Defaulting to 'reject' — or 400-ing an empty
 * body — would break Approve in every browser tab that is already open,
 * trading a UI bug for an API break; that is exactly the trade approvalService
 * refuses for the sister route (see its `source !== 'builder'` note). The
 * default is never WIDER than an explicit approval — it IS one. An
 * unreadable or unknown decision is a 400, never a silent approve.
 */
router.post('/runs/:id/approve', validate({ body: ApproveRunBody }), async (req, res) => {
    const userId = req.session.user.id;
    const run = await automationStore.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (!await runAccess(req, res, run, 'edit')) return;
    if (run.status !== 'awaiting_confirm') return res.status(400).json({ error: 'Run is not awaiting confirmation' });
    const a = await automationStore.getAutomation(run.automationId);
    if (!a) return res.status(404).json({ error: 'Automation not found' });

    // Same two lines as the step gate (approve-step → approvalService), so
    // both gates speak one vocabulary.
    const { decision } = req.body;

    if (decision === 'reject') {
        // Reason is OPTIONAL here for the same reason it is optional on
        // approve-step's builder source: the shipped ExecutionBar has no
        // reason field, so requiring one would 400 the very button this
        // change repairs. It is carried into the summary when given, so
        // "why did this never go live?" stays answerable.
        const reason = req.body.reason || '';
        // The gate stays: `needsFirstRunConfirm` is deliberately NOT
        // touched on this branch, and the automation is not updated at all.
        await automationStore.updateRun(run.id, {
            status: 'cancelled',
            summary: reason
                ? `First-run confirmation declined: ${reason}`
                : 'First-run confirmation declined — the automation was not run live.',
            finishedAt: new Date().toISOString(),
        });
        const fresh = await automationStore.getRun(run.id).catch(() => null);
        return res.json({ accepted: true, decision: 'reject', run: fresh || run });
    }

    // Approve — unchanged behaviour. This clearing of the gate must stay
    // BELOW the reject branch: above it, refusing would still strip the
    // gate permanently, which was half the original defect.
    await automationStore.updateAutomation(a.id, { needsFirstRunConfirm: false }, userId);
    // Re-execute live (the original run remains in history as awaiting_confirm).
    const runner = require('../../core/automationRunner');
    setImmediate(async () => {
        // Chosen BEFORE the spread (handoff 5): the spread drops the row's
        // non-enumerable live copy, and a live run of an automation that has one
        // must execute it, not the working copy.
        try {
            const live = require('../../core/automationRunner/definitionForRun').automationForRun(a, { mode: 'live', triggerKind: 'manual' });
            await runner.executeAutomation({ ...live, needsFirstRunConfirm: false }, { triggerKind: 'manual', mode: 'live', confirmFirstRun: true, startedByUserId: userId });
        }
        catch (e) { log.error('[automation/runs/approve] error:', e.message); }
    });
    res.json({ accepted: true, decision: 'approve' });
});

/**
 * §28 — Direct HTTP start of an agent-callable automation, by a PERSON.
 * Nothing in the product calls it: agents start automations in-process via
 * agentCallableTools.dispatchAgentCallableTool, where bindings and grants live.
 * A session names a person, not an agent, so no binding can be checked here and
 * the strict body refuses a claimed `callerAgentId`. The gate is the `run`
 * right, exactly what POST /:id/run grants; a binding never widens what a
 * person may do. Runs as the owner; the person is recorded in startedByUserId.
 * Body: { args }. Returns the final step output verbatim.
 */
router.post('/:id/agent-invoke', runTriggerLimiter, validate({ body: AgentInvokeBody }), async (req, res) => {
    const userId = req.session.user.id;
    // The LIVE definition decides whether the automation is agent-callable, and
    // is what runs (handoff 5).
    const automation = require('../../core/automationRunner/definitionForRun').automationForRun(
        await automationStore.getAutomation(req.params.id), { mode: 'live' });
    if (!automation) throw new HttpError(404, 'automation_not_found', 'Automation not found.');
    if (!await automationAccess.guard(req, res, automation, 'run')) return;
    const trigger = automation.definition?.trigger;
    if (!trigger || trigger.kind !== 'agent_call') {
        throw new HttpError(409, 'not_agent_callable', 'Automation is not declared as agent-callable. Set trigger.kind = "agent_call".');
    }
    if (!automation.isActive) {
        throw new HttpError(409, 'automation_inactive', 'Automation is paused. Activate it first.');
    }
    const args = req.body.args;
    const runner = require('../../core/automationRunner');
    const result = await runner.executeAutomation(automation, {
        triggerKind: 'agent_call',
        triggerPayload: args,
        mode: 'live',
        startedByUserId: userId,
    });
    res.json({ ok: true, output: result?.lastOutput ?? null });
});

/**
 * §14b — Webhook playground. Signs and posts a user-supplied payload
 * through the real webhook handler path (bypassing the nonce-replay
 * check via a single-use test token) and returns the full
 * request/response for display. Phase 2 lands the full implementation;
 * this is the route surface so the UI can target a stable URL.
 */
router.post('/:id/webhook/:slug/test', async (req, res) => {
    const automation = await automationStore.getAutomation(req.params.id);
    if (!automation) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, automation, 'edit')) return;
    // Phase 2: actually sign the supplied payload, dispatch through
    // the webhook ingestion path, capture the response. Until then
    // we acknowledge the endpoint so the UI can light up.
    res.json({
        accepted: true,
        playground: true,
        note: 'Webhook playground full implementation arrives in Phase 2.',
    });
});

module.exports = router;
