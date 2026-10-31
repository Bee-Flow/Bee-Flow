// @typecheck noImplicitAny
/**
 * Nextcloud Connector: the branches of POST /auth/connector/bootstrap once
 * the caller's Nextcloud has been verified (auth/connectorBootstrap.js does the
 * header checks, the provisioning-mode lookup and the capabilities round-trip,
 * then hands over here). In order, the first that applies answers:
 *
 *   0. pairing code      (the code IS the approval)
 *   1. returning bind    (instance id already mapped)
 *   2. email verification (exact email or corporate-domain match)
 *      provisioning gate (fresh org refused unless the mode is `open`)
 *   3. fresh org
 *
 * Every branch reads the same context object and answers on `ctx.res`.
 */

const crypto = require('crypto');
const log = require('../../telemetry/log');
const userStore = require('../../stores/userStore');
const { orgHealth } = require('./serviceDeps');
const { buildAutoOrgName } = require('../orgNaming');
const { isFreeEmailDomain, getEffectiveFreeEmailDomains } = require('../../utils/freeEmailDomains');
const {
    NC_INTEGRATIONS,
    slugify,
    applyNcDefaultPlanIfConfigured,
    getOrMintTenantKey,
    ensureOrgAdminUser,
    ensureAdditionalOrgAdmins,
    bindOrgToNcInstance,
} = require('./provisioning');
const { MAX_VERIFICATIONS_PER_ORG, generateVerificationCode, maskEmail } = require('./verificationCode');
const { provesExistingBinding, refuseRebind } = require('./rebindProof');

// Free/public email providers are defined once in utils/freeEmailDomains.js.
// A shared domain there does NOT imply control of a Bee Flow org, so a
// domain-only match against one never routes into adoption — only an exact
// email match to an existing user does. Everything else (different free-provider
// local-part, or no match) creates a fresh org.

// Problems recorded against the pre-org `nc:<instanceId>` subject. A
// successful bind (fresh org, returning bind, pairing redeem, verified
// adoption) resolves them so the fleet view self-heals.
const NC_SUBJECT_PROBLEM_CODES = [
    'bootstrap.verify_failed',
    'bootstrap.rebind_proof_required',
    'bootstrap.pairing_required',
    'bootstrap.pairing_code_invalid',
    'bootstrap.org_create_failed',
    'bootstrap.admin_email_conflict',
];

/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getOrganization>>>} OrgRow */

/**
 * @typedef {{
 *   req: import('express').Request, res: import('express').Response, nc: { themingName: string, ncVersion: string },
 *   provisioningMode: string, ncInstanceId: string, ncBaseUrl: string, ncAdminUid: string, ncAdminEmail: string,
 *   ncAdminDisplayName: string, connectorCallbackUrl: string, pairingCode: string,
 * }} BootstrapContext
 *   `nc`: what the capabilities round-trip reported; `provisioningMode`: 'open' | 'pairing_only'.
 */

// The NC admin's address belongs to a user of ANOTHER org: ensureOrgAdminUser
// threw 409. Record it and answer; any other error propagates.
/**
 * @param {BootstrapContext} ctx
 * @param {OrgRow} org
 * @param {unknown} e
 * @param {string} reason
 * @param {string} [remediation]
 */
function adminEmailConflict(ctx, org, e, reason, remediation) {
    if (/** @type {{ statusCode?: number }} */ (e).statusCode !== 409) throw e;
    orgHealth.problem('bootstrap.admin_email_conflict', {
        orgId: org.id, source: 'connectorBootstrap', req: ctx.req,
        meta: { maskedEmail: maskEmail(ctx.ncAdminEmail), reason },
    });
    return ctx.res.status(409).json({
        error: /** @type {Error} */ (e).message,
        code: 'admin_email_conflict',
        ...(remediation ? { remediation } : {}),
    });
}

// 0. Pairing-code branch — wins over auto-detect when present. The org
//    admin has handed out a one-shot code; whoever holds it gets to bind
//    this NC instance to that specific org. No fresh-org creation, no
//    pending approval queue — the code already IS the approval. Code is
//    consumed atomically on success so it can't be reused.
/** @param {BootstrapContext} ctx */
async function redeemPairingCode(ctx) {
    const { req, res, nc, ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl, pairingCode } = ctx;
    const pending = await userStore.getPendingBindingByPairingCode(pairingCode);
    if (!pending) {
        log.warn(`[ConnectorBootstrap] pairing_code_invalid code=${pairingCode.slice(0, 4)}*** ncInstance=${ncInstanceId}`);
        orgHealth.problem('bootstrap.pairing_code_invalid', {
            ncInstanceId, source: 'connectorBootstrap', req,
            meta: { reason: 'invalid_expired_or_used_code' },
        });
        return res.status(401).json({
            error: 'Pairing code is invalid, expired, or already used',
            code: 'pairing_code_invalid',
            remediation: 'Ask the Bee Flow organisation admin to generate a fresh pairing code from Settings → Organisation → Pair a new Nextcloud, then set it as the BEEFLOW_PAIRING_CODE env var on this connector and reinstall.',
        });
    }
    const targetOrg = await userStore.getOrganization(pending.orgId);
    if (!targetOrg) {
        return res.status(410).json({
            error: 'Organisation for this pairing code no longer exists',
            code: 'pairing_code_org_gone',
        });
    }
    // Refuse to redeem a code against an org that's already bound to a
    // different NC — a misissued code shouldn't be able to steal an
    // existing binding.
    if (targetOrg.nc_instance_id && targetOrg.nc_instance_id !== ncInstanceId) {
        return res.status(409).json({
            error: 'Target organisation is already bound to a different Nextcloud instance',
            code: 'pairing_code_org_already_bound',
        });
    }
    const consumed = await userStore.consumePairingCode(pending.id, {
        ncInstanceId,
        ncBaseUrl,
        ncAdminUid,
        ncAdminEmail,
        ncAdminDisplayName,
        connectorCallbackUrl,
        themingName: nc.themingName,
        ncVersion: nc.ncVersion,
    });
    if (!consumed) {
        // Lost the race against another connector consuming the same code
        // — rare but possible.
        return res.status(409).json({
            error: 'Pairing code was just consumed by another request',
            code: 'pairing_code_race',
        });
    }
    let boundOrg = targetOrg;
    const wasFreshlyBound = !targetOrg.nc_instance_id;
    if (wasFreshlyBound) {
        boundOrg = await bindOrgToNcInstance(targetOrg, {
            ncInstanceId, ncBaseUrl, ncAdminUid, connectorCallbackUrl,
        });
        // Apply default plan only on the first NC binding so we don't
        // overwrite an existing direct-SaaS org's plan when it's adopting
        // an NC tenant for the first time.
        await applyNcDefaultPlanIfConfigured(boundOrg.id, 'pairing_code');
    }
    try {
        await ensureOrgAdminUser(boundOrg, { ncAdminEmail, ncAdminUid, ncAdminDisplayName });
    } catch (e) {
        return adminEmailConflict(ctx, boundOrg, e, 'pairing_code_branch');
    }
    await ensureAdditionalOrgAdmins(boundOrg, req.body?.ncAdmins, ncAdminUid);
    const tenantKey = await getOrMintTenantKey(boundOrg.id);
    log.info(`[ConnectorBootstrap] pairing_code_redeemed org=${boundOrg.id} ncInstance=${ncInstanceId}`);
    orgHealth.event('bootstrap.pairing_redeemed', {
        orgId: boundOrg.id, actorKind: 'connector', req, meta: { ncInstanceId },
    });
    orgHealth.resolve(`nc:${ncInstanceId}`, NC_SUBJECT_PROBLEM_CODES);
    return res.json({
        tenantKey,
        organizationId: boundOrg.id,
        organizationName: boundOrg.name,
        isNew: false,
        isAdopted: true,
        ncVersion: nc.ncVersion,
        code: 'pairing_code_redeemed',
    });
}

// 1. Returning bind — instance id already mapped → idempotent return, once
//    the caller has proved the existing binding (rebindProof.js). The NC
//    admin is created or promoted here only when the proof is the tenant
//    key, or when the address already belongs to a member of this org;
//    otherwise the admin's first signed connector request provisions them
//    (connectorJwtProvision's nc_admin carve-out), with the same result.
/**
 * @param {BootstrapContext} ctx
 * @param {OrgRow} org
 */
async function returningBind(ctx, org) {
    const { req, res, nc, ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl } = ctx;
    const proof = await provesExistingBinding(ctx, org);
    if (!proof) return refuseRebind(ctx, org);
    const existingAdmin = await userStore.getUserByEmail(ncAdminEmail);
    const adminIsMember = !!(existingAdmin && existingAdmin.organizationId === org.id);
    if (proof === 'tenant_key' || adminIsMember) {
        try {
            await ensureOrgAdminUser(org, { ncAdminEmail, ncAdminUid, ncAdminDisplayName });
        } catch (e) {
            return adminEmailConflict(ctx, org, e, 'returning_bind_branch',
                'The Nextcloud admin email is already used by a user in a different Bee Flow organization. Either use a different admin user on Nextcloud, or contact support to merge the accounts.');
        }
        await ensureAdditionalOrgAdmins(org, req.body?.ncAdmins, ncAdminUid);
    } else {
        log.info(`[ConnectorBootstrap] returning_bind org=${org.id}: the NC admin is not a member yet; provisioned on their first connector request`);
    }
    const tenantKey = await getOrMintTenantKey(org.id);
    if (connectorCallbackUrl && org.connector_callback_url !== connectorCallbackUrl) {
        await userStore.updateOrganization(org.id, { connectorCallbackUrl });
    }
    log.info(`[ConnectorBootstrap] returning_bind org=${org.id} ncInstance=${ncInstanceId} ncBaseUrl=${ncBaseUrl} proof=${proof}`);
    orgHealth.event('bootstrap.returning_bind', {
        orgId: org.id, actorKind: 'connector', req, meta: { ncInstanceId, proof },
    });
    orgHealth.touchLiveness(org.id, 'bootstrap');
    orgHealth.resolve(`nc:${ncInstanceId}`, NC_SUBJECT_PROBLEM_CODES);
    return res.json({
        tenantKey,
        organizationId: org.id,
        organizationName: org.name,
        isNew: false,
        ncVersion: nc.ncVersion,
        code: 'returning_bind',
    });
}

// 2. Same-domain match → confirm via an emailed one-time code, entered in
//    the embedded Bee Flow view (no external SaaS login). The code proves
//    control of a mailbox at the matching domain, which is what stops a
//    rogue Nextcloud from silently adopting someone else's org.
//      - Exact email match to an existing user (any domain): always eligible.
//      - Domain-only match: corporate domains only — a shared free-provider
//        domain (gmail.com, …) does not imply org control.
//    No match → fall through to a fresh org (branch 3).
/** @param {BootstrapContext} ctx */
async function findVerificationOrg(ctx) {
    const { ncAdminEmail } = ctx;
    const emailDomain = ncAdminEmail.split('@')[1] || '';
    let verifyOrg = null;
    const candidate = await userStore.getUserByEmail(ncAdminEmail);
    if (candidate?.organizationId) {
        const candidateOrg = await userStore.getOrganization(candidate.organizationId);
        if (candidateOrg && !candidateOrg.nc_instance_id) verifyOrg = candidateOrg;
    }
    if (!verifyOrg && emailDomain && !isFreeEmailDomain(emailDomain, await getEffectiveFreeEmailDomains())) {
        verifyOrg = await userStore.findUnboundOrgByEmailDomain(emailDomain);
    }
    return verifyOrg;
}

/**
 * @param {BootstrapContext} ctx
 * @param {OrgRow} verifyOrg
 */
async function startEmailVerification(ctx, verifyOrg) {
    const { req, res, nc, ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl } = ctx;
    const activeCount = await userStore.countActivePendingNcVerificationsForOrg(verifyOrg.id);
    if (activeCount >= MAX_VERIFICATIONS_PER_ORG) {
        log.warn(`[ConnectorBootstrap] too_many_verifications org=${verifyOrg.id} ncInstance=${ncInstanceId}`);
        orgHealth.problem('bootstrap.too_many_pending_bindings', {
            orgId: verifyOrg.id, source: 'connectorBootstrap', req,
            meta: { ncInstanceId, reason: 'too_many_pending_verifications' },
        });
        return res.status(429).json({
            error: 'Too many pending Nextcloud connection attempts for this organisation. Try again later.',
            code: 'too_many_pending_bindings',
            remediation: 'Wait for the existing verification codes to expire (15 minutes) and retry from the connector.',
        });
    }
    // Create the pending verification but DON'T email a code here. Bootstrap
    // runs at connector startup with no user context, so `ncAdminEmail` is
    // just the arbitrary first admin. The code is sent to whichever admin
    // actually opens the embedded view (see /retarget), so it reaches the
    // person doing the setup — who also becomes the org admin on success.
    const code = generateVerificationCode();
    const pending = await userStore.createPendingNcVerification({
        orgId: verifyOrg.id,
        ncInstanceId,
        ncBaseUrl,
        ncAdminUid,
        ncAdminEmail,
        ncAdminDisplayName,
        connectorCallbackUrl,
        themingName: nc.themingName,
        ncVersion: nc.ncVersion,
        verificationEmail: ncAdminEmail,
    }, { code });
    log.info(`[ConnectorBootstrap] email_verification_required org=${verifyOrg.id} pendingId=${pending.id} ncInstance=${ncInstanceId} expiresAt=${pending.expiresAt}`);
    orgHealth.problem('bootstrap.verification_pending', {
        orgId: verifyOrg.id, source: 'connectorBootstrap', req,
        meta: { pendingId: pending.id, expiresAt: pending.expiresAt, ncInstanceId },
    });
    return res.status(202).json({
        status: 'pending_verification',
        code: 'email_verification_required',
        pendingId: pending.id,
        verifyUrl: `/auth/connector/bootstrap/pending/${pending.id}/verify`,
        resendUrl: `/auth/connector/bootstrap/pending/${pending.id}/resend`,
        retargetUrl: `/auth/connector/bootstrap/pending/${pending.id}/retarget`,
        expiresAt: pending.expiresAt,
        organizationName: verifyOrg.name,
        message: 'Awaiting in-app verification by a Nextcloud admin.',
    });
}

// Provisioning gate — anything reaching here has no existing bind, no valid
// pairing code, and no email-domain match. Auto-creating an org for such a
// caller is exactly the "anyone who knows the server address can mint an
// org" path. Unless this deployment is explicitly `open` (the Bee Flow Cloud
// default), refuse and steer the admin to the pairing-code flow instead.
/** @param {BootstrapContext} ctx */
function refuseFreshOrg(ctx) {
    const { req, res, provisioningMode, ncInstanceId, ncBaseUrl } = ctx;
    log.warn(`[ConnectorBootstrap] fresh_org_refused mode=${provisioningMode} ncInstance=${ncInstanceId} ncBaseUrl=${ncBaseUrl}`);
    orgHealth.problem('bootstrap.pairing_required', {
        ncInstanceId, source: 'connectorBootstrap', req,
        meta: { provisioningMode, ncBaseUrl, reason: `provisioning_mode_${provisioningMode}` },
    });
    return res.status(403).json({
        error: 'This Bee Flow server does not auto-create organisations for new Nextcloud instances.',
        code: 'pairing_required',
        remediation: 'Ask a Bee Flow organisation admin to generate a pairing code (Settings → Organisation → Pair a new Nextcloud), set it as the BEEFLOW_PAIRING_CODE env var on this connector, and redeploy.',
    });
}

// 3. Fresh-org branch — no victim, no risk. One-click.
/** @param {BootstrapContext} ctx */
async function createFreshOrg(ctx) {
    const { req, res, nc, ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl } = ctx;
    const idSuffix = slugify(ncInstanceId.slice(0, 12)) || crypto.randomBytes(3).toString('hex');
    // Capped through the shared slugifier: a theming name is arbitrary text, and
    // createOrganization refuses an id over 48 characters.
    const orgId = require('../accountProvisioning').slugifyOrgId(`nc-${slugify(nc.themingName)}-${idSuffix}`);
    // Build a self-describing org name. Many Nextclouds keep the default
    // theming name "Nextcloud", which produces indistinguishable orgs in the
    // admin list — qualify it with the instance host, e.g. "Nextcloud (nc.e380.net)".
    const orgName = buildAutoOrgName(nc.themingName, ncBaseUrl);
    const created = await userStore.createOrganization({
        id: orgId,
        name: orgName,
        description: `Auto-provisioned from Nextcloud (${ncBaseUrl})`,
        authMethod: 'nextcloud_connector',
        registrationSource: 'nextcloud_connector',
        autoApproveSSO: true,
        ncInstanceId,
        ncBaseUrl,
        ncAdminUid,
        ncProvisionedAt: new Date().toISOString(),
        connectorCallbackUrl: connectorCallbackUrl || null,
        enabledIntegrations: NC_INTEGRATIONS,
    });
    if (!created) {
        // A concurrent bootstrap for the same NC instance may have just won the
        // race: the org id is deterministic, so the loser's INSERT collides on
        // the primary key and createOrganization returns false. Re-fetch — if
        // the org now exists, fall through to returning-bind semantics instead
        // of a misleading HTTP 500 (which would also leave the connector retrying).
        const raced = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
        if (raced) {
            try {
                await ensureOrgAdminUser(raced, { ncAdminEmail, ncAdminUid, ncAdminDisplayName });
            } catch (e) {
                return adminEmailConflict(ctx, raced, e, 'fresh_org_race_branch');
            }
            await ensureAdditionalOrgAdmins(raced, req.body?.ncAdmins, ncAdminUid);
            const tenantKey = await getOrMintTenantKey(raced.id);
            log.info(`[ConnectorBootstrap] fresh_org_race_resolved org=${raced.id} ncInstance=${ncInstanceId}`);
            orgHealth.event('bootstrap.returning_bind', {
                orgId: raced.id, actorKind: 'connector', req, meta: { ncInstanceId, reason: 'fresh_org_race_resolved' },
            });
            orgHealth.touchLiveness(raced.id, 'bootstrap');
            orgHealth.resolve(`nc:${ncInstanceId}`, NC_SUBJECT_PROBLEM_CODES);
            return res.json({
                tenantKey,
                organizationId: raced.id,
                organizationName: raced.name,
                isNew: false,
                ncVersion: nc.ncVersion,
                code: 'returning_bind',
            });
        }
        orgHealth.problem('bootstrap.org_create_failed', {
            ncInstanceId, source: 'connectorBootstrap', req,
            meta: { ncBaseUrl, reason: 'create_organization_returned_false' },
        });
        return res.status(500).json({
            error: 'Failed to create organization',
            code: 'org_create_failed',
            remediation: 'Bee Flow could not provision a new organization. This is usually a transient database issue — wait a minute and the connector will retry automatically. If it persists, contact support with the connector logs.',
        });
    }
    const org = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
    log.info(`[ConnectorBootstrap] fresh_org org=${orgId} ncInstance=${ncInstanceId} ncBaseUrl=${ncBaseUrl} adminEmail=${log.textForLog(ncAdminEmail)}`);
    orgHealth.event('bootstrap.org_created', {
        orgId: org.id, actorKind: 'connector', req, meta: { ncInstanceId, ncBaseUrl },
    });
    orgHealth.resolve(`nc:${ncInstanceId}`, NC_SUBJECT_PROBLEM_CODES);

    await applyNcDefaultPlanIfConfigured(org.id, 'fresh_org');

    try {
        await ensureOrgAdminUser(org, { ncAdminEmail, ncAdminUid, ncAdminDisplayName });
    } catch (e) {
        return adminEmailConflict(ctx, org, e, 'fresh_org_branch',
            'The Nextcloud admin email is already used by a user in another Bee Flow organization. Use a different admin user on Nextcloud, or contact support.');
    }
    await ensureAdditionalOrgAdmins(org, req.body?.ncAdmins, ncAdminUid);
    const tenantKey = await getOrMintTenantKey(org.id);
    return res.json({
        tenantKey,
        organizationId: org.id,
        organizationName: org.name,
        isNew: true,
        ncVersion: nc.ncVersion,
        code: 'fresh_org',
    });
}

/**
 * Answer a verified bootstrap request: the first branch that applies wins.
 * Same order, and the same lookups in the same order, as the single handler
 * this was split out of.
 * @param {BootstrapContext} ctx
 */
async function runBootstrapBranches(ctx) {
    if (ctx.pairingCode) return redeemPairingCode(ctx);
    const org = await userStore.getOrganizationByNcInstanceId(ctx.ncInstanceId);
    if (org) return returningBind(ctx, org);
    const verifyOrg = await findVerificationOrg(ctx);
    if (verifyOrg) return startEmailVerification(ctx, verifyOrg);
    if (ctx.provisioningMode !== 'open') return refuseFreshOrg(ctx);
    return createFreshOrg(ctx);
}

module.exports = {
    NC_SUBJECT_PROBLEM_CODES,
    runBootstrapBranches,
};
