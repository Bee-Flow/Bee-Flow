// @typecheck
/**
 * Answers coming in: the first submission (POST /form/:token) and a later
 * page's answers on a multi-page form (POST /form/:token/s/:sid). Both claim
 * their uploads and read their picks through the same functions, and both
 * hand the work to the same per-automation queue (automation/formQueue.js).
 */

const automationStore = require('../../../stores/automationStore');
const { verifyCsrf } = require('../../../auth/publicShareToken');
const { formTriggerFields, normalizeFields, coerceSubmission } = require('../../../automation/formTriggerContract');
// The answers table a form may collect into (never in the visitor's way —
// every call below swallows its own errors).
const formAnswers = () => require('../../../automation/formAnswers').write;
const { collectEnabled } = require('../../../automation/formAnswers/derive');
const { describeClaimedUpload } = require('../../../automation/formUploadText');
const formQueue = require('../../../automation/formQueue');
const { privateHeaders, loadForm, loadSession, pendingPageFor, PUBLIC_FORMS_ENABLED } = require('./access');
const { assertFormStartAllowed } = require('../../../automation/formCallerNotice');
const { ipLimiter, tokenLimiter, sessionLimiter, contentLengthGuard } = require('./limits');
const { resolvePicks } = require('./picks');
const { friendly } = require('./friendly');
const { bestEffort } = require('../../../utils/bestEffort');

// Bots post the instant the DOM exists. A human needs at least a couple of
// seconds. Both this and the honeypot answer 200 — never a 4xx that tells the
// bot which signal caught it.
const MIN_FORM_AGE_MS = 2000;
const HONEYPOT_FIELD = 'website_url';

// ── POST /form/:token — a submission ──────────────────

async function submitForm(req, res) {
    privateHeaders(res);
    const found = await loadForm(req, res);
    if (!found) return undefined;

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    if (!verifyCsrf(String(body.csrf || ''), found.token)) {
        return res.status(403).json({ error: 'This form expired — reload the page and try again.' });
    }

    // Silent accept for the two bot signals. Answering 400 would tell a
    // scraper exactly which field is the trap; a 200 that runs nothing
    // costs it a submission with no feedback.
    const honeypotFilled = typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '';
    const issuedAt = Number(body.issuedAt || 0);
    const tooFast = Number.isFinite(issuedAt) && issuedAt > 0 && (Date.now() - issuedAt) < MIN_FORM_AGE_MS;
    if (honeypotFilled || tooFast) {
        return res.status(200).json({ accepted: true });
    }

    // Replay dedup on the shared nonce table (namespaced by token, exactly
    // like the webhook route). A double-click or a refresh-resubmit is the
    // common case here, not an attack.
    const nonce = typeof body.nonce === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.nonce) ? body.nonce : null;
    if (nonce) {
        const fresh = await automationStore.checkAndStoreNonce(`form:${found.token}:${nonce}`);
        if (!fresh) return res.status(200).json({ accepted: true, duplicate: true });
    }

    const fields = formTriggerFields(found.definition);
    const { values, files, picks, errors } = coerceSubmission(fields, body);
    if (errors.length) return res.status(400).json({ error: 'Some answers need attention', fields: errors });

    // Claim every referenced upload — atomically, so a replayed submission
    // cannot re-attach the same file, and a file uploaded through another
    // form cannot be attached to this one.
    for (const { field, fileId } of files) {
        const claimed = await automationStore.claimFormUpload(fileId, found.token);
        if (!claimed) {
            return res.status(400).json({ error: 'Some answers need attention', fields: [{ field, message: 'That file is no longer available — please attach it again.' }] });
        }
        // The descriptor carries the file's TEXT as well as its receipt, so
        // an ai_step can bind trigger.output.<field>.text and actually read
        // the workbook the visitor attached. Never throws — an unreadable
        // attachment yields `textError` and the run still starts.
        values[field] = await describeClaimedUpload(claimed);
    }

    // Records picked from an app the FILLER can reach — the transcript, the
    // email, the meeting note the question asked for.
    await resolvePicks(picks, values, req);

    await automationStore.touchFormPage(found.token).catch((e) => bestEffort('routes/automation/formPublic/submit:submitForm', e));

    // The signed-in submitter — every caller is one while PUBLIC_FORMS is
    // off; null is what an anonymous visitor will read as once it is on.
    const submitterId = req.session?.user?.id || null;
    // A public form is a system start; only a members-only form has its submitter as the starter.
    await assertFormStartAllowed({ automation: found.automation, submitterId: PUBLIC_FORMS_ENABLED ? null : submitterId, store: automationStore });

    // The answers TABLE gets its row first, before the run is even queued,
    // so the owner sees the submission whatever the run does. `null` when the form does
    // not collect, or when the table refused — the submission still
    // proceeds, the owner sees why on the Form page.
    const answers = collectEnabled(found.definition)
        ? await formAnswers().recordSubmission({ automation: found.automation, definition: found.definition, values, submitterId })
        : null;

    // Metadata rides on trigger.headers, never inside trigger.output — a
    // field called `submitted_at` must not be shadowed by ours. The answers
    // row id rides here too, so every later page of the journey (which
    // resumes with these same headers) finds its row.
    const triggerHeaders = {
        submitted_at: new Date().toISOString(),
        form_page_id: found.token,
        user_agent: String(req.get('user-agent') || '').slice(0, 300),
        ...(answers ? { answers_row_id: answers.rowId, answers_datatable_id: answers.datatableId } : {}),
    };

    // Every submission gets a session, even for a single-page form: it is
    // how the browser learns whether the automation paused for another page,
    // finished with a summary, or failed. Stored BEFORE the run starts so
    // the poll has something to point at while the queue drains.
    const rootStepId = found.page.triggerStepId || null;
    const session = await automationStore.createFormSession(found.token, found.automation.id, {
        rootStepId, triggerHeaders,
    });

    // Persisted on the session BEFORE the 202, then queued: the visitor is
    // told "received" only once a restart can no longer lose it. The run
    // itself (and its onRunCreated/onRunFinished wiring) is built by
    // formQueue from the session row and this payload alone.
    await formQueue.accept({
        automation: found.automation,
        session,
        work: { kind: 'submit', payload: { ...values }, submitterId, publicForm: PUBLIC_FORMS_ENABLED },
    }, res, { sessionId: session.id });
    return undefined;
}

/** POST /form/:token/s/:sid — page N's answers resume the paused run. */
async function answerPage(req, res) {
    privateHeaders(res);
    const found = await loadForm(req, res);
    if (!found) return undefined;
    const loaded = await loadSession(found, req.params.sid);
    if (!loaded || loaded.expired) return res.status(404).json({ error: 'Not found' });

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const submitterId = req.session?.user?.id || null;
    if (!verifyCsrf(String(body.csrf || ''), `${found.token}:${req.params.sid}`)) {
        return res.status(403).json({ error: 'This form expired — reload the page and try again.' });
    }

    // No honeypot / minimum-age here: this visitor already cleared both on
    // page one. Replay dedup still applies, and it runs BEFORE the "is the
    // run still paused" check on purpose: by the time a double-click's
    // second request lands, the first may already have resumed the run, and
    // the visitor should see a benign ack rather than a 404.
    const nonce = typeof body.nonce === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.nonce) ? body.nonce : null;
    if (nonce) {
        const fresh = await automationStore.checkAndStoreNonce(`form:${found.token}:${req.params.sid}:${nonce}`);
        if (!fresh) return res.status(200).json({ accepted: true, duplicate: true });
    }

    const pending = await pendingPageFor(loaded.session);
    if (!pending) return res.status(404).json({ error: 'Not found' });

    // Coerce against the fields as RENDERED — that is literally what the
    // visitor was shown, including the interpolated labels the error
    // messages quote back at them.
    const fields = normalizeFields(pending.form);
    const { values, files, picks, errors } = coerceSubmission(fields, body);
    if (errors.length) return res.status(400).json({ error: 'Some answers need attention', fields: errors });

    for (const { field, fileId } of files) {
        const claimed = await automationStore.claimFormUpload(fileId, found.token);
        if (!claimed) {
            return res.status(400).json({ error: 'Some answers need attention', fields: [{ field, message: 'That file is no longer available — please attach it again.' }] });
        }
        // Same descriptor as page one — through the same function, so a
        // file attached on a later page reads exactly like one attached on
        // the first.
        values[field] = await describeClaimedUpload(claimed);
    }

    // Same read as page one, through the same function.
    await resolvePicks(picks, values, req);

    const { session, run, stepId } = pending;
    // This page has now been ANSWERED — stop handing it back.
    //
    // The queue acks the visitor immediately and resumes in the background,
    // so until the child run lands the session still points at THIS run,
    // still `awaiting_form` on THIS step. The poll would serve the very
    // page just submitted, the visitor would answer it again, and each
    // resubmission started ANOTHER child from the same parent — an automation
    // with two questions re-ran the first one, and its research, every
    // time. On a long step the window was tens of seconds wide, which is
    // exactly when a visitor tries again.
    //
    // Clearing the pointer (not the status) routes the poll onto the
    // branch it already has for "paused, but the step row has not landed
    // yet": keep waiting. The queued resume (formQueue's resumeThunk)
    // restores it if the resume never happens, so an answer is never
    // stranded on a run nobody can reach.
    await formQueue.stopServingPage(run.id);

    // This page's answers land on the SAME row page one made (its id rode
    // in on the session's trigger headers). Best-effort, like page one.
    const answersRef = session.triggerHeaders?.answers_row_id
        ? { datatableId: session.triggerHeaders.answers_datatable_id || null, rowId: session.triggerHeaders.answers_row_id }
        : null;
    if (answersRef) {
        await formAnswers().recordPageAnswers({ automation: found.automation, ...answersRef, pageStepId: stepId, values });
    }

    // Through the SAME queue as a first submission. resumeFromStep starts a
    // fresh executeAutomation, which takes the per-automation running
    // marker — a resume racing another visitor's run would come back
    // "Skipped: automation already running", i.e. a silently lost answer.
    // Persisted before the 202 like a first submission.
    try {
        await formQueue.accept({
            automation: found.automation,
            session,
            work: { kind: 'resume', parentRunId: run.id, stepId, values: { ...values }, submitterId },
        }, res);
    } catch (e) {
        // Not persisted, so not queued: the answer was never accepted, and
        // the page goes back up for the visitor to send again.
        await automationStore.updateRun(run.id, { awaitingStepId: stepId }).catch((e) => bestEffort('routes/automation/formPublic/submit:answerPage', e));
        throw e;
    }
    return undefined;
}

/** POST /form/:token — registered before the session routes. */
function registerSubmit(router) {
    router.post('/form/:token', ipLimiter, tokenLimiter, contentLengthGuard, friendly(submitForm, 'submit_failed', 'Could not accept this submission'));
}

/** POST /form/:token/s/:sid — registered LAST, after every session sub-route. */
function registerResume(router) {
    router.post('/form/:token/s/:sid', ipLimiter, sessionLimiter, contentLengthGuard, friendly(answerPage, 'submit_failed', 'Could not accept this submission'));
}

module.exports = { registerSubmit, registerResume, MIN_FORM_AGE_MS, HONEYPOT_FIELD };
