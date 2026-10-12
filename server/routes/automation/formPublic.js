/**
 * The form surface behind `kind: 'form'`.
 *
 * ── Signed-in only, for now ──────────────────────────────────────────────
 * These endpoints were anonymous: the token was the whole credential and the
 * form was open to whoever held the link. That is switched off
 * (PUBLIC_FORMS_ENABLED below). A form is now reachable only from inside the
 * workspace, by a signed-in member of the organisation that owns it, and
 * /f/<token> redirects there rather than serving anything itself.
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
 *      the queue two visitors inside one run window means one lost submission
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
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');

/**
 * Whether a form is servable to anonymous visitors.
 *
 * `false` makes every endpoint below require a signed-in caller who belongs to
 * the organisation that owns the form (see callerMayOpen). Applied as router
 * middleware rather than by moving the mount in routes/automation.js, so the
 * flattened route order — which is the contract automation.routetable.test.js
 * pins — does not change when this is flipped either way.
 */
const PUBLIC_FORMS_ENABLED = false;

if (!PUBLIC_FORMS_ENABLED) router.use(requireAuth);

const automationStore = require('../../stores/automationStore');
const storageStore = require('../../stores/storageStore');
const notebookStore = require('../../stores/notebookStore');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { uploadGuard, scanBuffer } = require('../../middleware/uploadGuard');
const { issueCsrf, verifyCsrf } = require('../../auth/publicShareToken');
const { renderConfig, formTriggerFields, normalizeFields, coerceSubmission, isFileField, MAX_UPLOAD_MB } = require('../../automation/formTriggerContract');
const { audienceAdmits, needsGroups } = require('../../automation/formAudience');
// The answers table a form may collect into (never in the visitor's way —
// every call below swallows its own errors).
const formAnswers = () => require('../../automation/formAnswers').write;
const { collectEnabled } = require('../../automation/formAnswers/derive');
const { describeClaimedUpload } = require('../../automation/formUploadText');
const { searchRecords, describePick } = require('../../automation/formPickRecord');
const { walkAllSteps } = require('../../automation/portability');
const { contentDisposition } = require('../../core/http/contentDisposition');
const { endingFrom, resultOf, markdownToSafeHtml, webpageSlots, aiStepsOf, resultFilename } = require('../../automation/formResult');

const FORM_RPM_PER_IP = parseInt(process.env.AUTOMATION_FORM_RPM_PER_IP, 10) || 60;
const FORM_RPM_PER_TOKEN = parseInt(process.env.AUTOMATION_FORM_RPM_PER_TOKEN, 10) || 120;
const FORM_UPLOAD_RPM = parseInt(process.env.AUTOMATION_FORM_UPLOAD_RPM, 10) || 12;
// A picker's search box fires on every pause in typing, so its bucket sits
// between the upload bucket and the poll bucket. It is per token AND per
// caller: one person searching hard must not lock a colleague out of the form.
const FORM_PICK_RPM = parseInt(process.env.AUTOMATION_FORM_PICK_RPM, 10) || 40;
// A polling browser is chatty by design (sub-second while the automation works),
// so its bucket is far wider than the submit buckets.
const FORM_POLL_RPM = parseInt(process.env.AUTOMATION_FORM_POLL_RPM, 10) || 300;

// A submission body is answers to at most 40 declared fields; 256KB is already
// generous. Files go through the separate upload call, never through here.
const MAX_SUBMISSION_BYTES = 256 * 1024;
// Bots post the instant the DOM exists. A human needs at least a couple of
// seconds. Both this and the honeypot answer 200 — never a 4xx that tells the
// bot which signal caught it.
const MIN_FORM_AGE_MS = 2000;
const HONEYPOT_FIELD = 'website_url';
// Per-form upload quota inside a rolling window. There is no user to bill, so
// the form itself carries the budget.
const UPLOAD_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const UPLOAD_QUOTA_FILES = 40;
const UPLOAD_QUOTA_BYTES = 200 * 1024 * 1024;

const ipLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_RPM_PER_IP, keyFn: (req) => `formip:${req.ip || 'unknown'}` });
const tokenLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_RPM_PER_TOKEN, keyFn: (req) => `formtok:${req.params.token}` });
const uploadLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_UPLOAD_RPM, keyFn: (req) => `formupload:${req.params.token}:${req.ip || 'unknown'}` });
const pickLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_PICK_RPM, keyFn: (req) => `formpick:${req.params.token}:${req.session?.user?.id || req.ip || 'unknown'}` });
const sessionLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_POLL_RPM, keyFn: (req) => `formsess:${req.params.sid}` });
// Turning a result into a Word or PDF file renders a document (a Chromium
// page for the PDF), so it gets a bucket of its own per person rather than
// riding on the 300/min poll budget.
const FORM_EXPORT_RPM = parseInt(process.env.AUTOMATION_FORM_EXPORT_RPM, 10) || 10;
const exportLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_EXPORT_RPM, keyFn: (req) => `formexport:${req.session?.user?.id || req.ip || 'unknown'}` });

// Session-id shape gate, same discipline as the token: cheap reject before any DB work.
const SESSION_RE = /^[a-f0-9]{24,64}$/;

const guard = uploadGuard({ maxBytes: MAX_UPLOAD_MB * 1024 * 1024 });

/** No caching, no indexing — a form URL is a credential. */
function privateHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('X-Robots-Tag', 'noindex, nofollow');
}

/**
 * Resolve `:token` to { page, automation, definition } or answer and return
 * null. A closed/draft automation and an unknown token look the SAME from the
 * outside (404): the token is the credential, so probing must not distinguish
 * "wrong token" from "form paused".
 */
async function loadForm(req, res) {
    const token = String(req.params.token || '');
    // Cheap shape gate before any DB work: the token is 48 hex chars.
    if (!/^[a-f0-9]{24,64}$/.test(token)) { res.status(404).json({ error: 'Not found' }); return null; }
    const page = await automationStore.getFormPage(token);
    if (!page) { res.status(404).json({ error: 'Not found' }); return null; }
    const stored = await automationStore.getAutomation(page.automationId);
    if (!stored || !stored.isActive || stored.isDraft) { res.status(404).json({ error: 'Not found' }); return null; }
    // Visitors get the LIVE form (handoff 5): questions saved in the builder
    // but not yet published are not served, and the run executes the same
    // copy the page was rendered from.
    const automation = require('../../core/automationRunner/definitionForRun').automationForRun(stored, { mode: 'live' });
    const definition = automation.definition || {};
    // The page row survives the author changing the trigger kind; the form
    // simply stops existing at that point.
    const trigger = page.triggerStepId
        ? [definition.trigger, ...(definition.triggers || [])].find(t => t?.id === page.triggerStepId)
        : definition.trigger;
    if (!trigger || trigger.kind !== 'form') { res.status(404).json({ error: 'Not found' }); return null; }
    if (!PUBLIC_FORMS_ENABLED && !(await callerMayOpen(req, page))) {
        // 404, not 403: the same answer an unknown token gets, so probing
        // cannot tell "not yours" from "does not exist".
        res.status(404).json({ error: 'Not found' });
        return null;
    }
    return { token, page, automation, trigger, definition: { trigger } };
}

/**
 * May this signed-in caller open this form?
 *
 * The organisation is the outer boundary — nobody outside the owner's
 * organisation, ever; without an organisation on the owner the form is the
 * owner's alone (lumping every orgless account together would make a shared
 * install leakier than the public link this replaced). Inside it, the page
 * row's AUDIENCE decides (automation-form-audience-2026-09): everyone in the
 * organisation, or only the people and groups the owner shared it with.
 * The rule itself is the store's `audienceAdmits`, so the visitor gate and
 * the `canOpen` flag of GET /api/automation/forms cannot drift apart.
 */
async function callerMayOpen(req, page) {
    const caller = req.session?.user;
    if (!caller) return false;
    const audience = await automationStore.formPageAudience(page.id);
    if (!audience) return false;
    // Without groups first: the owner, an org-wide form and a person listed
    // by id are answered without a second read. Group membership is read
    // fresh only when the answer still depends on it.
    if (audienceAdmits(audience, caller, [])) return true;
    if (!needsGroups(audience, caller)) return false;
    const { resolveUserGroups } = require('../../auth/audience');
    return audienceAdmits(audience, caller, await resolveUserGroups(caller.id));
}

// ── GET /form/:token — what to render ─────────────────

router.get('/form/:token', ipLimiter, tokenLimiter, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadForm(req, res);
        if (!found) return undefined;
        // Does this automation have further pages? A single-page form shows its
        // thank-you the moment the submit is accepted; a multi-page one has to
        // wait for the run, because only the server knows whether it paused for
        // another page or finished with a summary. Telling the client up front
        // keeps the common case free of a poll round-trip.
        //
        // A `form_page` can live inside a flowlet (definition.layers[key].steps),
        // reached from the trigger's top-level steps via `call_layer` — the
        // runtime dispatcher walks into layers and pauses there correctly, so a
        // scan of only the top-level steps missed those and left the visitor
        // stuck on the thank-you card while the run sat paused forever
        // (BFSF-437). walkAllSteps is the canonical "every step, every layer"
        // walker — it also visits triggers, but those carry `type: 'trigger'`
        // (with a `kind` field, e.g. 'form'), never `type: 'form_page'`, so this
        // cannot false-positive on the trigger itself.
        let multiPage = false;
        walkAllSteps(found.automation.definition || {}, (step) => {
            if (step?.type === 'form_page') multiPage = true;
        });
        return res.json({
            form: { ...renderConfig(found.definition), multiPage },
            csrf: issueCsrf(found.token),
            // The client stamps this into the submission so the server can tell
            // "filled in by a person" from "posted the instant the page loaded".
            issuedAt: Date.now(),
        });
    } catch (e) {
        log.error('[automation/form] load error:', e.message);
        return res.status(500).json({ error: 'Could not load this form' });
    }
});

// ── POST /form/:token/upload — one file ───────────────

router.post('/form/:token/upload', ipLimiter, uploadLimiter, guard, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadForm(req, res);
        if (!found) return undefined;
        // A session-scoped upload belongs to the page the run is PAUSED on, so
        // its CSRF is bound to token+session and its declared fields come from
        // that step — not from the trigger, which is a different page entirely.
        const sid = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
        const loaded = sid ? await loadSession(found, sid) : null;
        const pending = (loaded && !loaded.expired) ? await pendingPageFor(loaded.session) : null;
        if (sid && !pending) return res.status(404).json({ error: 'Not found' });

        if (!verifyCsrf(String(req.body?.csrf || ''), pending ? `${found.token}:${sid}` : found.token)) {
            return res.status(403).json({ error: 'This form expired — reload the page and try again.' });
        }
        // Only forms that actually declare a file field accept uploads.
        const declaredFields = pending ? normalizeFields(pending.form) : formTriggerFields(found.definition);
        const fileFields = declaredFields.filter(f => f.type === 'file');
        if (fileFields.length === 0) return res.status(400).json({ error: 'This form does not accept files' });

        const file = req.file; // guard guarantees a validated, in-memory buffer
        if (!file) return res.status(400).json({ error: 'No file uploaded' });
        const declared = fileFields.find(f => f.name === String(req.body?.field || '')) || fileFields[0];
        if (file.size > declared.maxSizeMb * 1024 * 1024) {
            return res.status(413).json({ error: `That file is larger than ${declared.maxSizeMb} MB` });
        }
        if (!storageStore.isAvailable()) return res.status(503).json({ error: 'File storage is not available' });

        // Per-form quota BEFORE any bytes are persisted — an anonymous visitor
        // has no account to charge, so the form carries the budget.
        const usage = await automationStore.formUploadUsage(found.token, UPLOAD_QUOTA_WINDOW_MS);
        if (usage.files >= UPLOAD_QUOTA_FILES || usage.bytes + file.size > UPLOAD_QUOTA_BYTES) {
            return res.status(429).json({ error: 'This form has received too many files recently. Please try again later.' });
        }

        // Stored under the automation OWNER's prefix (acts-as-owner, like App
        // Studio and the public share bridge) — the visitor is anonymous, so
        // there is no other tenant to attribute the bytes to.
        const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const key = storageStore.buildAutomationFileKey(found.automation.userId, found.automation.id, sha);

        await storageStore.uploadFile(key, file.buffer, file.mimetype, file.sanitized ? { sanitized: 'true' } : null);
        const scan = await scanBuffer(file.buffer);
        if (!scan.clean) {
            // Quarantine: delete the bytes and never write the ledger row, so
            // an unscanned blob can never be claimed by a submission.
            try { await storageStore.deleteFile(key); } catch (_) { /* best-effort */ }
            return res.status(422).json({ error: 'That file failed a malware scan' });
        }

        const row = await automationStore.recordFormUpload(found.token, {
            storageKey: key,
            filename: safeFilename(file.originalname),
            mimeType: file.mimetype,
            size: file.size,
        });
        return res.json({ fileId: row.id, filename: row.filename, size: row.size, mimeType: row.mimeType });
    } catch (e) {
        log.error('[automation/form] upload error:', e.message);
        return res.status(500).json({ error: 'Upload failed' });
    }
});

/**
 * Replace every `app_pick` answer with the record it points at, read as the
 * FILLER right now.
 *
 * Runs at both claim sites through this one function, for the same reason
 * describeClaimedUpload does: a record picked on page two must read exactly
 * like one picked on page one.
 *
 * Reads are made in sequence rather than in parallel — a form asking for five
 * transcripts should not open five upstream calls at once while the filler's
 * browser holds the submit request open.
 *
 * Never fails the submission. A record that cannot be read arrives carrying
 * `textError`, and the automation decides what that means.
 */
async function resolvePicks(picks, values, req) {
    if (!picks.length) return;
    const caller = await pickCaller(req);
    for (const { field, index, multiple, withText, pick } of picks) {
        const described = caller
            ? await describePick(pick, { withText, caller })
            // No signed-in filler (only reachable if PUBLIC_FORMS_ENABLED is
            // flipped back on): keep the reference, refuse the read. Falling
            // back to the author's credentials here would hand an anonymous
            // visitor a window on the author's mailbox.
            : { ...pick, textError: 'Records can only be read for a signed-in person.' };
        if (multiple) {
            if (Array.isArray(values[field])) values[field][index] = described;
        } else {
            values[field] = described;
        }
    }
}

// ── POST /form/:token/pick — search one app_pick field's source ───────

/**
 * Who is searching. Everything in here is the SIGNED-IN FILLER — never the
 * automation's owner. An `app_pick` question shows the person in front of the form
 * the records THEY can open; building this context from the automation would
 * turn a form into a window on a colleague's mailbox.
 */
async function pickCaller(req) {
    const user = req.session?.user;
    if (!user?.id) return null;
    // The same org/group read the Meeting-notes library does, so the internal
    // source's ACL is answered with exactly the context it expects.
    const { resolveAccessContext } = require('../transcriptions/shared');
    let access = { orgIds: [], userGroupIds: [], isSuperAdmin: false };
    try { access = await resolveAccessContext(req); } catch (_) { /* narrower, never wider */ }
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
 * The declared `app_pick` field this request is about, resolved from the page
 * the filler is actually on.
 *
 * The browser sends a FIELD NAME, never a source and never a tool. The source
 * comes from the declaration, so the picker cannot be steered at an app the
 * question does not ask for — which is what makes this endpoint a picker rather
 * than "run an integration tool as me".
 */
function declaredPickField(fields, name) {
    return fields.find(f => f.type === 'app_pick' && f.name === String(name || '')) || null;
}

router.post('/form/:token/pick', ipLimiter, pickLimiter, contentLengthGuard, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadForm(req, res);
        if (!found) return undefined;

        // Same page resolution as the upload route: a session-scoped search
        // belongs to the form_page the run is paused on, whose fields (and
        // whose CSRF binding) are not the trigger's.
        const sid = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
        const loaded = sid ? await loadSession(found, sid) : null;
        const pending = (loaded && !loaded.expired) ? await pendingPageFor(loaded.session) : null;
        if (sid && !pending) return res.status(404).json({ error: 'Not found' });
        if (!verifyCsrf(String(req.body?.csrf || ''), pending ? `${found.token}:${sid}` : found.token)) {
            return res.status(403).json({ error: 'This form expired — reload the page and try again.' });
        }

        const fields = pending ? normalizeFields(pending.form) : formTriggerFields(found.definition);
        const field = declaredPickField(fields, req.body?.field);
        if (!field) return res.status(400).json({ error: 'This form has no such question' });

        const caller = await pickCaller(req);
        if (!caller) return res.status(403).json({ error: 'You have to be signed in to pick from an app.' });

        const out = await searchRecords(field.source, req.body?.query, caller, { limit: req.body?.limit });
        // A refusal is a 200 with a reason, not a 4xx: "Fireflies is not
        // connected for your account" is something the picker prints next to
        // the search box, and a status code would make the client guess.
        return res.json({ results: out.results || [], ...(out.error ? { error: out.error } : {}) });
    } catch (e) {
        log.error('[automation/form] pick error:', e.message);
        return res.status(500).json({ error: 'That app could not be searched' });
    }
});

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function safeFilename(name) {
    const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
    // Strip control chars; keep it recognisable to the person who receives it.
    return base.replace(CONTROL_CHARS, '').slice(0, 200) || 'file';
}

// ── POST /form/:token — a submission ──────────────────

// Explicit size gate. index.js installs bodyParser.json({limit:'20mb'})
// globally BEFORE this router, so the body is already parsed by the time we
// run and a route-local limit would be dead code.
function contentLengthGuard(req, res, next) {
    const len = Number(req.get('content-length') || 0);
    if (Number.isFinite(len) && len > MAX_SUBMISSION_BYTES) {
        return res.status(413).json({ error: 'That submission is too large' });
    }
    return next();
}

router.post('/form/:token', ipLimiter, tokenLimiter, contentLengthGuard, async (req, res) => {
    try {
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

        await automationStore.touchFormPage(found.token).catch(() => {});

        // The signed-in submitter — every caller is one while PUBLIC_FORMS is
        // off; null is what an anonymous visitor will read as once it is on.
        const submitterId = req.session?.user?.id || null;

        // The answers TABLE gets its row first, before the run is even queued:
        // the queue is in memory, the table is not. `null` when the form does
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

        enqueue(found.automation.id, session.id, () => runner().executeAutomation(found.automation, {
            triggerKind: 'form',
            triggerPayload: { ...values },
            triggerHeaders,
            rootStepId,
            // Point the session at the run the MOMENT it exists, not when it
            // returns. executeAutomation resolves only once the automation has
            // paused or finished, so waiting for it left session.runId null for
            // the whole first stretch — and the poll has nothing to report
            // progress from without a run to read.
            onRunCreated: async (r) => {
                await automationStore.attachFormSessionRun(session.id, r.id);
                // FRM-08: who submitted, on the run — and the run, on the row.
                if (submitterId) await automationStore.updateRun(r.id, { submittedByUserId: submitterId }).catch(() => {});
                if (answers) await formAnswers().attachRun({ automation: found.automation, datatableId: answers.datatableId, rowId: answers.rowId, run: r });
            },
            // No more pages to answer: the journey is complete (an error is
            // "complete" too — nothing further will be asked).
            onRunFinished: answers
                ? (r, { status }) => ((status === 'success' || status === 'error')
                    ? formAnswers().markCompleted({ automation: found.automation, datatableId: answers.datatableId, rowId: answers.rowId })
                    : null)
                : null,
        }), res, { sessionId: session.id });
        return undefined;
    } catch (e) {
        log.error('[automation/form] submit error:', e.message);
        return res.status(500).json({ error: 'Could not accept this submission' });
    }
});

// ── Multi-page: the visitor's session ─────────────────

/**
 * The page a session's run is currently PAUSED on, or null.
 *
 * Everything is derived at read time from the run row + its step rows: the
 * session carries no status of its own, so there is no second state machine to
 * fall out of sync with the runner.
 */
async function loadSession(found, sid) {
    if (!SESSION_RE.test(String(sid || ''))) return null;
    const session = await automationStore.getFormSession(sid, found.token);
    if (!session) return null;
    // Belt and braces: the session's automation must be the one this token
    // resolves to, even if a page row were ever re-pointed.
    if (session.automationId !== found.automation.id) return null;
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) return { session, expired: true };
    return { session, expired: false };
}

/**
 * The leg of the journey that is CURRENT for this session.
 *
 * The session is pointed at each run as it is created, so normally this is just
 * that run. But a journey can also be continued by something the session never
 * hears about — an owner approving a paused step from the run history spawns a
 * child and finalises the parent to 'success' — and reading the session's own
 * run then would tell the visitor "done" while the automation is still going.
 * Newest leg of the same journey, always.
 */
async function currentRunFor(session) {
    if (!session?.runId) return null;
    return automationStore.getLatestRunInChain(session.runId);
}

/**
 * Every run of this session's journey — the first submission plus every leg
 * that continued it after a pause.
 *
 * This is the access boundary for downloads: a visitor may fetch a document
 * their OWN journey produced, and nothing else. Holding a file id proves
 * nothing on its own.
 */
async function journeyRunIds(session) {
    if (!session?.runId) return [];
    const runs = await automationStore.getRunsInChain(session.runId).catch(() => []);
    return runs.map(r => r.id);
}

/**
 * Turn `download` fields into something the page can actually render.
 *
 * The author binds `fileId` to a `generate_document` step's output; here that
 * id becomes a filename, a type and a size, looked up against the runs of THIS
 * journey. A field whose file is missing or expired is DROPPED rather than
 * rendered as a dead button — the visitor gets a page without a download
 * instead of a page with one that 404s.
 *
 * No URL is added. The page knows its own token and session id and builds the
 * link itself, which keeps this working when the API lives on another origin.
 */
async function resolveDownloadFields(form, session) {
    const fields = Array.isArray(form?.fields) ? form.fields : [];
    // `download` saves the file, `notebook` opens it in Notebooks. Both name a
    // generated file by id and both are resolved the same way — a field whose
    // file is gone or expired is DROPPED, so neither renders as a button that
    // leads nowhere.
    if (!fields.some(isFileField)) return form;

    const runIds = await journeyRunIds(session);
    const resolved = [];
    for (const f of fields) {
        if (!isFileField(f)) { resolved.push(f); continue; }
        if (!f.fileId || runIds.length === 0) continue;
        const file = await automationStore.getGeneratedFileForRuns(f.fileId, runIds).catch(() => null);
        if (!file) continue;
        resolved.push({
            name: f.name,
            type: f.type,
            label: f.label,
            help: f.help,
            required: false,
            fileId: file.id,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size,
        });
    }
    return { ...form, fields: resolved };
}

/** The rendered page the given session's run is waiting on, or null. */
async function pendingPageFor(session, currentRun = null) {
    if (!session?.runId) return null;
    const run = currentRun || await currentRunFor(session);
    if (!run || run.status !== 'awaiting_form' || !run.awaitingStepId) return null;
    const steps = await automationStore.getRunSteps(run.id);
    const row = steps.find(s => s.stepId === run.awaitingStepId && s.status === 'awaiting_form');
    const form = row?.output?.form;
    if (!form) return null;
    return { session, run, stepId: run.awaitingStepId, form };
}

/**
 * Where the automation is RIGHT NOW, as a trail of titles: the flowlet it stepped
 * into, then the node inside it. `["3. Zoekwoord zoeken", "Zoekvolume ophalen"]`.
 *
 * A visitor who has just answered a question sits on a spinner for as long as
 * the next stretch takes — a web search, a model call, a document being
 * written. "Just a moment" for ninety seconds reads as broken; the step's own
 * name reads as progress.
 *
 * Sub-steps are recorded under their caller's id (`cl_x/ai_y`, nested for a
 * flowlet that calls a flowlet), which is exactly the path to walk: each
 * segment but the last is a call_layer whose `layerKey` names the graph the
 * next segment lives in.
 *
 * Alongside the trail goes the running flowlet's own one-line DESCRIPTION when
 * it has one ("Searches Google for a given term and lets AI analyse top-ranking
 * pages…"). A step name says where the automation is; the description says what it
 * is doing, which is the thing a visitor staring at a spinner actually wants.
 *
 * LABELS AND FLOWLET DESCRIPTIONS, and only the ones on the path. The form URL
 * is public and its visitor is anonymous, so nothing else about the automation
 * goes out here — no ids, no step types, no tool names, no counts, no outputs.
 * An author who puts something confidential in a step's NAME, or in a flowlet's
 * description, is publishing it to whoever holds the link. Note that flowlet
 * descriptions can be AI-GENERATED (the builder's "AI flowlet summaries"), so
 * that text is not necessarily something the author wrote and read.
 */
// A description is a one-liner by design; the cap is there because this is a
// public endpoint and nothing upstream forces it to stay one.
const PROGRESS_NOTE_MAX = 400;

function progressTrail(definition, steps) {
    const current = [...steps].reverse().find(s => s && s.status === 'running' && s.stepId);
    if (!current) return null;

    const trail = [];
    let note = null;
    let graph = definition;
    const segments = String(current.stepId).split('/');
    for (let i = 0; i < segments.length; i++) {
        const step = (graph?.steps || []).find(x => x && x.id === segments[i]);
        if (!step) break;
        const last = i === segments.length - 1;
        if (!last) {
            const layer = definition?.layers?.[step.layerKey] || null;
            if (step.label) trail.push(step.label);
            else if (layer?.title) trail.push(layer.title);
            if (!layer) break;
            // Deepest description wins — that flowlet is the one doing the
            // work. A flowlet without one keeps its caller's, which is still
            // a truthful account of what the visitor is waiting for.
            const described = typeof layer.description === 'string' ? layer.description.trim() : '';
            if (described) note = described.slice(0, PROGRESS_NOTE_MAX);
            graph = layer;
            continue;
        }
        // A flowlet's own "Return" node is plumbing, not a stage worth naming.
        if (step.type !== 'layer_output' && step.label) trail.push(step.label);
    }
    return trail.length ? { trail, note } : null;
}

router.get('/form/:token/s/:sid', ipLimiter, sessionLimiter, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadForm(req, res);
        if (!found) return undefined;
        const loaded = await loadSession(found, req.params.sid);
        if (!loaded) return res.status(404).json({ error: 'Not found' });
        if (loaded.expired) return res.json({ state: 'expired' });

        const { session } = loaded;
        await automationStore.touchFormSession(session.id).catch(() => {});

        // Queued behind other submissions, or the run row is not written yet.
        if (!session.runId) return res.json({ state: 'working' });
        const run = await currentRunFor(session);
        if (!run) return res.json({ state: 'working' });

        if (run.status === 'awaiting_form') {
            const pending = await pendingPageFor(session, run);
            // The run says it is paused but the step row has not landed yet —
            // a sub-second window the poll should simply retry through.
            if (!pending) return res.json({ state: 'working' });
            return res.json({
                state: 'form',
                stepId: pending.stepId,
                form: await resolveDownloadFields(pending.form, session),
                csrf: issueCsrf(`${found.token}:${session.id}`),
                issuedAt: Date.now(),
            });
        }
        if (run.status === 'queued' || run.status === 'running' || run.status === 'awaiting_approval') {
            // awaiting_approval is a human the VISITOR cannot help with, so it
            // reads as "still working" rather than exposing the internal gate.
            const at = run.status === 'running'
                ? progressTrail(found.automation.definition || {}, await automationStore.getRunSteps(run.id))
                : null;
            return res.json({
                state: 'working',
                ...(at ? { progress: at.trail } : {}),
                ...(at?.note ? { progressNote: at.note } : {}),
            });
        }
        if (run.status === 'success') {
            const steps = await automationStore.getRunSteps(run.id);
            const ending = endingFrom(steps);
            // The closing page is where a download usually lives — "here is the
            // document the automation just made".
            return res.json({ state: 'done', ending: ending ? await resolveDownloadFields(ending, session) : null });
        }
        // A run that lost the per-automation race did nothing at all, and
        // runQueued is backing off to try it again. Reporting that as a failure
        // would end the visitor's journey over a collision they never caused.
        if (lostToConcurrency(run)) return res.json({ state: 'working' });
        // error / cancelled. Never surface run.error — it is written for the
        // owner's diagnostics and can carry upstream API detail.
        return res.json({ state: 'error' });
    } catch (e) {
        log.error('[automation/form] poll error:', e.message);
        return res.status(500).json({ error: 'Could not check this form' });
    }
});

/**
 * Download a document THIS journey produced.
 *
 * The session is the credential. There is no signed URL and no bearer token:
 * the file must belong to a run of the journey the `:sid` covers, so a visitor
 * can fetch their own output and nothing else, and access lapses when the
 * session does. That is why the step returns a bare `fileId` rather than a URL
 * — a URL that worked without the session would be a second, weaker credential.
 *
 * Every miss is a 404, never a 403: a wrong id, someone else's file, an expired
 * one and a deleted blob are deliberately indistinguishable.
 */
router.get('/form/:token/s/:sid/file/:fileId', ipLimiter, sessionLimiter, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadForm(req, res);
        if (!found) return undefined;
        const loaded = await loadSession(found, req.params.sid);
        if (!loaded || loaded.expired) return res.status(404).json({ error: 'Not found' });

        const runIds = await journeyRunIds(loaded.session);
        if (runIds.length === 0) return res.status(404).json({ error: 'Not found' });
        const file = await automationStore.getGeneratedFileForRuns(req.params.fileId, runIds);
        if (!file) return res.status(404).json({ error: 'Not found' });

        let streamed;
        try {
            streamed = await storageStore.streamFile(file.storageKey);
        } catch (e) {
            // The reaper deletes blobs before rows, so a live row with no bytes
            // is a normal race rather than a server fault.
            log.warn(`[automation/form] generated file ${file.id} has no bytes: ${e.message}`);
            return res.status(404).json({ error: 'Not found' });
        }

        res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
        // nosniff + attachment: this is author-influenced content on a public
        // origin, so it must download rather than render in the page.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', contentDisposition(file.filename));
        if (streamed.contentLength != null) res.setHeader('Content-Length', streamed.contentLength);
        streamed.stream.on('error', (e) => {
            log.error(`[automation/form] download stream failed: ${e.message}`);
            if (!res.headersSent) res.status(500).end();
            else res.destroy();
        });
        return streamed.stream.pipe(res);
    } catch (e) {
        log.error('[automation/form] download error:', e.message);
        return res.status(500).json({ error: 'Could not fetch this file' });
    }
});

/**
 * POST /form/:token/s/:sid/file/:fileId/notebook — put this document's TEXT
 * into a new notebook and say which one, so the page can open it.
 *
 * The closing page's "Open in Notebooks" button. It is the download route's
 * twin: same token → session → journey-runs → generated-file chain, so a file
 * belonging to somebody else's journey is a 404 here exactly as it is there.
 *
 * The document lands as the notebook's own CONTENT, not as an attached source.
 * A source is something you ask questions ABOUT; this is the thing the automation
 * just wrote, and the point of sending it here is to carry on working on it.
 * (It was a source first, and arrived as a file card you could not edit.)
 *
 * Nothing kept the text: automation_generated_files stores only the rendered
 * PDF/Word, so it is parsed back out. Lossy for a PDF by nature — Word keeps
 * its structure through mammoth, a PDF comes back as prose.
 *
 * A new notebook every time, named after the document. Reusing one would mean
 * guessing which of the caller's notebooks was meant and quietly writing into
 * it; a fresh one is the only outcome that cannot surprise them.
 *
 * Only reachable while forms are signed-in only — it needs a real user to own
 * the notebook. That is the same condition the router's requireAuth enforces,
 * asserted here so flipping PUBLIC_FORMS_ENABLED back on cannot silently
 * produce ownerless notebooks.
 */
router.post('/form/:token/s/:sid/file/:fileId/notebook', ipLimiter, sessionLimiter, async (req, res) => {
    try {
        privateHeaders(res);
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const found = await loadForm(req, res);
        if (!found) return undefined;
        const loaded = await loadSession(found, req.params.sid);
        if (!loaded || loaded.expired) return res.status(404).json({ error: 'Not found' });

        const runIds = await journeyRunIds(loaded.session);
        if (runIds.length === 0) return res.status(404).json({ error: 'Not found' });
        const file = await automationStore.getGeneratedFileForRuns(req.params.fileId, runIds);
        if (!file) return res.status(404).json({ error: 'Not found' });

        let buffer;
        try {
            const streamed = await storageStore.streamFile(file.storageKey);
            const chunks = [];
            for await (const chunk of streamed.stream) chunks.push(chunk);
            buffer = Buffer.concat(chunks);
        } catch (e) {
            // Same race the download route documents: the reaper drops blobs
            // before rows, so a live row with no bytes is not a server fault.
            log.warn(`[automation/form] generated file ${file.id} has no bytes: ${e.message}`);
            return res.status(404).json({ error: 'Not found' });
        }

        // `returnHtml` so a Word document keeps its headings and lists; a PDF
        // ignores it and comes back as text, which documentHtml then wraps.
        const { parseDocument } = require('../../core/documents/documentParser');
        let parsed;
        try {
            parsed = await parseDocument(buffer, file.mimeType, file.filename, { returnHtml: true });
        } catch (e) {
            log.warn(`[automation/form] could not read ${file.filename} for Notebooks: ${e.message}`);
            return res.status(422).json({ error: 'This document could not be read into Notebooks.' });
        }

        const notebook = await notebookStore.createNotebook({
            userId,
            name: notebookNameFor(file.filename, found),
            description: '',
            instructions: '',
            organizationId: req.session?.user?.organizationId || null,
        });
        // createNotebook always starts empty, so the content is a second write.
        const html = documentHtml(parsed);
        await notebookStore.updateNotebook(notebook.id, userId, { documentContent: html });
        await recordImportedVersion(notebook.id, userId, html);

        return res.json({ notebookId: notebook.id });
    } catch (e) {
        log.error('[automation/form] open-in-notebooks error:', e.message);
        return res.status(500).json({ error: 'Could not open this in Notebooks' });
    }
});

/**
 * The finished journey's result — the closing page's title and markdown, as
 * the RUN recorded them — or null after answering 404.
 *
 * Shared by every "keep this result" route below (BFSF-419). None of them
 * takes the text from the request: the page could send anything, and these
 * routes write a notebook, a webpage or a rendered document from it. Reading
 * the ending back from the run means a visitor keeps exactly what their own
 * journey produced. Same scoping as the file routes above (token → session),
 * so a wrong, foreign or expired session id is the same 404 as everywhere
 * else in this file, and so is a journey that has not finished, or finished
 * without a closing text.
 */
async function loadResult(req, res) {
    const found = await loadForm(req, res);
    if (!found) return null;
    const loaded = await loadSession(found, req.params.sid);
    const run = loaded && !loaded.expired ? await currentRunFor(loaded.session) : null;
    const result = run?.status === 'success' ? resultOf(endingFrom(await automationStore.getRunSteps(run.id))) : null;
    if (!result) { res.status(404).json({ error: 'Not found' }); return null; }
    const title = (result.title || found.trigger?.form?.title || found.automation?.title || 'Result').slice(0, 120);
    return { found, result: { ...result, title } };
}

/**
 * POST /form/:token/s/:sid/notebook — save the closing page's text into a new
 * notebook and say which one, so the page can open it.
 *
 * The route above needs a fileId because a `generate_document` step left
 * something in storage to fetch and reparse. Most automations never take that
 * step: the "result" is just the ending page's markdown (a blog post, a
 * summary, an analysis). That markdown becomes the notebook's HTML, headings,
 * lists and tables included, so the notebook looks like the page the visitor
 * just read rather than a wall of `##` and `|`.
 *
 * Signed-in only (the router's requireAuth while PUBLIC_FORMS_ENABLED is off,
 * and asserted here so flipping it back on cannot silently produce an
 * ownerless notebook).
 */
router.post('/form/:token/s/:sid/notebook', ipLimiter, sessionLimiter, async (req, res) => {
    try {
        privateHeaders(res);
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const loaded = await loadResult(req, res);
        if (!loaded) return undefined;
        const { result } = loaded;

        const notebook = await notebookStore.createNotebook({
            userId,
            name: result.title,
            description: '',
            instructions: '',
            organizationId: req.session?.user?.organizationId || null,
        });
        // createNotebook always starts empty, so the content is a second write.
        const html = markdownToSafeHtml(result.markdown);
        await notebookStore.updateNotebook(notebook.id, userId, { documentContent: html });
        await recordImportedVersion(notebook.id, userId, html);

        return res.json({ notebookId: notebook.id });
    } catch (e) {
        log.error('[automation/form] save-to-notebook error:', e.message);
        return res.status(500).json({ error: 'Could not save this to Notebooks' });
    }
});

/**
 * GET /form/:token/s/:sid/export/:format — the closing page's text as a Word
 * or PDF file.
 *
 * The same renderer generate_document uses (services/documentRenderer), so a
 * result downloaded here looks like a document an automation produced on purpose,
 * and the PDF falls back to pdfkit when no browser is reachable instead of
 * failing. Nothing is stored: the file is rendered for this response only.
 *
 * AI marking (Art. 50(2)) is requested when the automation has an AI step; the
 * organisation's policy (resolveMarking) decides whether it marks at all.
 */
router.get('/form/:token/s/:sid/export/:format', ipLimiter, sessionLimiter, exportLimiter, async (req, res) => {
    try {
        privateHeaders(res);
        const { renderDocument, FORMATS } = require('../../services/documentRenderer');
        if (!FORMATS.includes(req.params.format)) return res.status(404).json({ error: 'Not found' });

        const loaded = await loadResult(req, res);
        if (!loaded) return undefined;
        const { found, result } = loaded;

        const marking = await exportMarking(req, found);
        const { buffer, contentType, extension, degraded } = await renderDocument({
            content: result.markdown,
            contentFormat: 'markdown',
            title: result.title,
            format: req.params.format,
            marking,
        });
        if (degraded) log.warn('[automation/form] result PDF rendered without a browser — plain fallback layout.');

        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', contentDisposition(resultFilename(result.title, extension)));
        res.setHeader('Content-Length', buffer.length);
        return res.end(buffer);
    } catch (e) {
        log.error('[automation/form] export error:', e.message);
        return res.status(500).json({ error: 'Could not create this file' });
    }
});

/** The marking for an exported result, or null. A failure to resolve never blocks the download. */
async function exportMarking(req, found) {
    const ai = aiStepsOf(found.automation?.definition);
    if (!ai) return null;
    try {
        const { resolveMarking } = require('../../core/automationRunner/documentMarking');
        return await resolveMarking(req.session?.user?.organizationId || null, { automationId: found.automation.id, ...ai });
    } catch (e) {
        log.warn(`[automation/form] could not resolve AI content marking, exporting unmarked: ${e.message}`);
        return null;
    }
}

/**
 * Webpages sit behind their module and the organisation's capability
 * (index.js mounts /api/webpages the same way). Required lazily, so this
 * router does not load the module registry when it is loaded itself.
 */
let webpagesGates = null;
function webpagesGate(req, res, next) {
    webpagesGates ||= [
        require('../../modules').requireModule('webpages'),
        require('../../core/entitlements/entitlements').requireCapability('webpages'),
    ];
    const [moduleGate, capabilityGate] = webpagesGates;
    return moduleGate(req, res, (err) => (err ? next(err) : capabilityGate(req, res, next)));
}

/**
 * POST /form/:token/s/:sid/webpage — turn the closing page's text into a new
 * webpage (index.html + style.css, the vanilla framework) and say which one.
 *
 * A plain, readable article page the visitor can then restyle, extend or
 * publish in the webpage editor. Like the notebook route: a new webpage every
 * time, owned by the caller, never one of theirs written into.
 */
router.post('/form/:token/s/:sid/webpage', ipLimiter, sessionLimiter, webpagesGate, async (req, res) => {
    try {
        privateHeaders(res);
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const loaded = await loadResult(req, res);
        if (!loaded) return undefined;
        const { result } = loaded;

        // Webpage files live in object storage. Checked before the row is
        // made, so a missing store leaves no empty webpage behind.
        if (!storageStore.isAvailable()) return res.status(503).json({ error: 'Webpages cannot be saved right now.' });

        const webpageStore = require('../../stores/webpageStore');
        const webpage = await webpageStore.createWebpage({
            userId,
            name: result.title,
            description: '',
            settings: { framework: 'vanilla', runtime: 'light' },
        });
        // The same bookkeeping the editor's own save does: each slot's sha and
        // size go on the row, or the editor thinks the page is still empty.
        const metadata = {};
        for (const [slot, content] of Object.entries(webpageSlots(result))) {
            const { sha, size } = await webpageStore.writeSlot(userId, webpage.id, slot, content);
            metadata[`${slot}Sha`] = sha;
            metadata[`${slot}Size`] = size;
        }
        await webpageStore.updateWebpageMetadata(webpage.id, userId, metadata);

        return res.json({ webpageId: webpage.id });
    } catch (e) {
        log.error('[automation/form] save-as-webpage error:', e.message);
        return res.status(500).json({ error: 'Could not save this as a webpage' });
    }
});

/**
 * The notebook's first version, 'import': where its history starts. Best-effort
 * — the notebook and its text are already saved.
 */
async function recordImportedVersion(notebookId, userId, html) {
    try {
        await notebookStore.recordVersion(notebookId, {
            html, source: 'import', createdBy: userId, contributors: [{ userId, kind: 'user' }],
        });
    } catch (e) {
        log.warn(`[automation/form] could not record the imported notebook's first version: ${e.message}`);
    }
}

/** Notebook name: the document's, without its extension, falling back to the form's. */
function notebookNameFor(filename, found) {
    const stem = String(filename || '').replace(/\.[^.]+$/, '').trim();
    return (stem || found?.trigger?.form?.title || found?.automation?.title || 'Document').slice(0, 120);
}

/**
 * The notebook editor holds HTML. mammoth already returns some for a Word
 * file; a PDF returns prose, which becomes one paragraph per blank-line-
 * separated block so it does not land as a single wall of text.
 *
 * The escape matters: this text comes out of a document an automation generated,
 * which routinely carries model output, and the editor renders what it is
 * given.
 */
function documentHtml(parsed) {
    const text = typeof parsed === 'string' ? parsed : String(parsed?.html || parsed?.text || '');
    if (/<\/?(p|h[1-6]|ul|ol|table|div|br)\b/i.test(text)) return text;
    const escape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    if (blocks.length === 0) return '';
    return blocks.map(b => `<p>${escape(b).replace(/\n/g, '<br />')}</p>`).join('');
}

router.post('/form/:token/s/:sid', ipLimiter, sessionLimiter, contentLengthGuard, async (req, res) => {
    try {
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
        // enqueue() acks the visitor immediately and resumes in the background,
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
        // yet": keep waiting. Restored below if the resume never happens, so
        // an answer is never stranded on a run nobody can reach.
        const stopServingPage = () => automationStore.updateRun(run.id, { awaitingStepId: null }).catch(() => {});
        const serveAgain = () => automationStore.updateRun(run.id, { awaitingStepId: stepId }).catch(() => {});
        // The session is pointed at the child as soon as it exists (below), so
        // a resume that never completed has to hand the pointer BACK — else the
        // poll reads a dead child and shows a failure for an answer that is
        // about to be retried.
        const pointAtParent = () => automationStore.attachFormSessionRun(session.id, run.id).catch(() => {});
        await stopServingPage();

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
        enqueue(found.automation.id, session.id, async () => {
            await stopServingPage();   // idempotent: runQueued may retry this thunk
            let child;
            try {
                child = await runner().resumeFromStep(run.id, stepId, {
                    decision: { ...values },
                    rootStepId: session.rootStepId,
                    triggerHeaders: session.triggerHeaders,
                    // Same reason as the first submission: the child is where
                    // the work happens, and it must be readable while it
                    // happens. finaliseResumedParent only runs once the child
                    // is DONE, which is far too late to show progress.
                    onRunCreated: async (r) => {
                        await automationStore.attachFormSessionRun(session.id, r.id);
                        if (submitterId) await automationStore.updateRun(r.id, { submittedByUserId: submitterId }).catch(() => {});
                    },
                    onRunFinished: answersRef
                        ? (r, { status }) => ((status === 'success' || status === 'error')
                            ? formAnswers().markCompleted({ automation: found.automation, ...answersRef })
                            : null)
                        : null,
                });
            } catch (e) {
                await pointAtParent();
                await serveAgain();    // the answer never ran — let them retry
                throw e;
            }
            // A lost cross-pod race is not a completed resume — leave the
            // parent paused so runQueued's retry can try again.
            if (child?.id && !lostToConcurrency(child)) {
                await finaliseResumedParent(session, run.id, child);
            } else {
                await pointAtParent();
                await serveAgain();
            }
            return child;
        }, res);
        return undefined;
    } catch (e) {
        log.error('[automation/form] resume error:', e.message);
        return res.status(500).json({ error: 'Could not accept this submission' });
    }
});

// ── per-automation FIFO ───────────────────────────────

/**
 * automationRunner single-flights live runs: a second run started while the
 * first is going is CANCELLED with "Skipped: automation already running". For a
 * webhook that is arguably fine; for a public form it silently drops a real
 * person's submission — and for a RESUME it drops an answer to a form the
 * visitor is already halfway through. So all form work for one automation is
 * serialised here, first submissions and resumes alike.
 *
 * The queue is in-memory and therefore per-instance. Across pods the runner's
 * own lock is what serialises, and a loser comes back `cancelled` with that
 * message — which is what CANCELLED_RE + the retry below exist for.
 */
const QUEUE_DEPTH = 25;
// Cross-pod collision backoff. Three tries covers a normal run's length
// without holding a browser's poll open indefinitely.
const RETRY_DELAYS_MS = [1000, 3000, 9000];
const CANCELLED_RE = /already running/i;
const queues = new Map(); // automationId → { running: bool, items: [] }

/**
 * Queue a unit of form work and ack the visitor immediately — they should never
 * wait on the automation. `sessionId` is re-pointed at whatever run the thunk
 * produces, which is how a resume's CHILD run becomes the session's current run.
 */
function enqueue(automationId, sessionId, thunk, res, extra = {}) {
    let q = queues.get(automationId);
    if (!q) { q = { running: false, items: [] }; queues.set(automationId, q); }
    if (q.items.length >= QUEUE_DEPTH) {
        return res.status(503).json({ error: 'This form is busy right now — please try again in a moment.' });
    }
    q.items.push({ sessionId, thunk });
    res.status(202).json({ accepted: true, ...extra });
    if (!q.running) drainQueue(automationId);
    return undefined;
}

const runner = () => require('../../core/automationRunner');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Another pod held the automation's running marker, so this run did nothing.
 * Our own queue cannot see theirs, hence the back-off retry in runQueued.
 */
function lostToConcurrency(run) {
    return !!run && run.status === 'cancelled' && CANCELLED_RE.test(run.error || '');
}

/**
 * Close out the run the visitor just resumed.
 *
 * resumeFromStep starts a CHILD run and leaves the parent sitting in
 * 'awaiting_form' forever — so reapExpiredFormWaits later flipped a form the
 * visitor had actually COMPLETED to a "FormExpired" error, and the owner's run
 * history recorded a failure for a submission that worked (W5-15). The
 * approve-step endpoint has always finalised its parent this way; this is the
 * same shape for the form pause: the parent's own portion, up to the pause,
 * succeeded, and its summary points at the child that carries the continuation.
 *
 * The session is re-pointed at the child FIRST. It happens again in runQueued
 * (idempotent), but doing it here closes a real window: the poll reads
 * `session.runId`, and a parent flipped to 'success' while the session still
 * pointed at it would answer `state: 'done'` — ending the visitor's journey
 * before the child had a chance to serve the next page.
 */
async function finaliseResumedParent(session, parentRunId, child) {
    if (session?.id) await automationStore.attachFormSessionRun(session.id, child.id).catch(() => {});
    await automationStore.updateRun(parentRunId, {
        status: 'success',
        summary: `Resumed from the form — see child run ${child.id}`,
        finishedAt: new Date().toISOString(),
        awaitingStepId: null,
    }).catch(() => {});
}

async function runQueued({ sessionId, thunk }) {
    for (let attempt = 0; ; attempt++) {
        const run = await thunk();
        const lost = lostToConcurrency(run);
        if (!lost) {
            if (sessionId && run?.id) await automationStore.attachFormSessionRun(sessionId, run.id).catch(() => {});
            return;
        }
        if (attempt >= RETRY_DELAYS_MS.length) {
            log.warn(`[automation/form] gave up after ${attempt} retries — automation stayed busy`);
            // Deliberately NOT attached: `run` here is the run that lost the
            // race and did nothing. The thunk has already pointed the session
            // back at the paused parent and restored its page, so the visitor
            // gets the question again rather than a failure for an answer that
            // was never executed.
            return;
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
    }
}

async function drainQueue(automationId) {
    const q = queues.get(automationId);
    if (!q || q.running) return;
    q.running = true;
    try {
        while (q.items.length) {
            const item = q.items.shift();
            try {
                await runQueued(item);
            } catch (e) {
                log.error('[automation/form] run error:', e.message);
            }
        }
    } finally {
        q.running = false;
        if (!q.items.length) queues.delete(automationId);
        else drainQueue(automationId);
    }
}

module.exports = router;
// Exported for tests.
module.exports._queues = queues;
module.exports._constants = {
    MIN_FORM_AGE_MS, HONEYPOT_FIELD, MAX_SUBMISSION_BYTES, QUEUE_DEPTH,
    UPLOAD_QUOTA_FILES, UPLOAD_QUOTA_BYTES, UPLOAD_QUOTA_WINDOW_MS, RETRY_DELAYS_MS,
};
