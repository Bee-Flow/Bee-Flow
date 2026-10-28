// @typecheck noImplicitAny
/**
 * Nextcloud Connector — auto-provisioning bootstrap.
 *
 * On first start, the Bee Flow Nextcloud ExApp connector calls this endpoint
 * with metadata about its NC instance. We split the trust model by branch:
 *
 *   - **Returning bind** (instance id already known): retourneer cached
 *     tenantKey direct. Bewijs: same instance id round-trips capabilities.
 *   - **Fresh org** (no SaaS user matches the NC admin email): create a new
 *     Bee Flow org keyed off this NC instance, mint a tenantKey, return it.
 *     One-click. There is no victim — the org is brand new.
 *   - **Adoption** (NC admin email matches an existing un-bound org):
 *     **Do NOT bind.** A `pending_nc_bindings` row is created and the
 *     caller receives 202 with a poll URL. The org-admin must explicitly
 *     approve the binding from inside the authenticated SaaS UI before the
 *     connector ever sees the tenantKey. This blocks the unauthenticated
 *     org-takeover where an attacker hosting a fake NC could otherwise
 *     adopt a victim's org by claiming the victim's email.
 *
 * The connector caches the returned key in its persistent storage volume so
 * subsequent restarts don't re-bootstrap.
 *
 * No request schema, on purpose: every caller is the connector ExApp, which
 * each customer upgrades on their own schedule, so a closed body would refuse
 * the next connector's new field and stall that tenant's provisioning or
 * health reports (the same reason routes/nextcloudStudioApps.js gives). The
 * identity travels in the X-Beeflow-NC-* headers, checked above every branch;
 * the few body values are coerced where they are read (the status report
 * through a strict whitelist of capped strings, codes and addresses through
 * String().trim(), `ncAdmins` through _selectSecondaryAdmins).
 */

const express = require('express');
const crypto = require('crypto');
// The CJS build exports the limiter function itself (its .d.cts only describes the namespace).
const rateLimit = /** @type {typeof import('express-rate-limit').rateLimit} */ (/** @type {unknown} */ (require('express-rate-limit')));
const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');
const router = express.Router();
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { orgHealth } = require('./connector/serviceDeps');
const { sendNcVerificationCodeEmail } = require('../utils/emailService');
const { isFreeEmailDomain, getEffectiveFreeEmailDomains } = require('../utils/freeEmailDomains');
// The pieces this router is built from (split out of this file; `helpers` at
// the bottom still exports every name it exported before).
const {
    TENANT_KEY_PREFIX,
    PROVISIONING_MODES,
    NC_INTEGRATIONS,
    applyNcDefaultPlanIfConfigured,
    defaultProvisioningMode,
    resolveProvisioningMode,
    getOrMintTenantKey,
    ensureOrgAdminUser,
    ensureAdditionalOrgAdmins,
    _selectSecondaryAdmins,
    bindOrgToNcInstance,
} = require('./connector/provisioning');
const { stableInstanceIdFallback, verifyNcInstance } = require('./connector/ncVerify');
const { PENDING_TTL_SECONDS, generateVerificationCode, maskEmail } = require('./connector/verificationCode');
const { NC_SUBJECT_PROBLEM_CODES, runBootstrapBranches } = require('./connector/bootstrapBranches');
const { resolveConnectorBearer, registerRotateKeyRoute } = require('./connector/rotateKey.mts');

// Bootstrap is unauthenticated by design (the connector has no SaaS creds
// at this point). Rate-limit per source IP so an attacker can't flood the
// pending-binding queue or fish for org-emails. The numbers below are
// generous enough for a real fleet rollout (multiple NC instances behind
// the same NAT) but tight enough to make brute-force/DoS impractical.
// `validate: { trustProxy: false }` silences express-rate-limit's strict
// trust-proxy validator. The server runs behind Nginx Proxy Manager which
// sets X-Forwarded-For; Express resolves req.ip via app.set('trust proxy').
// We accept that a determined attacker could spoof XFF to evade per-IP
// limiting — bootstrap is also gated by the NC capabilities round-trip,
// and the limiter's main job is slowing down org-email enumeration.
const bootstrapLimiter = rateLimit({
    windowMs: 15 * 60_000,        // 15 minutes
    max: 20,                       // 20 bootstrap attempts per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many bootstrap attempts; try again later.' },
    validate: { trustProxy: false },
});

const pendingPollLimiter = rateLimit({
    windowMs: 60_000,              // 1 minute
    max: 60,                       // 1 poll/sec average — connector polls every ~5s
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many poll requests.' },
    validate: { trustProxy: false },
});

// Phone-home status reports are a periodic heartbeat (connector pings ~6-hourly
// plus one report per failure episode) — 12/hour/IP is generous for a real
// fleet behind one NAT while keeping unauthenticated probing cheap to absorb.
const statusReportLimiter = rateLimit({
    windowMs: 60 * 60_000,         // 1 hour
    max: 12,                       // 12 status reports per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many status reports; try again later.' },
    validate: { trustProxy: false },
});

// Resending a verification code emails the org's admin mailbox; cap it tightly
// per source IP so a held pendingId can't be used to mail-bomb the address.
const verificationResendLimiter = rateLimit({
    windowMs: 15 * 60_000,         // 15 minutes
    max: 5,                        // 5 resends per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many code requests; try again later.' },
    validate: { trustProxy: false },
});

/** @param {import('express').Request} req */
function readBootstrapHeaders(req) {
    return {
        ncInstanceId: String(req.headers['x-beeflow-nc-instance-id'] || '').trim(),
        ncBaseUrl: String(req.headers['x-beeflow-nc-base-url'] || '').trim().replace(/\/+$/, ''),
        ncAdminUid: String(req.headers['x-beeflow-nc-admin-uid'] || '').trim(),
        ncAdminEmail: String(req.headers['x-beeflow-nc-admin-email'] || '').trim().toLowerCase(),
        ncAdminDisplayName: String(req.headers['x-beeflow-nc-admin-display-name'] || '').trim(),
        connectorCallbackUrl: String(req.headers['x-beeflow-connector-callback-url'] || '').trim().replace(/\/+$/, ''),
        pairingCode: String(req.headers['x-beeflow-pairing-code'] || '').trim().toUpperCase(),
    };
}

router.post('/connector/bootstrap', bootstrapLimiter, async (req, res) => {
    const { ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl, pairingCode } = readBootstrapHeaders(req);
    if (!ncInstanceId || !ncBaseUrl || !ncAdminUid || !ncAdminEmail) {
        return res.status(400).json({
            error: 'Missing required X-Beeflow-NC-* headers',
            code: 'missing_headers',
            remediation: 'The Bee Flow connector must send X-Beeflow-NC-Instance-Id, -Base-Url, -Admin-Uid and -Admin-Email. Re-deploy the connector or upgrade to the latest release.',
        });
    }
    if (!ncAdminEmail.includes('@')) {
        return res.status(400).json({
            error: 'NC admin email is not a valid email',
            code: 'invalid_admin_email',
            remediation: 'Configure an email address on your Nextcloud admin user and re-deploy the connector.',
        });
    }

    // Resolve the provisioning policy once, up front and OUTSIDE the
    // skip-verify shortcut below, so the dev bypass can never open the gate.
    // It only gates the fresh-org branch (3); branches 0–2 are unaffected.
    const provisioningMode = await resolveProvisioningMode();

    let nc;
    if (process.env.BEEFLOW_BOOTSTRAP_SKIP_VERIFY === 'true') {
        log.warn('[ConnectorBootstrap] BEEFLOW_BOOTSTRAP_SKIP_VERIFY=true — skipping capabilities check');
        nc = { themingName: 'Nextcloud (dev)', ncVersion: 'unverified' };
    } else {
        try {
            nc = await verifyNcInstance(ncBaseUrl, ncInstanceId);
        } catch (e) {
            log.warn(`[ConnectorBootstrap] verify_failed url=${ncBaseUrl} ncInstance=${ncInstanceId} reason=${e.message}`);
            const isUnreachable = /unreachable|fetch failed|timeout|ENOTFOUND|ECONNREFUSED/i.test(e.message);
            orgHealth.problem('bootstrap.verify_failed', {
                ncInstanceId, source: 'connectorBootstrap', req,
                meta: { reason: isUnreachable ? 'nc_capabilities_unreachable' : 'nc_capabilities_mismatch', ncBaseUrl },
            });
            return res.status(403).json({
                error: 'Could not verify NC instance ownership: ' + e.message,
                code: isUnreachable ? 'nc_capabilities_unreachable' : 'nc_capabilities_mismatch',
                remediation: isUnreachable
                    ? 'Bee Flow Cloud could not reach your Nextcloud at ' + ncBaseUrl + '. Your Nextcloud must be publicly reachable for SaaS-to-NC callbacks. Either expose it publicly, or set BEEFLOW_NC_PUBLIC_URL in the connector to an HTTPS tunnel or reverse-proxy URL we can reach.'
                    : 'Your Nextcloud responded but its instance id does not match the one the connector sent. This usually means the connector was reinstalled while the SaaS still tracked the old instance. Contact support if it persists.',
            });
        }
    }

    return runBootstrapBranches({
        req, res, nc, provisioningMode,
        ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl, pairingCode,
    });
});

// Connector polls this endpoint while a pending binding awaits admin
// approval. Possession of the random `id` lets the caller read status only —
// no privileges are granted by the token alone. The tenantKey is only
// returned once an authenticated org-admin has approved the binding.
router.get('/connector/bootstrap/pending/:id', pendingPollLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const row = await userStore.getPendingNcBinding(id);
    if (!row) return res.status(404).json({ status: 'not_found' });
    // Email-verification rows are confirmed via the /verify endpoint, not by
    // polling. Don't expose them here — that would hand the tenant key to anyone
    // holding the id once the code is accepted.
    if (row.hasVerification) return res.status(404).json({ status: 'not_found' });

    const expired = row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
    if (row.status === 'denied') return res.status(410).json({ status: 'denied' });
    if (row.status === 'expired' || (row.status === 'pending' && expired)) {
        // Lazy expiry — sweep this row too.
        if (row.status === 'pending') {
            try { await userStore.expirePendingNcBindings(); } catch (err) { bestEffort('connectorBootstrap:expire-pending', err); }
        }
        return res.status(410).json({ status: 'expired' });
    }
    if (row.status === 'approved') {
        const org = await userStore.getOrganization(row.orgId);
        if (!org) return res.status(410).json({ status: 'expired' });
        const tenantKey = await getOrMintTenantKey(org.id);
        return res.json({
            tenantKey,
            organizationId: org.id,
            organizationName: org.name,
            ncVersion: row.ncVersion,
            isAdopted: true,
        });
    }
    // status === 'pending'
    return res.status(202).json({
        status: 'pending',
        expiresAt: row.expiresAt,
    });
});

// Submit the emailed verification code. Possession of the code (delivered to a
// mailbox at the matching domain) is the proof of authority; on success we bind
// the org, mint the tenant key and hand it straight back so the connector can
// cache it without a separate poll. Unauthenticated by design — the connector
// has no SaaS creds yet — but attempt-capped (in verifyPendingNcCode) and
// IP-rate-limited.
router.post('/connector/bootstrap/pending/:id/verify', pendingPollLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Enter the 6-digit code from the email.', code: 'invalid_code' });
    }

    const result = await userStore.verifyPendingNcCode(id, code);
    switch (result.status) {
        case 'not_found': return res.status(404).json({ status: 'not_found', code: 'not_found' });
        case 'not_verification': return res.status(409).json({ error: 'This connection does not use email verification.', code: 'not_verification' });
        case 'denied': return res.status(410).json({ status: 'denied', code: 'denied' });
        case 'expired': return res.status(410).json({ status: 'expired', code: 'expired', remediation: 'The code expired. Request a new one and try again.' });
        case 'too_many': return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.', code: 'too_many_attempts' });
        case 'invalid': return res.status(400).json({ error: 'That code is not correct.', code: 'invalid_code', attemptsLeft: result.attemptsLeft });
        case 'ok': break;
        default: throw new Error(`Unexpected verification status '${result.status}'`);
    }

    const row = result.row;
    const org = await userStore.getOrganization(row.orgId);
    if (!org) return res.status(410).json({ status: 'expired', code: 'org_gone' });
    if (org.nc_instance_id && org.nc_instance_id !== row.ncInstanceId) {
        return res.status(409).json({ error: 'Organisation is already bound to a different Nextcloud instance', code: 'already_bound' });
    }

    let boundOrg = org;
    const wasUnbound = !org.nc_instance_id;
    if (wasUnbound) {
        boundOrg = await bindOrgToNcInstance(org, {
            ncInstanceId: row.ncInstanceId,
            ncBaseUrl: row.ncBaseUrl,
            ncAdminUid: row.ncAdminUid,
            connectorCallbackUrl: row.connectorCallbackUrl,
        });
        await applyNcDefaultPlanIfConfigured(boundOrg.id, 'email_verification');
    }
    try {
        await ensureOrgAdminUser(boundOrg, {
            ncAdminEmail: row.ncAdminEmail,
            ncAdminUid: row.ncAdminUid,
            ncAdminDisplayName: row.ncAdminDisplayName,
        });
    } catch (e) {
        if (e.statusCode === 409) {
            orgHealth.problem('bootstrap.admin_email_conflict', {
                orgId: boundOrg.id, source: 'connectorBootstrap', req,
                meta: { maskedEmail: maskEmail(row.ncAdminEmail), reason: 'verification_branch' },
            });
            return res.status(409).json({ error: e.message, code: 'admin_email_conflict' });
        }
        throw e;
    }
    const tenantKey = await getOrMintTenantKey(boundOrg.id);
    await userStore.markPendingNcBindingApproved(row.id, null);
    log.info(`[ConnectorBootstrap] verification_succeeded org=${boundOrg.id} ncInstance=${row.ncInstanceId}`);
    orgHealth.event('bootstrap.verification_succeeded', {
        orgId: boundOrg.id, actorKind: 'connector', req, meta: { ncInstanceId: row.ncInstanceId },
    });
    if (wasUnbound) {
        orgHealth.event('bootstrap.org_adopted', {
            orgId: boundOrg.id, actorKind: 'connector', req, meta: { ncInstanceId: row.ncInstanceId },
        });
    }
    orgHealth.resolve(boundOrg.id, ['bootstrap.verification_pending']);
    orgHealth.resolve(`nc:${row.ncInstanceId}`, NC_SUBJECT_PROBLEM_CODES);
    return res.json({
        tenantKey,
        organizationId: boundOrg.id,
        organizationName: boundOrg.name,
        ncVersion: row.ncVersion,
        isAdopted: true,
        code: 'verified',
    });
});

// A pending row's code-send/attempt budget is spent (ncBindings.js caps it per
// pendingId, independent of the per-IP limiter): no new code until it expires.
/** @param {import('express').Response} res */
const tooManyCodeRequests = (res) => res.status(429).json({
    error: 'Too many code requests for this connection; try again later.',
    code: 'too_many_code_requests',
    remediation: 'Wait for the current verification to expire (15 minutes) and retry from the connector.',
});

// Re-send the verification code (new code, per-code attempts reset, TTL
// extended), capped per pendingId. Goes to the same mailbox the original was
// sent to, so a held pendingId can't redirect the code elsewhere.
router.post('/connector/bootstrap/pending/:id/resend', verificationResendLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const code = generateVerificationCode();
    const sent = await userStore.resetNcVerificationCode(id, code);
    if (sent.status === 'too_many') return tooManyCodeRequests(res);
    if (sent.status !== 'ok') return res.status(410).json({ status: 'expired', code: 'expired' });
    const row = sent.row;
    const to = row.verificationEmail || row.ncAdminEmail;
    let emailSent = false;
    try {
        const org = await userStore.getOrganization(row.orgId);
        const r = await sendNcVerificationCodeEmail({ to, code, orgName: org?.name, expiresAt: row.expiresAt });
        emailSent = !!r?.success;
    } catch (e) {
        log.warn(`[ConnectorBootstrap] resend_email_error pendingId=${id} reason=${e.message}`);
    }
    log.info(`[ConnectorBootstrap] verification_resent pendingId=${id} emailSent=${emailSent} expiresAt=${row.expiresAt}`);
    return res.json({ ok: true, maskedEmail: maskEmail(to), expiresAt: row.expiresAt, emailSent });
});

// Re-point a pending verification at the admin who is actually performing the
// setup (the NC user in the embedded view), then email them the code. The
// connector supplies the current user's email/uid; we re-validate that the
// email qualifies for the org before redirecting the code, so a held pendingId
// can't be used to send the code to an unrelated mailbox.
router.post('/connector/bootstrap/pending/:id/retarget', verificationResendLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const uid = String(req.body?.uid || '').trim();
    const displayName = String(req.body?.displayName || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required', code: 'invalid_email' });

    const row = await userStore.getPendingNcBinding(id);
    if (!row) return res.status(404).json({ status: 'not_found', code: 'not_found' });
    if (!row.hasVerification || row.status !== 'pending') {
        return res.status(409).json({ error: 'No pending verification for this connection', code: 'not_verification' });
    }
    const expired = row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
    if (expired) return res.status(410).json({ status: 'expired', code: 'expired' });

    // The target email must itself qualify for the org being linked — exact
    // user match, or a matching corporate domain. Mirrors the bootstrap routing.
    const domain = email.split('@')[1] || '';
    let qualifies = false;
    const exact = await userStore.getUserByEmail(email);
    if (exact?.organizationId === row.orgId) qualifies = true;
    if (!qualifies && domain && !isFreeEmailDomain(domain, await getEffectiveFreeEmailDomains())) {
        const o = await userStore.findUnboundOrgByEmailDomain(domain);
        if (o?.id === row.orgId) qualifies = true;
    }
    if (!qualifies) {
        return res.status(403).json({
            error: 'This Nextcloud account is not part of the Bee Flow organisation this connection is being linked to.',
            code: 'email_not_in_org',
        });
    }

    const code = generateVerificationCode();
    const sent = await userStore.retargetNcVerification(id, { email, uid, displayName, code });
    if (sent.status === 'too_many') return tooManyCodeRequests(res);
    if (sent.status !== 'ok') return res.status(410).json({ status: 'expired', code: 'expired' });
    const updated = sent.row;

    let emailSent = false;
    try {
        const org = await userStore.getOrganization(row.orgId);
        const r = await sendNcVerificationCodeEmail({ to: email, code, orgName: org?.name, expiresAt: updated.expiresAt });
        emailSent = !!r?.success;
        if (!emailSent) log.warn(`[ConnectorBootstrap] retarget_email_failed pendingId=${id} reason=${r?.error}`);
    } catch (e) {
        log.warn(`[ConnectorBootstrap] retarget_email_error pendingId=${id} reason=${e.message}`);
    }
    log.info(`[ConnectorBootstrap] verification_retargeted pendingId=${id} org=${row.orgId} emailSent=${emailSent}`);
    return res.json({ ok: true, maskedEmail: maskEmail(email), expiresAt: updated.expiresAt, emailSent });
});

// Diagnostic endpoint — connector calls this when /api/license/* keeps
// returning "no matching tenant key" and we need to know why without
// kubectl-ing into the server pod. Authentication is the same NC-ownership
// proof as bootstrap (round-trip the instanceid via /ocs capabilities), so
// possession of a fake header set isn't enough. Returns NO secret material —
// only fingerprints (first 16 hex chars of sha256) so the caller can compare
// against its own locally cached key.
router.post('/connector/diagnose', bootstrapLimiter, async (req, res) => {
    const h = readBootstrapHeaders(req);
    if (!h.ncInstanceId || !h.ncBaseUrl) {
        return res.status(400).json({
            error: 'Missing X-Beeflow-NC-Instance-Id or X-Beeflow-NC-Base-Url header',
        });
    }
    try {
        await verifyNcInstance(h.ncBaseUrl, h.ncInstanceId);
    } catch (e) {
        return res.status(403).json({
            error: 'NC ownership verification failed',
            detail: e.message,
        });
    }

    /** @type {{ ncInstanceId: string, ncBaseUrl: string, org: { id: string, name: string, ncOnboardingCompletedAt: string | null } | null, tenantKey: { exists: boolean, decryptOk?: boolean, decryptError?: string, fingerprint?: string, updatedAt?: string | Date, testVerify?: Record<string, unknown> } }} */
    const out = {
        ncInstanceId: h.ncInstanceId,
        ncBaseUrl: h.ncBaseUrl,
        org: null,
        tenantKey: { exists: false },
    };

    let org;
    try {
        org = await userStore.getOrganizationByNcInstanceId(h.ncInstanceId);
    } catch (e) {
        log.error('[ConnectorBootstrap] org lookup failed:', e);
        return res.status(500).json({ ...out, error: 'org lookup failed' });
    }
    if (!org) {
        return res.json({
            ...out,
            note: 'No organization bound to this NC instance — bootstrap has not run, or it failed before persisting the binding.',
        });
    }
    out.org = {
        id: org.id,
        name: org.name,
        ncOnboardingCompletedAt: org.nc_onboarding_completed_at || null,
    };

    const cfgKey = TENANT_KEY_PREFIX + org.id;
    let decrypted = null;
    let decryptError = null;
    try {
        decrypted = await configStore.getSecret(cfgKey);
    } catch (e) {
        decryptError = e.message;
    }
    out.tenantKey.exists = !!decrypted;
    out.tenantKey.decryptOk = !decryptError;
    if (decryptError) out.tenantKey.decryptError = decryptError;
    if (decrypted) {
        out.tenantKey.fingerprint = crypto.createHash('sha256')
            .update(decrypted)
            .digest('hex')
            .slice(0, 16);
    }

    // Look up the raw row's updated_at so the caller can see how stale the
    // stored key is relative to when it last bootstrapped. Direct DB read —
    // configStore has no metadata helper.
    try {
        const { getOne } = require('../db');
        const row = await getOne('SELECT updated_at FROM config WHERE key = $1', [cfgKey]);
        if (row?.updated_at) out.tenantKey.updatedAt = row.updated_at;
    } catch (err) { bestEffort('connectorBootstrap:diag-updated-at', err); }

    // If the caller sent a test JWT, try to verify it against the stored
    // key. This is the smoking-gun check: connector says "this is what I'm
    // signing with", SaaS says "and this is what verification gives".
    const testToken = typeof req.body?.testToken === 'string' ? req.body.testToken.trim() : '';
    if (testToken) {
        if (!decrypted) {
            out.tenantKey.testVerify = { ok: false, error: 'no stored key to verify against' };
        } else {
            try {
                const { _verifyHs256 } = require('./connectorJwt');
                const payload = _verifyHs256(testToken, decrypted);
                out.tenantKey.testVerify = {
                    ok: true,
                    sub: payload.sub || null,
                    email: payload.email || null,
                    exp: payload.exp || null,
                };
            } catch (e) {
                out.tenantKey.testVerify = { ok: false, error: e.message };
            }
        }
    }

    return res.json(out);
});

// ── Connector phone-home ────────────────────────────────────────────────────
// POST /auth/connector/status — the connector (v≥ next ExApp release) reports
// its own health so tenant-side failures (stale key retry loops, categorised
// bootstrap errors) land in the org-health dashboard even when no user is
// clicking around. Auth: Bearer tenant-JWT verified by iterating tenant keys
// (same two-pass resolver the per-user middleware uses). Unauthenticated or
// unmatched callers get a plain 401 and NOTHING is recorded — an unverified
// body must not be able to spam the health tables. Body fields outside the
// strict whitelist {state, category, code, connectorVersion, lastAttemptAt}
// are ignored. Always 204 on success — the connector treats this as
// fire-and-forget and must never block on it.
router.post('/connector/status', statusReportLimiter, express.json({ limit: '4kb' }), async (req, res) => {
    const resolved = await resolveConnectorBearer(req);
    if ('error' in resolved) {
        // No emit here — see header comment (spam protection).
        return res.status(401).json({ error: resolved.error });
    }
    const orgId = resolved.orgId;

    // Strict whitelist; everything is length-capped strings or dropped.
    const body = req.body || {};
    const state = body.state === 'ok' ? 'ok' : (body.state === 'error' ? 'error' : null);
    /**
     * @param {unknown} v
     * @param {number} max
     */
    const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
    const connectorVersion = str(body.connectorVersion, 64);
    const category = str(body.category, 64);
    const reportedCode = str(body.code, 64);
    const lastAttemptAt = str(body.lastAttemptAt, 40);

    orgHealth.touchLiveness(orgId, 'statusReport', { connectorVersion });
    if (state === 'error') {
        orgHealth.problem('connector.reported_error', {
            orgId, source: 'connectorBootstrap', req,
            meta: {
                category, code: reportedCode, reason: category,
                lastAttemptAt, connectorVersion,
            },
        });
    } else if (state === 'ok') {
        orgHealth.resolve(orgId, ['connector.reported_error', 'connector.key_divergence']);
    }
    return res.status(204).end();
});

registerRotateKeyRoute(router);

module.exports = Object.assign(router, { helpers: {
    NC_INTEGRATIONS,
    PENDING_TTL_SECONDS,
    applyNcDefaultPlanIfConfigured,
    NC_SUBJECT_PROBLEM_CODES,
    getOrMintTenantKey,
    ensureOrgAdminUser,
    ensureAdditionalOrgAdmins,
    _selectSecondaryAdmins,
    bindOrgToNcInstance,
    defaultProvisioningMode,
    resolveProvisioningMode,
    stableInstanceIdFallback,
    verifyNcInstance,
    PROVISIONING_MODES,
} });
