// @typecheck
/**
 * Before the first submission: the form's render config, one scanned file
 * upload, and an `app_pick` question's search box. The upload and the search
 * also serve a later page of a multi-page form, scoped to the session it is
 * paused on.
 */

const crypto = require('crypto');
const log = require('../../../telemetry/log');
const automationStore = require('../../../stores/automationStore');
const storageStore = require('../../../stores/storageStore');
const { uploadGuard, scanBuffer } = require('../../../middleware/uploadGuard');
const { issueCsrf, verifyCsrf } = require('../../../auth/publicShareToken');
const { renderConfig, formTriggerFields, normalizeFields, MAX_UPLOAD_MB } = require('../../../automation/formTriggerContract');
const { searchRecords } = require('../../../automation/formPickRecord');
const { walkAllSteps } = require('../../../automation/portability');
const { privateHeaders, loadForm, loadSession, pendingPageFor } = require('./access');
const { ipLimiter, tokenLimiter, uploadLimiter, pickLimiter, contentLengthGuard } = require('./limits');
const { pickCaller, declaredPickField } = require('./picks');

// Per-form upload quota inside a rolling window. There is no user to bill, so
// the form itself carries the budget.
const UPLOAD_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const UPLOAD_QUOTA_FILES = 40;
const UPLOAD_QUOTA_BYTES = 200 * 1024 * 1024;

const guard = uploadGuard({ maxBytes: MAX_UPLOAD_MB * 1024 * 1024 });

// ── GET /form/:token — what to render ─────────────────

async function renderForm(req, res) {
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
}

// ── POST /form/:token/upload — one file ───────────────

async function uploadFile(req, res) {
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
}

// ── POST /form/:token/pick — search one app_pick field's source ───────

async function searchPick(req, res) {
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
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function safeFilename(name) {
    const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
    // Strip control chars; keep it recognisable to the person who receives it.
    return base.replace(CONTROL_CHARS, '').slice(0, 200) || 'file';
}

/** GET /form/:token, POST /form/:token/upload, POST /form/:token/pick — in that order. */
function register(router) {
    router.get('/form/:token', ipLimiter, tokenLimiter, renderForm);
    router.post('/form/:token/upload', ipLimiter, uploadLimiter, guard, uploadFile);
    router.post('/form/:token/pick', ipLimiter, pickLimiter, contentLengthGuard, searchPick);
}

module.exports = { register, UPLOAD_QUOTA_WINDOW_MS, UPLOAD_QUOTA_FILES, UPLOAD_QUOTA_BYTES };
