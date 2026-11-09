// @typecheck noImplicitAny
/**
 * Answers coming in: the first submission (POST /form/:token) and a later
 * page's answers on a multi-page form (POST /form/:token/s/:sid). Both claim
 * their uploads and read their picks through the same functions, and both
 * hand the work to the same per-automation queue (automation/formQueue.js).
 */

const automationStore = require('../../../stores/automationStore');
const { verifyCsrf } = require('../../../auth/publicShareToken');
const { normalizeFields, coerceSubmission } = require('../../../automation/formTriggerContract');
// The answers table a form may collect into (never in the visitor's way —
// every call below swallows its own errors).
const formAnswers = () => require('../../../automation/formAnswers').write;
const { describeClaimedUpload } = require('../../../automation/formUploadText');
const formQueue = require('../../../automation/formQueue');
const { acceptSubmission, queueSubmission, profileForFound, submissionErrors } = require('../../../automation/formSubmission.mts');
const { privateHeaders, loadForm, loadSession, pendingPageFor, PUBLIC_FORMS_ENABLED } = require('./access');
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

/**
 * @param {import('express').Request<{ token: string }>} req
 * @param {import('express').Response} res
 */
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

    // Answers that need attention go back BEFORE the nonce is recorded. The
    // page keeps one nonce while it is on screen, so recording it for a
    // refused submission made the corrected one answer "already received"
    // and run nothing.
    const invalid = submissionErrors(found, body);
    if (invalid.length) return res.status(400).json({ error: 'Some answers need attention', fields: invalid });

    // Replay dedup on the shared nonce table (namespaced by token, exactly
    // like the webhook route). A double-click or a refresh-resubmit is the
    // common case here, not an attack.
    const nonce = typeof body.nonce === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.nonce) ? body.nonce : null;
    if (nonce) {
        const fresh = await automationStore.checkAndStoreNonce(`form:${found.token}:${nonce}`);
        if (!fresh) return res.status(200).json({ accepted: true, duplicate: true });
    }

    // Page one's handling (coerce, uploads, picks, the caller notice, the
    // answers row, the headers, the session) is the same for a real visitor,
    // a test link and the builder (automation/formSubmission.mts); a test
    // link's row (found.test) makes it a test run of the working copy.
    const accepted = await acceptSubmission(found, body, {
        userId: req.session?.user?.id || null,
        userAgent: String(req.get('user-agent') || ''),
        readPicks: (picks, values) => resolvePicks(picks, values, req),
        publicForm: PUBLIC_FORMS_ENABLED,
    }, profileForFound(found));
    if (!accepted.ok) return res.status(accepted.status).json(accepted.body);

    // Persisted on the session BEFORE the 202, then queued: the visitor is
    // told "received" only once a restart can no longer lose it. The run
    // itself (and its onRunCreated/onRunFinished wiring) is built by
    // formQueue from the session row and this payload alone.
    await queueSubmission(found, accepted, res);
    return undefined;
}

/**
 * POST /form/:token/s/:sid — page N's answers resume the paused run.
 * @param {import('express').Request<{ token: string, sid: string }>} req
 * @param {import('express').Response} res
 */
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

    // Coerce against the fields as RENDERED — that is literally what the
    // visitor was shown, including the interpolated labels the error
    // messages quote back at them. Answers that need attention go back
    // BEFORE the nonce is recorded: the page keeps one nonce while it is on
    // screen, so a recorded one would turn the corrected answers into
    // "already received" with nothing resumed.
    const pending = await pendingPageFor(loaded.session);
    const coerced = pending ? coerceSubmission(normalizeFields(pending.form), body) : null;
    if (coerced && coerced.errors.length) return res.status(400).json({ error: 'Some answers need attention', fields: coerced.errors });

    // No honeypot / minimum-age here: this visitor already cleared both on
    // page one. Replay dedup still applies, and it is answered BEFORE the "is
    // the run still paused" 404 on purpose: by the time a double-click's
    // second request lands, the first may already have resumed the run, and
    // the visitor should see a benign ack rather than a 404.
    const nonce = typeof body.nonce === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.nonce) ? body.nonce : null;
    if (nonce) {
        const fresh = await automationStore.checkAndStoreNonce(`form:${found.token}:${req.params.sid}:${nonce}`);
        if (!fresh) return res.status(200).json({ accepted: true, duplicate: true });
    }

    if (!pending || !coerced) return res.status(404).json({ error: 'Not found' });
    const { values, files, picks } = coerced;

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
        ? { datatableId: /** @type {string} */ (session.triggerHeaders.answers_datatable_id) || null, rowId: /** @type {string} */ (session.triggerHeaders.answers_row_id) }
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
            // isTest: a test link's journey stays a test when the sweep recovers it.
            work: { kind: 'resume', parentRunId: run.id, stepId, values: { ...values }, submitterId, ...(session.isTest ? { isTest: true } : {}) },
        }, res);
    } catch (e) {
        // Not persisted, so not queued: the answer was never accepted, and
        // the page goes back up for the visitor to send again.
        await automationStore.updateRun(run.id, { awaitingStepId: stepId }).catch((e) => bestEffort('routes/automation/formPublic/submit:answerPage', e));
        throw e;
    }
    return undefined;
}

/**
 * POST /form/:token — registered before the session routes.
 * @param {import('express').Router} router
 */
function registerSubmit(router) {
    router.post('/form/:token', ipLimiter, tokenLimiter, contentLengthGuard, friendly(submitForm, 'submit_failed', 'Could not accept this submission'));
}

/**
 * POST /form/:token/s/:sid — registered LAST, after every session sub-route.
 * @param {import('express').Router} router
 */
function registerResume(router) {
    router.post('/form/:token/s/:sid', ipLimiter, sessionLimiter, contentLengthGuard, friendly(answerPage, 'submit_failed', 'Could not accept this submission'));
}

module.exports = { registerSubmit, registerResume, MIN_FORM_AGE_MS, HONEYPOT_FIELD };
