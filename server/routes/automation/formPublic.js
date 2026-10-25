// @typecheck strict
/**
 * The form surface behind `kind: 'form'`.
 *
 * ── Signed-in only, for now ──────────────────────────────────────────────
 * These endpoints were anonymous: the token was the whole credential and the
 * form was open to whoever held the link. That is switched off
 * (PUBLIC_FORMS_ENABLED in formPublic/access.js). A form is now reachable only
 * from inside the workspace, by a signed-in member of the organisation that
 * owns it, and /f/<token> redirects there rather than serving anything itself.
 *
 * Everything the anonymous design needed is still here and still runs — the
 * rate limits, the CSRF, the honeypot, the nonce dedup. None of it was removed,
 * because this is meant to be reversible: flipping the flag back gives the
 * public form its behaviour back exactly.
 *
 * Five endpoints, all keyed on the form's URL token:
 *
 *   GET  /form/:token          → render config (fields + theme) + a CSRF token
 *   POST /form/:token/upload   → one scanned file → { fileId }
 *   POST /form/:token          → a submission → 202 + a session id
 *   GET  /form/:token/s/:sid   → poll: working | form (page N) | done | error
 *   POST /form/:token/s/:sid   → page N's answers → resume the paused run
 *
 * The last two are multi-page forms. The automation can pause at a `form_page`
 * step; the visitor stays on the SAME /f/<token> URL and their browser polls
 * this session until the next page (or the closing summary) is ready. The
 * session id is the credential — 192 bits, minted at the first submission.
 *
 * Mounted alongside events.js, i.e. BEFORE the auth chain in routes/automation.js.
 * They live under /api/... on purpose: nginx's `@render` location has a 5s read
 * timeout and rewrites non-2xx responses to the SPA shell, so a top-level path
 * would turn a 400 into an HTML page.
 *
 * Defences, in the order a request meets them:
 *   1. two rate-limit buckets — per IP and per token
 *   2. an explicit Content-Length guard (bodyParser.json({limit:'20mb'}) runs
 *      GLOBALLY in index.js before this router, so a route-local express.json
 *      limit would never fire)
 *   3. HMAC CSRF bound to the token (auth/publicShareToken)
 *   4. a honeypot field + a minimum form age, both answering a SILENT 200 so a
 *      bot learns nothing from the difference
 *   5. nonce replay-dedup on the shared automation_webhook_seen_nonces table
 *   6. per-field coercion against the DECLARED fields (never the body's keys)
 *   7. a per-automation FIFO queue, because automationRunner cancels a second
 *      concurrent run of the same automation with "already running" — without
 *      the queue two visitors inside one run window means one lost submission.
 *      The queued work is persisted on the session row before the 202 goes
 *      out, so a deploy or a crash does not lose it (automation/formQueue.js)
 *
 * ── WHY THERE IS NO SCHEMA ON THE SUBMISSION BODY ───────────────────────
 * Two reasons, and both are about this surface rather than about effort.
 *
 * The body IS the form's own fields. Its keys are whatever the author
 * declared, so nothing here can be written down ahead of time — and step 6
 * above already does the narrowing that matters: every value is coerced
 * against the DECLARED field list, never against the keys the body happens to
 * carry. A key nobody declared does not reach the run.
 *
 * And a refusal here is a signal. Step 4 answers a honeypot hit with a SILENT
 * 200 precisely so a probe cannot tell a rejected submission from an accepted
 * one; `.strict()` would hand that difference straight back as a 400 naming
 * the field it did not recognise. The upload route is raw scanned bytes, which
 * a schema cannot describe either.
 *
 * ── Layout ──────────────────────────────────────────────────────────────
 * This file is the router and the order its routes are registered in; the
 * handlers live in formPublic/:
 *   access.js   token → form, sid → session, who may open a form
 *   limits.js   the rate-limit buckets and the body-size gate
 *   picks.js    `app_pick`: the filler as caller, picked records → the run
 *   page.js     GET the form, upload a file, search an app_pick source
 *   submit.js   the first submission and a later page's answers
 *   session.js  the session poll and a generated document's download
 *   results.js  keep the result: notebook, Word/PDF export, webpage
 * The per-automation FIFO, its persistence and its recovery live in
 * automation/formQueue.js.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { PUBLIC_FORMS_ENABLED } = require('./formPublic/access');

if (!PUBLIC_FORMS_ENABLED) router.use(requireAuth);

const formQueue = require('../../automation/formQueue');
const { MAX_SUBMISSION_BYTES } = require('./formPublic/limits');
const page = require('./formPublic/page');
const submit = require('./formPublic/submit');
const session = require('./formPublic/session');
const results = require('./formPublic/results');

// Registration order is the route table automation.routetable.test.js pins.
page.register(router);          // GET /form/:token, POST …/upload, POST …/pick
submit.registerSubmit(router);  // POST /form/:token
session.register(router);       // GET …/s/:sid, GET …/s/:sid/file/:fileId
results.register(router);       // …/file/:fileId/notebook, …/notebook, …/export/:format, …/webpage
submit.registerResume(router);  // POST /form/:token/s/:sid

const { MIN_FORM_AGE_MS, HONEYPOT_FIELD } = submit;
const { UPLOAD_QUOTA_FILES, UPLOAD_QUOTA_BYTES, UPLOAD_QUOTA_WINDOW_MS } = page;

/**
 * @typedef {import('express').Router & {
 *   _queues: typeof formQueue._queues,
 *   _constants: { MIN_FORM_AGE_MS: number, HONEYPOT_FIELD: string, MAX_SUBMISSION_BYTES: number, QUEUE_DEPTH: number,
 *     UPLOAD_QUOTA_FILES: number, UPLOAD_QUOTA_BYTES: number, UPLOAD_QUOTA_WINDOW_MS: number, RETRY_DELAYS_MS: number[] },
 * }} FormPublicExports
 */
module.exports = /** @type {FormPublicExports} */ (router);
// Exported for tests.
/** @type {FormPublicExports} */ (module.exports)._queues = formQueue._queues;
/** @type {FormPublicExports} */ (module.exports)._constants = {
    MIN_FORM_AGE_MS, HONEYPOT_FIELD, MAX_SUBMISSION_BYTES, QUEUE_DEPTH: formQueue.QUEUE_DEPTH,
    UPLOAD_QUOTA_FILES, UPLOAD_QUOTA_BYTES, UPLOAD_QUOTA_WINDOW_MS, RETRY_DELAYS_MS: formQueue.RETRY_DELAYS_MS,
};
