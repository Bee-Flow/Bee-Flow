// @typecheck strict
/**
 * The builder's form test: page one of a form, answered in the builder's
 * overlay, goes through the SAME path as a real submission
 * (automation/formSubmission.mts acceptSubmission): typed answers, claimed
 * uploads with their text, picked records read as the tester, the caller
 * notice, trigger.headers (submitted_at, form_page_id, test) and a session. So
 * what the builder shows is what a visitor's run would see (critic gap 3).
 *
 *   POST /:id/form-test          { values, triggerStepId?, mode: 'dry' | 'live', respond? }
 *        dry (default): a dry run that pauses for real at approvals and form
 *        pages, writes simulated; live: a test run with real effects. Both run
 *        the working copy, started by the tester (their sandbox approval seat),
 *        never write an answers row and never count as a submission.
 *        202 { runId, sessionId } while it runs (respond 'created' answers at once),
 *        else 200 { run, steps, sessionId }. 400 with `fields` when answers need
 *        attention, 409 not_a_form for a trigger that is no form.
 *   POST /:id/form-test/upload   one file for the form's file question (multipart:
 *        file, field, triggerStepId?) → { fileId, filename, size, mimeType },
 *        scanned and size-capped exactly like a visitor's upload, and claimable
 *        only by a form test of the same form.
 *
 * Both need `edit` on the automation (the working copy is an editor's tool).
 * Built by a factory so a test hands in its own store, access and runner.
 */

'use strict';

const express = require('express');
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { z, worded, typeError } = require('../../core/http/schemaParts');
const { makeAutomationAccess } = require('../../automation/access');
const { makeGuarded } = require('./guardedAutomation');
const { entryDefinitionOf, resolveTriggerStepId } = require('./runEntry');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { uploadGuard } = require('../../middleware/uploadGuard');
const { MAX_UPLOAD_MB, formTriggerFields } = require('../../automation/formTriggerContract');
const { Respond } = require('./runSchemas');
const { envCap } = require('../../automation/mcpRunReadCaps');

const TRIGGER_TEXT = 'triggerStepId is the id of a trigger on this automation.';
const FormTestBody = z.object({
    // The answers to page one, as the overlay collected them: the same shape a
    // visitor's browser posts (a file question carries its fileId).
    values: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'values is an object of answers.' }) }).optional(),
    triggerStepId: worded(TRIGGER_TEXT).trim().min(1, TRIGGER_TEXT).max(200, TRIGGER_TEXT).nullish(),
    mode: z.enum(['dry', 'live'], { error: () => 'mode is "dry" or "live".' }).default('dry'),
    respond: Respond,
}).strict();

/** @typedef {typeof import('../../stores/automationStore')} AutomationStore */
/** @typedef {NonNullable<Awaited<ReturnType<AutomationStore['getAutomation']>>>} StoredAutomation */
/**
 * store: getAutomation, ensureFormPage, getRunSteps; submission: acceptSubmission,
 * startSubmission; upload: the upload guard (multer behind middleware/uploadGuard).
 * @param {{
 *   store?: AutomationStore,
 *   access?: ReturnType<typeof makeAutomationAccess>,
 *   submission?: typeof import('../../automation/formSubmission.mts'),
 *   limiter?: import('express').RequestHandler,
 *   upload?: import('express').RequestHandler,
 * }} [overrides]
 */
function makeFormTestRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const access = overrides.access || makeAutomationAccess(overrides.store
        ? /** @type {NonNullable<Parameters<typeof makeAutomationAccess>[0]>} */ ({ store: /** @type {unknown} */ (overrides.store) })
        : {});
    const submission = () => overrides.submission || require('../../automation/formSubmission.mts');
    // The run routes' throttle (AUTOMATION_RUN_TRIGGER_RPM, default 30 a minute).
    const limiter = overrides.limiter || perUserRateLimit({ windowMs: 60_000, max: envCap('AUTOMATION_RUN_TRIGGER_RPM', 30) || 30 });
    const upload = overrides.upload || uploadGuard({ maxBytes: MAX_UPLOAD_MB * 1024 * 1024 });
    const guarded = makeGuarded({ store, access });

    /**
     * The form as the builder tests it: the WORKING copy's trigger, and the
     * form's own page row (its uploads and its session live there, marked test).
     * @param {StoredAutomation} a
     * @param {string | null | undefined} triggerStepId
     * @param {'dry' | 'live'} mode
     */
    async function builderForm(a, triggerStepId, mode) {
        const entered = resolveTriggerStepId(await entryDefinitionOf(a), triggerStepId);
        if (entered.error) throw new HttpError(400, 'invalid_trigger_step', entered.error);
        if (entered.trigger?.kind !== 'form') throw new HttpError(409, 'not_a_form', 'This trigger is not a form.');
        const { automationForRun } = require('../../core/automationRunner/definitionForRun');
        const automation = automationForRun(a, mode === 'dry' ? { mode: 'dry_run' } : { mode: 'live', isTest: true });
        const page = await store().ensureFormPage(a.id, entered.rootStepId);
        if (!page) throw new HttpError(500, 'form_page_missing', 'The form has no page yet. Save it once and try again.');
        return { token: page.id, page, automation, trigger: entered.trigger, definition: { trigger: entered.trigger }, test: true };
    }

    /**
     * Gate before the multipart parser: a caller without `edit` never has a
     * file parsed. Leaves the automation on res.locals for the handler.
     * @type {import('express').RequestHandler<{ id: string }>}
     */
    const editGate = async (req, res, next) => {
        const a = await guarded(req, res, 'edit');
        if (!a) return;
        res.locals.automation = a;
        next();
    };

    router.post('/:id/form-test', limiter, validate({ body: FormTestBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof FormTestBody>, import('qs').ParsedQs>} */ req, res) => {
        const a = await guarded(req, res, 'edit');
        if (!a) return undefined;
        const mode = req.body.mode;
        const found = await builderForm(a, req.body.triggerStepId, mode);
        const sub = submission();
        const accepted = await sub.acceptSubmission(found, { ...(req.body.values || {}) }, {
            userId: req.session.user?.id || null,
            userAgent: String(req.get('user-agent') || ''),
            readPicks: (/** @type {Parameters<typeof import('./formPublic/picks').resolvePicks>[0]} */ picks, /** @type {Parameters<typeof import('./formPublic/picks').resolvePicks>[1]} */ values) => require('./formPublic/picks').resolvePicks(picks, values, req),
            publicForm: false,
        }, mode === 'dry' ? sub.BUILDER_DRY_SUBMISSION : sub.BUILDER_LIVE_SUBMISSION);
        if (!accepted.ok) return res.status(accepted.status).json(accepted.body);
        const sessionId = accepted.session.id;
        const { startCapped, pendingRunBody } = require('../../core/automationRunner/startCapped.mts');
        const outcome = await startCapped((/** @type {(run: Record<string, unknown>) => void} */ onRunCreated) => sub.startSubmission(found, accepted, onRunCreated), {
            respond: req.body.respond, label: 'automation/form-test',
        });
        if (outcome.kind === 'pending') return res.status(202).json({ ...pendingRunBody(outcome.runId), sessionId });
        const steps = await store().getRunSteps(outcome.run.id);
        return res.json({ accepted: true, run: outcome.run, steps, sessionId });
    });

    router.post('/:id/form-test/upload', limiter, editGate, upload, async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
        const a = res.locals.automation;
        const triggerStepId = typeof req.body?.triggerStepId === 'string' && req.body.triggerStepId ? req.body.triggerStepId : null;
        const found = await builderForm(a, triggerStepId, 'live');
        const { storeUpload } = require('./formPublic/page');
        return storeUpload(req, res, found, formTriggerFields(found.definition));
    });

    return router;
}

module.exports = { makeFormTestRouter, FormTestBody };
