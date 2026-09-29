/**
 * DSR API — Data Subject Request endpoints (GDPR Art. 12, 15–22).
 *
 *   public (no auth; rate-limited per IP)
 *   POST   /api/dsr/requests                         intake via the public form
 *   GET    /api/dsr/requests/:id/public?email=       minimal status view
 *   POST   /api/dsr/requests/:id/verify {token}      identity link from the ack mail
 *   POST   /api/dsr/requests/verify {token}          the same link with the id lost
 *
 *   admin (requireAuth + admin_compliance)
 *   POST   /api/dsr/requests/manual                  intake of a mail/phone/letter request
 *   GET    /api/dsr/requests                         register — subject_email_masked ONLY
 *   GET    /api/dsr/requests/:id                     full row (access-audited)
 *   POST   /api/dsr/requests/:id/start
 *   POST   /api/dsr/requests/:id/extend {reason}     Art. 12(3), once
 *   POST   /api/dsr/requests/:id/verify-identity {method:'manual', note}
 *   GET    /api/dsr/requests/:id/timeline
 *   GET    /api/dsr/requests/:id/discovery           read-only subject scan
 *   POST   /api/dsr/requests/:id/fulfil {status, result_summary, notify_subject}
 *   GET    /api/dsr/requests/:id/export              dossier (no personal data)
 *
 * Public submission is intentionally not behind the enterprise license gate
 * (mounted with `gate: null` in featureMap). GDPR requires the channel to be
 * reachable; admin endpoints stay enterprise-only.
 *
 * BFSF-441: the subject's address appears in exactly two places — the audited
 * detail (GET /:id) and the letters e-mailed to the subject. Lists, evidence,
 * notifications and the export carry the masked form, built from allow-lists
 * (compliance/dsr/mask.js). The downloadable dossier gets the STRICTER of the
 * two lists there: no address, and no free text at all (lengths instead), so
 * the claim it makes about itself holds.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const log = require('../telemetry/log');
const router = express.Router();

const dsrStore = require('../stores/dsrStore');
const userStore = require('../stores/userStore');
const complianceEvents = require('../compliance/events');
const { requireAuth, requirePermission } = require('../auth/permissions');
const { maskRequest, maskTimeline, maskEmail, dossierRequest, dossierTimeline } = require('../compliance/dsr/mask');
const verifyToken = require('../compliance/dsr/verifyToken');
const signedPayload = require('../auth/lib/signedPayload');
const discovery = require('../compliance/dsr/discovery');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, queryOf, choice } = require('../core/http/schemaParts');
const { onEvidenceWriteFailed } = require('../compliance/evidence/writeFailures');
const appPaths = require('../utils/appPaths');

const complianceStore = (() => { try { return require('../stores/complianceStore'); } catch { return null; } })();
const emailService = (() => { try { return require('../utils/emailService'); } catch { return null; } })();

// Bootstrap the durable verify-token secret once the DB is up (non-fatal).
verifyToken.ensureDurable().catch(() => {});

const publicSubmitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many DSR submissions from this IP. Try again later.' },
});

// Status polling and verify clicks: generous for a person, useless for an
// enumeration probe (60/h/IP).
const publicReadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP. Try again later.' },
});

const DAY_MS = 86400 * 1000;
/** Below this many days left a DSR is "urgent" (matches GET /deadlines). */
const URGENT_BELOW_DAYS = 5;
const OPEN = new Set(['pending', 'in_progress']);
const MAX_REASON = 1000;
const MAX_SUMMARY = 4000;
const MAX_NOTE = 2000;

// ── What a request may send ──────────────────────────────────────────
// Closed bodies and queries. What they close: `notify_subject: "false"` on
// fulfil still e-mailed the subject (only the boolean false counted), and a
// misspelled `requestType` on the public form filed the request as an
// ACCESS request whatever the subject asked for. Type and channel stay text
// here: dsrStore owns those vocabularies and names a wrong value itself.
// The two verify routes take no schema: their gate answers every failure,
// a malformed body included, with the same `invalid_token`, so a probe
// cannot tell which part was wrong.
const dsrText = (message, max) => worded(message).max(max, message);
const EMAIL_TEXT = 'subject_email is required';
const PublicIntakeBody = bodyOf({
    subject_email: dsrText(EMAIL_TEXT, 320),
    request_type: dsrText('request_type is the kind of request, like access or deletion.', 40).optional(),
    notes: dsrText(`notes is text of at most ${MAX_NOTE} characters.`, 20_000).optional(),
}, 'A data subject request');
const ManualIntakeBody = bodyOf({
    subject_email: dsrText(EMAIL_TEXT, 320),
    request_type: dsrText('request_type is the kind of request, like access or deletion.', 40).optional(),
    channel: dsrText('channel is how the request arrived, like letter or phone.', 40).optional(),
    notes: dsrText(`notes is text of at most ${MAX_NOTE} characters.`, 20_000).nullish(),
    received_at: dsrText('received_at is a date, like 2026-09-01T09:00:00Z.', 64).nullish(),
}, 'Recording a request');
const PublicStatusQuery = queryOf({ email: dsrText('email query param required', 320).optional() }, 'The status check');
const ListQuery = queryOf({
    status: choice(['pending', 'in_progress', 'fulfilled', 'rejected'], 'status is pending, in_progress, fulfilled or rejected.').optional(),
}, 'The request register');
const ExtendBody = bodyOf({ reason: dsrText('reason is required', 20_000).optional() }, 'Extending a request');
const VerifyIdentityBody = bodyOf({
    method: dsrText('method must be "manual"', 40).optional(),
    note: dsrText(`note is text of at most ${MAX_NOTE} characters.`, 20_000).optional(),
}, 'Verifying identity');
const DiscoveryQuery = queryOf({ force: choice(['0', '1'], 'force is 1 to run the scan again.').optional() }, 'Discovery');
const FulfilBody = bodyOf({
    status: dsrText('status must be "fulfilled" or "rejected"', 40).optional(),
    result_summary: dsrText(`result_summary must be at most ${MAX_SUMMARY} characters`, 20_000).nullish(),
    notify_subject: z.boolean({ invalid_type_error: 'notify_subject is true or false.' }).optional(),
    result_payload: z.record(z.unknown(), { invalid_type_error: 'result_payload is an object.' }).nullish(),
}, 'Closing a request');

// ───────────────── Helpers ─────────────────

/**
 * The clock every list row and the deadline feed agree on. Prefers the shared
 * helper from compliance/deadlines.js (BE-1a) when it exists, so the register
 * and the overview never disagree on "urgent".
 * @returns {{days_left:number|null, state:'overdue'|'urgent'|'ok'|'none'}}
 */
function clockFor(row, now = Date.now()) {
    if (!row?.due_at || !OPEN.has(row.status)) return { days_left: null, state: 'none' };
    const due = new Date(row.due_at).getTime();
    if (Number.isNaN(due)) return { days_left: null, state: 'none' };
    const daysLeft = Math.ceil((due - now) / DAY_MS);
    try {
        const deadlines = require('../compliance/deadlines');
        if (typeof deadlines.clockState === 'function') {
            const started = row.started_at || row.created_at;
            const startedMs = started ? new Date(started).getTime() : null;
            const { state } = deadlines.clockState('dsr', due, Number.isFinite(startedMs) ? startedMs : null, now);
            return { days_left: daysLeft, state };
        }
    } catch { /* not there — local rule below */ }
    let state = 'ok';
    if (due <= now) state = 'overdue';
    else if (due - now <= URGENT_BELOW_DAYS * DAY_MS) state = 'urgent';
    return { days_left: daysLeft, state };
}

function publicBaseUrl() {
    try {
        if (typeof appPaths.publicBaseUrl === 'function') return String(appPaths.publicBaseUrl()).replace(/\/+$/, '');
    } catch { /* fall through */ }
    const fromEnv = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_APP_URL;
    if (fromEnv) return String(fromEnv).replace(/\/+$/, '');
    return appPaths.clientHost();
}

function listRow(row, now) {
    const clock = clockFor(row, now);
    const masked = maskRequest(row);
    return { ...masked, timeline: undefined, days_left: clock.days_left, state: clock.state };
}

/**
 * Which org a PUBLIC, unauthenticated request belongs to.
 *
 * This is the one place a platform-wide `getUserByEmail` is right: there is no
 * caller org to pin to yet — routing the request IS the question. The answer
 * never leaves the server; it decides which tenant's inbox the row lands in.
 *
 * Do not "fix" this into userStore.findOrgMemberIdByEmail: that helper exists
 * for the opposite situation, where a KNOWN tenant asks about an address and
 * must not be told about accounts outside its own org (compliance/dsr/
 * discovery.js). Here, pinning would file every request under 'default'.
 *
 * Known gap: an address with no Bee Flow account also lands in 'default', so a
 * request from a non-user data subject can sit where the responsible org never
 * sees it while the Art. 12(3) clock runs. Picking the org from something the
 * form itself carries is the fix, and it is an owner decision.
 */
async function _resolveOrgIdFromSubject(email) {
    if (!email) return 'default';
    try {
        const u = await userStore.getUserByEmail?.(email);
        return u?.organizationId || 'default';
    } catch {
        return 'default';
    }
}

async function resolveAdminOrgId(req) {
    const userId = req.session?.user?.id;
    if (!userId) return 'default';
    try {
        const u = await userStore.getUser(userId);
        return u?.organizationId || 'default';
    } catch { return 'default'; }
}

/** Org name + DPO address + locale for the letters. Best-effort, never throws. */
async function letterContext(orgId) {
    const ctx = { orgName: null, dpoEmail: null, locale: 'en' };
    try {
        const org = await userStore.getOrganization?.(orgId);
        if (org?.name) ctx.orgName = org.name;
        if (org?.defaultLocale || org?.locale) ctx.locale = org.defaultLocale || org.locale;
    } catch { /* keep defaults */ }
    try {
        const settings = await complianceStore?.getSettings?.(orgId);
        if (settings?.dpo_email) ctx.dpoEmail = settings.dpo_email;
    } catch { /* keep defaults */ }
    if (!ctx.orgName) ctx.orgName = orgId === 'default' ? 'Bee Flow' : orgId;
    return ctx;
}

function clientIp(req) {
    return req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || null;
}

function parseId(req) {
    const id = parseInt(req.params.id, 10);
    return Number.isFinite(id) && id > 0 ? id : null;
}

async function loadOrgRow(req, res) {
    const orgId = await resolveAdminOrgId(req);
    const id = parseId(req);
    if (!id) { res.status(400).json({ error: 'invalid id' }); return null; }
    const row = await dsrStore.getRequest(orgId, id);
    if (!row) { res.status(404).json({ error: 'not found' }); return null; }
    return { orgId, id, row, actorId: req.session?.user?.id || null };
}

/** Evidence row for the chain — allow-listed, never the address. */
async function writeEvidence(orgId, row, action, actorId, extra = {}) {
    if (!complianceStore?.addEvidence) return;
    const checkId = row.request_type === 'deletion' ? 'GDPR-Art17-dsr-deletion' : 'GDPR-Art15-dsr-access';
    const payload = {
        action,
        request_id: row.id,
        request_type: row.request_type,
        status: extra.status || row.status,
        channel: row.channel || null,
        identity_status: extra.identity_status || row.identity_status || null,
        actor: actorId || null,
        at: new Date().toISOString(),
    };
    if (extra.summary_length != null) payload.summary_length = extra.summary_length;
    if (extra.reason_length != null) payload.reason_length = extra.reason_length;
    if (extra.extended_until) payload.extended_until = extra.extended_until;
    if (extra.discovery) payload.discovery = extra.discovery;
    // The fulfilment must not fail because the ledger did — but a swallowed
    // append is a hole nobody can see, so the rejection is reported instead of
    // dropped (see compliance/evidence/writeFailures).
    const evidenceRow = {
        organization_id: orgId,
        check_id: checkId,
        subject_type: 'dsr_request',
        subject_id: String(row.id),
        payload,
    };
    await complianceStore.addEvidence(evidenceRow).catch(onEvidenceWriteFailed(evidenceRow));
}

/** The ack letter with the identity link, fire-and-forget after intake. */
async function sendAck(orgId, created, email, requestType) {
    const ctx = await letterContext(orgId);
    const base = publicBaseUrl();
    let verifyUrl = null;
    try {
        const { token, tokenHash } = verifyToken.mint({ id: created.id, email, orgId });
        if (await dsrStore.setVerifyTokenHash(orgId, created.id, tokenHash)) {
            verifyUrl = `${base}/dsr/verify?id=${created.id}&token=${encodeURIComponent(token)}`;
        }
    } catch (e) {
        log.warn('[DSR] could not mint verify token:', e.message);
    }
    try {
        if (!emailService?.sendDsrAckEmail) throw new Error('email service unavailable');
        await emailService.sendDsrAckEmail({
            to: email,
            requestId: created.id,
            requestType,
            dueAt: created.due_at,
            verifyUrl,
            statusUrl: `${base}/dsr?id=${created.id}`,
            orgName: ctx.orgName,
            dpoEmail: ctx.dpoEmail,
            locale: ctx.locale,
        });
        await dsrStore.appendTimeline(orgId, created.id, { kind: 'ack_sent', by: null, text: null });
    } catch (e) {
        log.warn(`[DSR] ack e-mail for #${created.id} failed:`, e.message);
        await dsrStore.appendTimeline(orgId, created.id, { kind: 'ack_failed', by: null, text: String(e.message || 'send failed').slice(0, 200) }).catch(() => {});
    }
}

// ───────────────── Public ─────────────────

router.post('/requests', publicSubmitLimiter, validate({ body: PublicIntakeBody }), async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.subject_email || typeof body.subject_email !== 'string') {
            return res.status(400).json({ error: 'subject_email is required' });
        }
        // Light email format check — never reject because we don't want to
        // chill legitimate users out of the DSR channel.
        const email = body.subject_email.trim().toLowerCase();
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        if (!emailOk) return res.status(400).json({ error: 'subject_email is not a valid email address' });
        // Always derive org from the subject's email — never trust a client-supplied
        // organization_id on this public endpoint, or attackers can file fraudulent
        // DSRs against any org.
        const orgId = await _resolveOrgIdFromSubject(email);
        const requestType = String(body.request_type || 'access').toLowerCase();
        const created = await dsrStore.createRequest({
            organization_id: orgId,
            request_type: requestType,
            subject_email: email,
            notes: typeof body.notes === 'string' ? body.notes.slice(0, MAX_NOTE) : null,
            source_ip: clientIp(req),
            channel: 'public_form',
        });
        complianceEvents.emit(complianceEvents.EVENTS.DSR_SUBMITTED, { orgId, requestType });
        // Fire-and-forget: the response must not wait on the mail provider.
        sendAck(orgId, created, email, requestType).catch(e => log.warn('[DSR] ack failed:', e.message));
        res.status(201).json({
            id: created.id,
            created_at: created.created_at,
            due_at: created.due_at,
            status_url: `/api/dsr/requests/${created.id}/public`,
            ack: 'Your request has been received. We will respond within 30 days as required by GDPR.',
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Public status check (no auth, only by id + email match — does not leak the
// request body). Minimal shape.
router.get('/requests/:id/public', publicReadLimiter, validate({ query: PublicStatusQuery }), async (req, res) => {
    const email = (req.query.email || '').toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query param required' });
    const id = parseId(req);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    // We need to scan without orgId here — the public submitter may not
    // know it. We only return a single row keyed by (id, email).
    const { getOne } = require('../db');
    const row = await getOne(`
            SELECT id, status, request_type, created_at, due_at, extended_until, fulfilled_at
            FROM dsr_requests
            WHERE id = $1 AND subject_email = $2
        `, [id, email]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({
        id: row.id,
        status: row.status,
        request_type: row.request_type,
        created_at: row.created_at,
        due_at: row.due_at,
        extended_until: row.extended_until,
        fulfilled_at: row.fulfilled_at,
    });
});

const VERIFY_TOKEN_MAX = 2048;

/**
 * The request id a verify token names, read WITHOUT verifying it.
 *
 * This is a lookup hint and nothing else — exactly as trustworthy as the `id`
 * in the URL, which is to say not at all. The row it points at is then handed
 * to `verifyToken.check`, which re-checks the signature, the purpose, the
 * expiry, the e-mail binding, the org AND that `payload.id` equals the row's
 * id; a forged payload therefore buys a lookup and a 400, never a verified
 * identity. The token is signed over the payload, so this cannot be moved
 * inside `check` without handing it a row it has not seen yet.
 */
function idFromUnverifiedToken(token) {
    if (typeof token !== 'string' || !token || token.length > VERIFY_TOKEN_MAX) return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    try {
        const payload = JSON.parse(signedPayload.b64urlDecode(token.slice(0, dot)).toString('utf8'));
        const id = Number(payload?.id);
        return Number.isInteger(id) && id > 0 ? id : null;
    } catch {
        return null;
    }
}

/**
 * THE gate on both verify routes — one implementation, so the id-less route
 * cannot drift into weaker checks, and written as MIDDLEWARE on purpose.
 *
 * The credential here is the signed link from the acknowledgement mail rather
 * than a session, but it is a gate in every sense that matters: it decides who
 * may flip `identity_status`. auth/routeSurfaceSweep.js accounts for a route by
 * READING this file, so a gate that lives one call deeper than the registration
 * reads there as an ungated public POST — the same reason the admin routes
 * below spell out `requireAuth, requirePermission(...)` instead of spreading a
 * const. Sitting on the registration, the gate is re-proved by that sweep on
 * every run instead of being a claim in an exemption list.
 *
 * What it proves before calling next(): signature, purpose, expiry, the e-mail
 * binding, the org, that the payload names this very row, AND single use — the
 * link is burned here, so past this point the caller held a fresh, unspent link
 * for exactly this request. Every failure is the same 400 `invalid_token`: a
 * probe learns nothing about which part failed. Nothing about the row is
 * logged (BFSF-441) — `row` travels no further than `req.dsrVerified`.
 */
async function requireVerifyToken(req, res, next) {
    const invalid = () => res.status(400).json({ error: 'invalid_token' });
    try {
        const token = req.body?.token;
        // `:id` when the link arrived intact; otherwise the id the token itself
        // names — a lookup hint, no more trustworthy than the URL, which
        // verifyToken.check re-checks against the row below.
        const id = req.params.id === undefined ? idFromUnverifiedToken(token) : parseId(req);
        if (!id || typeof token !== 'string' || !token) return invalid();
        const { getOne } = require('../db');
        const row = await getOne(`
            SELECT id, organization_id, subject_email, identity_status
            FROM dsr_requests WHERE id = $1
        `, [id]);
        if (!row) return invalid();
        const checked = verifyToken.check(token, row);
        if (!checked) return invalid();
        const consumed = await dsrStore.consumeVerifyToken(row.organization_id, id, checked.tokenHash);
        if (!consumed) return invalid();
        req.dsrVerified = { id, row };
        return next();
    } catch (e) {
        log.warn('[DSR] verify failed:', e.message);
        return invalid();
    }
}

/**
 * Past the gate: stamp the identity. Shared by both routes, and it answers the
 * same indistinguishable 400 when the stamp itself fails — the caller cannot
 * tell a spent link from a database that hiccuped.
 */
async function stampVerifiedIdentity(req, res) {
    const { id, row } = req.dsrVerified;
    try {
        if (row.identity_status === 'unverified') {
            await dsrStore.verifyIdentity(row.organization_id, id, { method: 'email_link', by: null });
        }
        res.json({ ok: true, id, identity_status: row.identity_status === 'unverified' ? 'verified_email_link' : row.identity_status });
    } catch (e) {
        log.warn('[DSR] verify stamp failed:', e.message);
        res.status(400).json({ error: 'invalid_token' });
    }
}

// The same acknowledgement link with the id gone — a mail client that rewrote
// the URL, or a subject who copied only `?token=…`. The token binds the id, so
// the server can finish the job the person started instead of telling a
// verified data subject their link is dead. A literal two-segment path: it
// cannot collide with `/requests/:id/verify` (three segments), and it is
// registered first in any case.
router.post('/requests/verify', publicReadLimiter, requireVerifyToken, stampVerifiedIdentity);

// Identity link from the acknowledgement mail, id intact.
router.post('/requests/:id/verify', publicReadLimiter, requireVerifyToken, stampVerifiedIdentity);

// ───────────────── Admin ─────────────────

// Written out on every admin route below rather than spread from a const:
// auth/routeSurfaceSweep.js accounts for a route by READING the file, and a
// `...admin` spread hides the gate from that scan — an ungated-looking DSR
// route is exactly what that sweep exists to catch. (The /api/dsr mount is
// deliberately ungated: the intake must reach a data subject without an
// account, GDPR Art. 12.)

router.post('/requests/manual', requireAuth, requirePermission('admin_compliance'), validate({ body: ManualIntakeBody }), async (req, res) => {
    try {
        const orgId = await resolveAdminOrgId(req);
        const actorId = req.session?.user?.id || null;
        const body = req.body || {};
        const email = typeof body.subject_email === 'string' ? body.subject_email.trim().toLowerCase() : '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'subject_email is not a valid email address' });
        }
        const created = await dsrStore.createManual(orgId, {
            subject_email: email,
            request_type: body.request_type || 'access',
            channel: body.channel || 'other',
            notes: typeof body.notes === 'string' ? body.notes.slice(0, MAX_NOTE) : null,
            received_at: body.received_at || null,
            created_by: actorId,
        });
        complianceEvents.emit(complianceEvents.EVENTS.DSR_SUBMITTED, { orgId, requestType: created.request_type || body.request_type || 'access' });
        const row = await dsrStore.getRequest(orgId, created.id);
        res.status(201).json(listRow(row));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/requests', requireAuth, requirePermission('admin_compliance'), validate({ query: ListQuery }), async (req, res) => {
    const orgId = await resolveAdminOrgId(req);
    const rows = await dsrStore.listRequests(orgId, { status: req.query.status });
    const now = Date.now();
    res.json(rows.map(r => listRow(r, now)));
});

router.get('/requests/:id', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const ctx = await loadOrgRow(req, res);
    if (!ctx) return;
    const { orgId, row, actorId } = ctx;
    // The ONE route that serves the subject's full address, and the access
    // audit row is what makes that lawful (Art. 5(2) accountability; A.8.15
    // asks who read the log). So it is written BEFORE the body goes out and
    // a failure to record is a failure to serve — the same discipline, and
    // the same 500, as the sibling export in
    // routes/compliance/accessAudit.js ("Written before the file goes out,
    // so a failure to record it is a failure to export."). The payload is
    // an explicit allow-list: ids and the request type, never the address.
    try {
        if (typeof userStore.logAccessAudit !== 'function') throw new Error('access audit unavailable on this build');
        await userStore.logAccessAudit(
            'dsr.subject_viewed', 'dsr_request', String(row.id), actorId, null,
            { request_type: row.request_type }, orgId,
        );
    } catch (auditError) {
        // No address, no notes, no subject text — the id and the reason only.
        log.error(`[DSR] access audit for request #${row.id} failed; detail withheld:`, auditError.message);
        return res.status(500).json({
            error: 'Could not record who viewed this request, so it cannot be shown.',
            code: 'audit_write_failed',
        });
    }
    const clock = clockFor(row);
    res.json({ ...row, days_left: clock.days_left, state: clock.state, subject_email_masked: maskEmail(row.subject_email) });
});

router.post('/requests/:id/start', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const ctx = await loadOrgRow(req, res);
        if (!ctx) return;
        const { orgId, id, row, actorId } = ctx;
        if (!OPEN.has(row.status)) return res.status(409).json({ error: 'not_open' });
        const updated = await dsrStore.start(orgId, id, actorId);
        res.json(listRow(updated));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/requests/:id/extend', requireAuth, requirePermission('admin_compliance'), validate({ body: ExtendBody }), async (req, res) => {
    try {
        const ctx = await loadOrgRow(req, res);
        if (!ctx) return;
        const { orgId, id, row, actorId } = ctx;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (!reason) return res.status(400).json({ error: 'reason is required' });
        if (reason.length > MAX_REASON) return res.status(400).json({ error: `reason must be at most ${MAX_REASON} characters` });
        if (!OPEN.has(row.status)) return res.status(409).json({ error: 'not_open' });
        if (row.extended_at) return res.status(409).json({ error: 'already_extended' });

        let updated;
        try {
            updated = await dsrStore.extend(orgId, id, { reason, by: actorId });
        } catch (e) {
            if (e?.code === 'dsr_already_extended' || e instanceof dsrStore.AlreadyExtendedError) {
                return res.status(409).json({ error: 'already_extended' });
            }
            if (/cannot extend a/.test(e.message)) return res.status(409).json({ error: 'not_open' });
            throw e;
        }
        if (!updated) return res.status(404).json({ error: 'not found' });

        // Tell the subject (Art. 12(3): within one month, with the reasons).
        try {
            if (!emailService?.sendDsrExtensionEmail) throw new Error('email service unavailable');
            const letter = await letterContext(orgId);
            await emailService.sendDsrExtensionEmail({
                to: updated.subject_email,
                requestId: updated.id,
                requestType: updated.request_type,
                extendedUntil: updated.extended_until,
                reason,
                orgName: letter.orgName,
                dpoEmail: letter.dpoEmail,
                locale: letter.locale,
            });
            updated = await dsrStore.appendTimeline(orgId, id, { kind: 'extension_emailed', by: actorId });
        } catch (e) {
            log.warn(`[DSR] extension e-mail for #${id} failed:`, e.message);
            updated = await dsrStore.appendTimeline(orgId, id, { kind: 'email_failed', by: actorId, text: String(e.message || 'send failed').slice(0, 200) }).catch(() => updated);
        }

        await writeEvidence(orgId, updated, 'dsr_extended', actorId, {
            reason_length: reason.length,
            extended_until: updated.extended_until,
        });
        complianceEvents.emit(complianceEvents.EVENTS.DSR_EXTENDED, { orgId, requestType: updated.request_type, requestId: id });
        res.json(listRow(updated));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/requests/:id/verify-identity', requireAuth, requirePermission('admin_compliance'), validate({ body: VerifyIdentityBody }), async (req, res) => {
    try {
        const ctx = await loadOrgRow(req, res);
        if (!ctx) return;
        const { orgId, id, actorId } = ctx;
        const method = req.body?.method || 'manual';
        if (method !== 'manual') return res.status(400).json({ error: 'method must be "manual"' });
        let updated = await dsrStore.verifyIdentity(orgId, id, { method: 'manual', by: actorId });
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, MAX_NOTE) : '';
        if (note) updated = await dsrStore.appendTimeline(orgId, id, { kind: 'note', by: actorId, text: note });
        res.json(listRow(updated));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/requests/:id/timeline', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const ctx = await loadOrgRow(req, res);
    if (!ctx) return;
    res.json({ id: ctx.row.id, timeline: maskTimeline(ctx.row.timeline) });
});

router.get('/requests/:id/discovery', requireAuth, requirePermission('admin_compliance'), validate({ query: DiscoveryQuery }), async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(403).json({ error: 'forbidden' });
    const ctx = await loadOrgRow(req, res);
    if (!ctx) return;
    const { orgId, row, actorId } = ctx;
    const result = await discovery.run(orgId, row, { actorId, force: req.query.force === '1' });
    res.json(result);
});

router.post('/requests/:id/fulfil', requireAuth, requirePermission('admin_compliance'), validate({ body: FulfilBody }), async (req, res) => {
    try {
        const ctx = await loadOrgRow(req, res);
        if (!ctx) return;
        const { orgId, id, row, actorId } = ctx;
        const body = req.body || {};
        const status = body.status || 'fulfilled';
        if (status !== 'fulfilled' && status !== 'rejected') {
            return res.status(400).json({ error: 'status must be "fulfilled" or "rejected"' });
        }
        const summary = typeof body.result_summary === 'string' ? body.result_summary.trim() : '';
        if (status === 'fulfilled' && !summary) return res.status(400).json({ error: 'result_summary is required when fulfilling' });
        if (summary.length > MAX_SUMMARY) return res.status(400).json({ error: `result_summary must be at most ${MAX_SUMMARY} characters` });
        if (!OPEN.has(row.status)) return res.status(409).json({ error: 'not_open' });
        const notify = body.notify_subject !== false;

        let updated = await dsrStore.updateStatus(orgId, id, status, {
            fulfilledBy: actorId,
            resultSummary: summary || null,
            resultPayload: body.result_payload,
        });

        // Discovery counts for the evidence row — from the memo when the admin
        // ran the scan from the drawer, never a fresh tenant scan on fulfil.
        // `peek` honours the memo's TTL, so a scan that is no longer current
        // is simply absent here: the append-only chain would otherwise carry
        // an hours-old picture of the tenant stamped as the state at
        // fulfilment, and nothing downstream could tell the two apart.
        const discoverySummary = discovery.summarize(discovery.peek(orgId, id));

        await writeEvidence(orgId, updated, status === 'rejected' ? 'dsr_rejected' : 'dsr_fulfilled', actorId, {
            status,
            summary_length: summary.length,
            discovery: discoverySummary ? { counts: discoverySummary.counts, partial: discoverySummary.partial } : null,
        });

        if (notify) {
            try {
                if (!emailService?.sendDsrResultEmail) throw new Error('email service unavailable');
                const letter = await letterContext(orgId);
                await emailService.sendDsrResultEmail({
                    to: updated.subject_email,
                    requestId: updated.id,
                    requestType: updated.request_type,
                    status,
                    resultSummary: summary,
                    orgName: letter.orgName,
                    dpoEmail: letter.dpoEmail,
                    locale: letter.locale,
                });
                updated = await dsrStore.appendTimeline(orgId, id, { kind: 'result_emailed', by: actorId });
            } catch (e) {
                log.warn(`[DSR] result e-mail for #${id} failed:`, e.message);
                updated = await dsrStore.appendTimeline(orgId, id, { kind: 'email_failed', by: actorId, text: String(e.message || 'send failed').slice(0, 200) }).catch(() => updated);
            }
        }

        // Re-run the matching SLA check so the score reflects the fulfilment
        // immediately instead of after the next 6-hour sweep.
        try {
            const runner = require('../compliance/runner');
            const checkId = updated?.request_type === 'deletion'
                ? 'GDPR-Art17-dsr-deletion'
                : 'GDPR-Art15-dsr-access';
            runner.runOne(orgId, checkId, { runType: 'event' }).catch(() => {});
        } catch (_) { /* compliance module is best-effort */ }
        complianceEvents.emit(complianceEvents.EVENTS.DSR_FULFILLED, { orgId, requestType: updated.request_type, requestId: id, status });
        res.json(listRow(updated));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Dossier export — what the org did with the request, not the subject's
// data. The data itself reaches the subject by the channel the admin chose.
router.get('/requests/:id/export', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const ctx = await loadOrgRow(req, res);
    if (!ctx) return;
    const { orgId, id, row, actorId } = ctx;

    let evidence = [];
    try {
        const rows = await complianceStore?.listEvidence?.(orgId, { subjectType: 'dsr_request', subjectId: String(id), limit: 200 });
        evidence = (rows || []).map(e => ({ seq: e.seq ?? null, hash: e.hash, captured_at: e.captured_at }));
    } catch { evidence = []; }

    let discoverySummary = null;
    try {
        discoverySummary = discovery.summarize(await discovery.run(orgId, row, { actorId }));
    } catch { discoverySummary = null; }

    const clock = clockFor(row);
    // The dossier's own allow-list, not the in-app one: `notes` is what the
    // subject typed on the public form and `result_summary` /
    // `extension_reason` are an admin writing about that same person, so
    // all three (and the timeline text that copies them) would put a name
    // and an address in a downloaded file under a claim that there is
    // none. Lengths go instead — the claim below is what downstream
    // handlers trust, so it stays true.
    const dossier = {
        generated_at: new Date().toISOString(),
        request: { ...dossierRequest(row), days_left: clock.days_left, state: clock.state },
        timeline: dossierTimeline(row.timeline),
        evidence,
        discovery_summary: discoverySummary,
        notes: 'Dossier of how this request was handled. It contains no personal data of the subject and no free text at all (BFSF-441): the subject\'s note, the result summary, the extension reason and the timeline entries are reported as lengths only. The subject\'s own data was delivered to them directly.',
    };
    userStore.logAccessAudit?.('dsr.dossier_exported', 'dsr_request', String(id), actorId, null, null, orgId)?.catch?.(() => {});
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="dsr-${id}-dossier.json"`);
    res.send(JSON.stringify(dossier, null, 2));
});

module.exports = router;
// Exposed for tests / the deadline feed.
module.exports.clockFor = clockFor;
module.exports.URGENT_BELOW_DAYS = URGENT_BELOW_DAYS;
