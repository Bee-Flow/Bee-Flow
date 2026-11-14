// @typecheck strict
/**
 * Nextcloud Connector — auto-provisioning bootstrap.
 *
 * On first start, the Bee Flow Nextcloud ExApp connector calls this endpoint
 * with metadata about its NC instance. We split the trust model by branch:
 *
 *   - **Returning bind** (instance id already known): return the cached
 *     tenantKey. Proof: the capabilities round-trip AND the caller's base URL
 *     is the one recorded at bind time (or the request is signed with the
 *     current tenant key); a moved Nextcloud re-pairs with a pairing code.
 *   - **Fresh org** (no SaaS user matches the NC admin email): create a new
 *     Bee Flow org keyed off this NC instance, mint a tenantKey, return it.
 *     One-click. There is no victim — the org is brand new.
 *   - **Adoption** (NC admin email matches an existing un-bound org): the
 *     bootstrap does not bind. A `pending_nc_bindings` row is created and the
 *     caller receives 202. A one-time code is then sent, on request, to an
 *     administrator of that organisation and to nobody else; entering it
 *     links the Nextcloud to that organisation and answers with its tenant
 *     key. A code is accepted once, on a pending row, and only after it was
 *     sent. Anyone else connects with a pairing code from an organisation
 *     administrator.
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
const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');
const router = express.Router();
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { orgHealth } = require('./connector/serviceDeps');
const { sendNcVerificationCodeEmail } = require('../utils/emailService');
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
} = require('./connector/provisioning');
const {
    INSTANCE_BOUND_ELSEWHERE_PROBLEM, alreadyLinkedAnswer, ncInstanceBoundElsewhere, refuseInstanceBoundElsewhere,
    bindOrgToNcInstance, bindOrRefuse,
} = require('./connector/instanceBinding');
const { stableInstanceIdFallback, verifyNcInstance, verifyFailureCategory } = require('./connector/ncVerify');
const { readBootstrapHeaders, callbackUrlRefusal } = require('./connector/bootstrapHeaders');
const { PENDING_TTL_SECONDS, generateVerificationCode, maskEmail } = require('./connector/verificationCode');
const { isAddressOfOrgAdmin, notOrgAdminAnswer } = require('./connector/pendingBinding.mts');
const { NC_SUBJECT_PROBLEM_CODES, runBootstrapBranches } = require('./connector/bootstrapBranches');
const { resolveConnectorBearer, registerRotateKeyRoute } = require('./connector/rotateKey.mts');

// Per-IP limits of these unauthenticated routes (CONNECTOR_BOOTSTRAP_RATE_LIMIT and the fixed ones).
const { bootstrapLimiter, pendingPollLimiter, statusReportLimiter, verificationResendLimiter } = require('./connector/bootstrapLimiters.mts');
const { validate } = require('../core/http/validate');
const { z, bodyOf } = require('../core/http/schemaParts');

// The keys the connector sends (nextcloud-connector/src/bootstrap.js and setup.js).
// Each handler reads and checks the values itself, with the 400 codes the
// connector branches on, so only a key it does not send is refused here.
// POST /connector/status keeps its tolerant contract (see there).
const sent = z.unknown().optional();
const BootstrapBody = bodyOf({ themingName: sent, version: sent, ncAdmins: sent }, 'A connector bootstrap');
const VerifyBody = bodyOf({ code: sent }, 'A verification code');
const ResendBody = bodyOf({}, 'Resending a verification code');
const RetargetBody = bodyOf({ email: sent, uid: sent, displayName: sent }, 'Re-pointing a verification');
const DiagnoseBody = bodyOf({ testToken: sent }, 'A connector diagnosis');

router.post('/connector/bootstrap', bootstrapLimiter, validate({ body: BootstrapBody }), async (req, res) => {
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
    // Checked ahead of the capabilities round-trip (the expensive step) so no
    // branch can store a callback URL this server may not connect to.
    const callbackRefusal = callbackUrlRefusal(connectorCallbackUrl);
    if (callbackRefusal) return res.status(400).json(callbackRefusal);

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
            // The caller is not authenticated: it learns the category only,
            // never the status, error text or body of what was fetched.
            const isUnreachable = verifyFailureCategory(e) === 'unreachable';
            orgHealth.problem('bootstrap.verify_failed', {
                ncInstanceId, source: 'connectorBootstrap', req,
                meta: { reason: isUnreachable ? 'nc_capabilities_unreachable' : 'nc_capabilities_mismatch', ncBaseUrl },
            });
            return res.status(403).json({
                error: isUnreachable
                    ? 'Could not verify NC instance ownership: Nextcloud could not be reached.'
                    : 'Could not verify NC instance ownership: Nextcloud did not confirm this instance.',
                code: isUnreachable ? 'nc_capabilities_unreachable' : 'nc_capabilities_mismatch',
                remediation: isUnreachable
                    ? 'The Bee Flow server could not reach your Nextcloud at ' + ncBaseUrl + '. The server sends its requests to Nextcloud, so that address must be reachable from where the server runs. Make Nextcloud reachable there (a public address, a tunnel or a reverse proxy) and, if Nextcloud is reachable at another address than this one, set BEEFLOW_NC_PUBLIC_URL on the connector to it. A Nextcloud on a private network needs a self-hosted Bee Flow server on that network with its host listed in NEXTCLOUD_ALLOW_PRIVATE_HOSTS (or NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1) on the server.'
                    : 'Your Nextcloud responded but its instance id does not match the one the connector sent. This usually means the connector was reinstalled while the Bee Flow server still tracked the old instance. Contact support if it persists.',
            });
        }
    }

    return runBootstrapBranches({
        req, res, nc, provisioningMode,
        ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl, pairingCode,
    });
});

// How long after an administrator's approval the poll below answers with the
// tenant key. The connector polls every few seconds.
const APPROVAL_PICKUP_WINDOW_MS = 10 * 60_000;

/**
 * The poll's answer for an approved approval row: the tenant key within the
 * pickup window and while the organisation is linked to the row's Nextcloud,
 * 410 otherwise.
 * @param {NonNullable<Awaited<ReturnType<typeof userStore.getPendingNcBinding>>>} row
 * @param {import('express').Response} res
 */
async function answerApproval(row, res) {
    const org = await userStore.getOrganization(row.orgId);
    const approvedAt = row.approvedAt ? new Date(row.approvedAt).getTime() : 0;
    const withinPickup = Date.now() - approvedAt <= APPROVAL_PICKUP_WINDOW_MS;
    if (!org || !withinPickup || !row.ncInstanceId || org.nc_instance_id !== row.ncInstanceId) {
        return res.status(410).json({ status: 'expired' });
    }
    const tenantKey = await getOrMintTenantKey(org.id);
    return res.json({ tenantKey, organizationId: org.id, organizationName: org.name, ncVersion: row.ncVersion, isAdopted: true });
}

// Connector polls this endpoint while a pending binding awaits admin
// approval. The row id reads the status. The tenant key is answered only for
// an approval row (not a pairing-code or verification row: those answer their
// own request), shortly after an authenticated org-admin approved it, and
// while the organisation is linked to the Nextcloud that row is for.
router.get('/connector/bootstrap/pending/:id', pendingPollLimiter, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const row = await userStore.getPendingNcBinding(id);
    if (!row) return res.status(404).json({ status: 'not_found' });
    // Verification rows answer on /verify and pairing-code rows on the
    // bootstrap that presents the code; neither is polled.
    if (row.hasVerification || row.hasPairingCode) return res.status(404).json({ status: 'not_found' });

    const expired = row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
    if (row.status === 'denied') return res.status(410).json({ status: 'denied' });
    if (row.status === 'expired' || (row.status === 'pending' && expired)) {
        // Lazy expiry — sweep this row too.
        if (row.status === 'pending') {
            try { await userStore.expirePendingNcBindings(); } catch (err) { bestEffort('connectorBootstrap:expire-pending', err); }
        }
        return res.status(410).json({ status: 'expired' });
    }
    if (row.status === 'approved') return answerApproval(row, res);
    // status === 'pending'
    return res.status(202).json({
        status: 'pending',
        expiresAt: row.expiresAt,
    });
});

// Submit the emailed verification code. Possession of the code (sent to an
// administrator of the organisation) is the proof of authority; on success we
// bind the org, mint the tenant key and hand it straight back so the connector
// can cache it without a separate poll. Unauthenticated by design — the
// connector has no SaaS creds yet — but attempt-capped (in verifyPendingNcCode)
// and IP-rate-limited.
router.post('/connector/bootstrap/pending/:id/verify', pendingPollLimiter, validate({ body: VerifyBody }), async (req, res) => {
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

    // status 'ok' comes with the matched row.
    const row = /** @type {NonNullable<typeof result.row>} */ (result.row);
    const org = await userStore.getOrganization(row.orgId);
    if (!org) return res.status(410).json({ status: 'expired', code: 'org_gone' });
    // The emailed code links a Nextcloud to an organisation that has none; the
    // key of a linked organisation goes only to a signed bootstrap or to a
    // pairing code issued for it (connector/bootstrapBranches.js).
    if (org.nc_instance_id) return res.status(409).json(alreadyLinkedAnswer());
    // The code was sent to an administrator of this organisation, and it is
    // that administrator who links it.
    const adminEmail = row.verificationEmail || row.ncAdminEmail;
    if (!(await isAddressOfOrgAdmin(org.id, adminEmail))) return res.status(403).json(notOrgAdminAnswer());
    // And it links the Nextcloud to that organisation only (connector/instanceBinding.js).
    const bindCtx = { res, ncInstanceId: row.ncInstanceId };
    if (await ncInstanceBoundElsewhere(org.id, row.ncInstanceId)) {
        return refuseInstanceBoundElsewhere(bindCtx, org, 'email_verification');
    }
    // The steps that can fail come before the link: after a failure the
    // organisation is still unlinked and the same code can be entered again.
    await ensureOrgAdminUser(org, {
        ncAdminEmail: adminEmail,
        ncAdminUid: row.ncAdminUid,
        ncAdminDisplayName: row.ncAdminDisplayName,
    });
    const tenantKey = await getOrMintTenantKey(org.id);
    const boundOrg = await bindOrRefuse(bindCtx, org, {
        ncBaseUrl: row.ncBaseUrl,
        ncAdminUid: row.ncAdminUid,
        connectorCallbackUrl: row.connectorCallbackUrl,
    }, 'email_verification');
    if (!boundOrg) return;
    // From here the code has done its work.
    await userStore.markPendingNcBindingApproved(row.id, null);
    await applyNcDefaultPlanIfConfigured(boundOrg.id, 'email_verification');
    log.info(`[ConnectorBootstrap] verification_succeeded org=${boundOrg.id} ncInstance=${row.ncInstanceId}`);
    orgHealth.event('bootstrap.verification_succeeded', {
        orgId: boundOrg.id, actorKind: 'connector', req, meta: { ncInstanceId: row.ncInstanceId },
    });
    orgHealth.event('bootstrap.org_adopted', {
        orgId: boundOrg.id, actorKind: 'connector', req, meta: { ncInstanceId: row.ncInstanceId },
    });
    orgHealth.resolve(boundOrg.id, ['bootstrap.verification_pending', INSTANCE_BOUND_ELSEWHERE_PROBLEM]);
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
// extended), capped per pendingId and per organisation per day. Goes to the
// address on the row, and only when that is the address of an administrator
// of the row's organisation; the answer is the same either way (sendOrCount).
router.post('/connector/bootstrap/pending/:id/resend', verificationResendLimiter, validate({ body: ResendBody }), async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const current = await userStore.getPendingNcBinding(id);
    const to = current ? (current.verificationEmail || current.ncAdminEmail) : null;
    return sendOrCount(req, res, { id, row: current, to, send: (code) => userStore.resetNcVerificationCode(id, code) });
});

/**
 * A code goes out only to an organisation administrator, but the caller is
 * not authenticated and is told the same in both cases: status, masked
 * address and expiry. For another address no code is made or sent, and the
 * row's send budget is used just the same (countNcVerificationSend).
 * @param {import('express').Request} req @param {import('express').Response} res
 * @param {{ id: string, row: Awaited<ReturnType<typeof userStore.getPendingNcBinding>>, to: string | null, send: (code: string) => Promise<any> }} o
 */
async function sendOrCount(req, res, { id, row, to, send }) {
    const admin = !!row && !!to && await isAddressOfOrgAdmin(row.orgId, to);
    const code = generateVerificationCode();
    const sent = admin ? await send(code) : await userStore.countNcVerificationSend(id);
    if (sent.status === 'too_many') return tooManyCodeRequests(res);
    if (sent.status !== 'ok') return res.status(410).json({ status: 'expired', code: 'expired' });
    const updated = sent.row;
    let emailSent = true;
    if (admin) {
        try {
            const org = await userStore.getOrganization(updated.orgId);
            const r = await sendNcVerificationCodeEmail({ to, code, orgName: org?.name, expiresAt: updated.expiresAt });
            emailSent = !!r?.success;
            if (!emailSent) log.warn(`[ConnectorBootstrap] code_email_failed pendingId=${id} reason=${r?.error}`);
        } catch (e) {
            emailSent = false;
            log.warn(`[ConnectorBootstrap] code_email_error pendingId=${id} reason=${e.message}`);
        }
    }
    log.info(`[ConnectorBootstrap] verification_code_requested pendingId=${id} org=${updated.orgId} sent=${admin && emailSent}`);
    // `emailSent: false` only for a delivery that failed; the connector reads a missing field as sent.
    return res.json({ ok: true, maskedEmail: maskEmail(to), expiresAt: updated.expiresAt, ...(emailSent ? {} : { emailSent: false }) });
}

// Re-point a pending verification at the admin who is actually performing the
// setup (the NC user in the embedded view), then email them the code. The
// connector supplies the current user's email/uid; the code is sent only when
// that address is the one of an administrator of the row's organisation, and
// the answer is the same either way (sendOrCount).
router.post('/connector/bootstrap/pending/:id/retarget', verificationResendLimiter, validate({ body: RetargetBody }), async (req, res) => {
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
    return sendOrCount(req, res, { id, row, to: email, send: (code) => userStore.retargetNcVerification(id, { email, uid, displayName, code }) });
});

// Diagnostic endpoint — connector calls this when /api/license/* keeps
// returning "no matching tenant key" and we need to know why without
// kubectl-ing into the server pod. Authentication is the same NC-ownership
// proof as bootstrap (round-trip the instanceid via /ocs capabilities), so
// possession of a fake header set isn't enough. Returns NO secret material —
// only fingerprints (first 16 hex chars of sha256) so the caller can compare
// against its own locally cached key.
router.post('/connector/diagnose', bootstrapLimiter, validate({ body: DiagnoseBody }), async (req, res) => {
    const h = readBootstrapHeaders(req);
    if (!h.ncInstanceId || !h.ncBaseUrl) {
        return res.status(400).json({
            error: 'Missing X-Beeflow-NC-Instance-Id or X-Beeflow-NC-Base-Url header',
        });
    }
    try {
        await verifyNcInstance(h.ncBaseUrl, h.ncInstanceId);
    } catch (e) {
        log.warn(`[ConnectorBootstrap] diagnose verify_failed ncInstance=${h.ncInstanceId} reason=${e.message}`);
        return res.status(403).json({
            error: 'NC ownership verification failed',
            code: verifyFailureCategory(e) === 'unreachable' ? 'nc_capabilities_unreachable' : 'nc_capabilities_mismatch',
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
