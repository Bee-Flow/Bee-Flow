// @typecheck
/**
 * accountProvisioning.js — the one path every web signup takes.
 *
 * Organisation and consumer accounts used to be created by two near-verbatim
 * copies of the same code (the password route in loginRoutes.js and the OAuth
 * callback in oauthRoutes.js), which had silently drifted apart: the OAuth copy
 * skipped the signup_org_enabled check, logged a warning instead of failing when
 * the org name or domain was taken (leaving the founder without an organisation),
 * and assigned the default plan a second time without filtering on plan_type.
 *
 * This module owns everything around identity creation — the guards, where the
 * account lands, and the post-creation side effects — but deliberately NOT the
 * credential itself: password hashing stays in the password route and the OAuth
 * JIT user row stays in the OAuth callback. The three phases are:
 *
 *   normalizeSignupIntent()   what the caller asked for, in one shape
 *   prepareAccountPlacement() where the account lands   (runs BEFORE the user row exists)
 *   finalizeAccount()         everything that follows   (runs AFTER the user row exists)
 *
 * Placement runs first so a rejected signup — org name taken, domain taken,
 * org signups disabled — never leaves a half-created user behind.
 *
 * Organisation vs consumer diverges at exactly one switch, in
 * prepareAccountPlacement. Everything downstream is branch-free apart from two
 * one-line helpers (shieldKey, trialTarget) that pick an org-scoped or
 * user-scoped key.
 */

const crypto = require('crypto');
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { checkWebSignupAllowed, resolveSignupLocale } = require('./signupGuards');
const { isFreeEmailDomain, getEffectiveFreeEmailDomains } = require('../utils/freeEmailDomains');
const { sanitizePlainTextFields } = require('../utils/htmlSanitizer');
const log = require('../telemetry/log');

/**
 * Every way a signup can be refused, with the HTTP status the password route
 * returns and the ?error= slug the OAuth callback redirects with. The slugs the
 * SPA already handles keep their exact historical values — changing one silently
 * turns a specific error screen into a generic one.
 */
const SIGNUP_ERRORS = Object.freeze({
    SIGNUPS_DISABLED: { status: 403, oauthCode: 'signup_disabled' },
    CONNECTOR_ONLY: { status: 403, oauthCode: 'signup_connector_only' },
    GEO_BLOCKED: { status: 403, oauthCode: 'signup_geo_blocked' },
    ORG_SIGNUPS_DISABLED: { status: 403, oauthCode: 'signup_org_disabled' },
    CONSUMER_SIGNUPS_DISABLED: { status: 403, oauthCode: 'signup_consumer_disabled' },
    ORG_REQUIRED: { status: 400, oauthCode: 'org_required' },
    ORG_NAME_TAKEN: { status: 400, oauthCode: 'org_name_taken' },
    ORG_DOMAIN_TAKEN: { status: 400, oauthCode: 'org_domain_taken' },
    ORG_REGISTRATION_INVALID: { status: 400, oauthCode: 'org_registration_invalid' },
    ORG_NOT_FOUND: { status: 400, oauthCode: 'org_not_found' },
    INVALID_INVITE: { status: 400, oauthCode: 'invalid_invite' },
    SEAT_CAP_EXCEEDED: { status: 403, oauthCode: 'seat_cap_exceeded' },
    DUPLICATE_ID: { status: 400, oauthCode: 'signup_failed' },
    CREATE_FAILED: { status: 400, oauthCode: 'signup_failed' },
});

class SignupError extends Error {
    /**
     * @param {string} code    key of SIGNUP_ERRORS
     * @param {string} message user-facing text; becomes the `error` field verbatim
     * @param {object} [opts]  { status } overrides the table status (validateConsent
     *                         picks its own); { body } adds fields to the JSON response
     */
    constructor(code, message, { status, body } = {}) {
        super(message);
        this.name = 'SignupError';
        const spec = SIGNUP_ERRORS[code] || SIGNUP_ERRORS.CREATE_FAILED;
        this.code = code;
        this.status = status || spec.status;
        this.oauthCode = spec.oauthCode;
        this.body = body || {};
    }

    /** The JSON body the password route sends — matches the pre-refactor shape exactly. */
    toResponse() {
        return { error: this.message, ...this.body };
    }
}

// ───────────────────────────────────────────────────────────────
// Phase 1 — normalize
// ───────────────────────────────────────────────────────────────

/**
 * Collapse a request body (password signup) or a stashed pendingSignup (OAuth)
 * into one shape. Account-type precedence is reproduced exactly as it was:
 * a new org name wins, then an explicit org or an invite, then consumer in
 * cloud mode, and self-hosted with none of the above is an error.
 *
 * An invite is an orthogonal flag rather than a fourth account type: it is
 * always a join_existing that bypasses the gates and forces 'active'. Folding
 * it into the enum would duplicate the join logic.
 *
 * @returns {{accountType:'organization'|'join_existing'|'consumer', [key: string]: any}}
 */
function normalizeSignupIntent(source = {}, { inviteData = null, inviteToken = null, provider = null, channel = 'password' } = {}) {
    const newOrgName = source.newOrgName || null;
    const organizationId = inviteData ? inviteData.organization_id : (source.organizationId || null);

    /** @type {'organization'|'join_existing'|'consumer'} */
    let accountType;
    if (newOrgName) accountType = 'organization';
    else if (organizationId || inviteData) accountType = 'join_existing';
    else if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud') accountType = 'consumer';
    else throw new SignupError('ORG_REQUIRED', 'Organization is required');

    return {
        accountType,
        channel,
        provider,
        invite: inviteData ? { token: inviteToken, data: inviteData } : null,
        newOrgName,
        organizationId,
        orgDetails: source.orgDetails || {},
        privacyShield: source.privacyShield,
        authMethod: source.authMethod || provider || null,
        email: source.email || null,
        locale: source.locale || null,
        selectedPlanId: source.selectedPlanId || null,
    };
}

// ───────────────────────────────────────────────────────────────
// Phase 2 — placement (the only org/consumer divergence)
// ───────────────────────────────────────────────────────────────

/** Guards that apply to every signup regardless of account type. */
async function assertSignupAllowed(intent, req) {
    if (process.env.ALLOW_SIGNUPS === 'false') {
        throw new SignupError('SIGNUPS_DISABLED', 'Account creation is disabled on this server.');
    }
    // Invited users bypass connector-only and geo: an invite is an explicit,
    // trusted admin action, consistent with how it already skips the
    // org/consumer/waitlist gates below.
    if (!intent.invite) {
        const gate = await checkWebSignupAllowed(req);
        if (!gate.ok) {
            throw new SignupError(gate.code === 'CONNECTOR_ONLY' ? 'CONNECTOR_ONLY' : 'GEO_BLOCKED',
                gate.error, { status: gate.status, body: { code: gate.code } });
        }
    }
}

/**
 * The longest org id this server will mint.
 *
 * Not arbitrary: an org id is concatenated into Postgres identifiers, config
 * keys and cache keys all over the codebase, and Postgres truncates every
 * identifier to 63 bytes — quoted or not. Two organisations whose ids share a
 * long prefix then collapse onto ONE name and read each other's data. The
 * datatable schema name is hashed so it can never depend on this; 48 characters
 * leaves 15 bytes of headroom for every other prefix or suffix.
 */
const MAX_ORG_ID_LENGTH = 48;

/**
 * Turn an organisation name into its id. The slug rule is verbatim — existing
 * org ids depend on it — with the length cap added on top.
 *
 * The suffix on a truncated id is DERIVED FROM THE WHOLE SLUG, so it is stable
 * (signing up twice with the same long name still collides, which is what
 * ORG_NAME_TAKEN is for) and two names sharing a 41-character prefix do not
 * silently become one organisation.
 */
function slugifyOrgId(name) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    if (slug.length <= MAX_ORG_ID_LENGTH) return slug;
    const suffix = String(
        parseInt(crypto.createHash('sha256').update(slug).digest('hex').slice(0, 8), 16) % 1_000_000,
    ).padStart(6, '0');
    const head = slug.slice(0, MAX_ORG_ID_LENGTH - 7).replace(/-+$/, '');
    return `${head}-${suffix}`;
}

/**
 * Refuse a second organisation on an email domain someone already owns.
 * Free/public providers are skipped: a gmail.com contact address is not ownable,
 * so without this the first org with a gmail contact would silently block every
 * later gmail-based org signup.
 *
 * ── M-04: this refusal used to be an organisation-existence oracle ──
 * It answered anonymous callers with
 *   "An organization with the domain "example.com" already exists.
 *    Please join the existing organization instead."
 * so anyone could probe arbitrary company domains and learn which ones are Bee
 * Flow customers — unauthenticated, and (before the signup rate limit) at any
 * speed they liked. On a privacy-first product sold to companies, the customer
 * list is exactly the thing not to publish.
 *
 * The message is now generic and never echoes the domain or confirms that
 * anything exists. Where the platform can send mail, the caller is not told at
 * all: the address gets an e-mail explaining that their organisation is already
 * registered and how to get an invite, and the HTTP response is the ordinary
 * "check your inbox" one. That is the only shape that closes the oracle
 * completely — the person who actually owns the address learns the truth, the
 * anonymous prober learns nothing — and it is why this throws a distinguishable
 * error code rather than a plain refusal: the signup routes translate
 * ORG_DOMAIN_TAKEN into that silent-success response.
 */
async function assertDomainAvailable(orgEmail) {
    if (!orgEmail || !orgEmail.includes('@')) return;
    const domain = orgEmail.split('@')[1].toLowerCase();
    if (isFreeEmailDomain(domain, await getEffectiveFreeEmailDomains())) return;

    const existingOrgs = await userStore.getAllOrganizations();
    const taken = existingOrgs.find(o => {
        if (Array.isArray(o.allowedDomains) && o.allowedDomains.includes(domain)) return true;
        if (!o.email || !o.email.includes('@')) return false;
        return o.email.split('@')[1].toLowerCase() === domain;
    });
    if (taken) {
        const err = /** @type {SignupError & {existingOrganizationId?: string, existingOrganizationName?: string, domain?: string}} */ (new SignupError('ORG_DOMAIN_TAKEN',
            'We could not create an organisation with this e-mail address. If your organisation already uses Bee Flow, ask a colleague for an invitation.'));
        // Carried on the error object, NOT in `body` — `body` is spread straight
        // into the HTTP response, which is the one place this must never appear.
        err.existingOrganizationId = taken.id;
        err.existingOrganizationName = taken.name || '';
        err.domain = domain;
        throw err;
    }
}

/**
 * The silent half of the M-04 fix.
 *
 * A generic error message stops the response from NAMING the domain, but the
 * mere fact that an error occurs still separates "this domain is a customer"
 * from "this domain is not". The only way to close that is to stop answering
 * the question: tell the mailbox owner — who is entitled to know — and give the
 * anonymous caller the same "check your inbox" response a normal signup gets.
 *
 * Returns true when the mail was dispatched and the caller should therefore
 * report the ordinary verification-pending response. Returns false when the
 * platform cannot send mail at all, in which case the caller falls back to the
 * generic (still domain-free) error — stranding a real user waiting for an
 * e-mail that can never arrive would be a worse outcome than the residual leak.
 *
 * @returns {Promise<boolean>}
 */
async function notifyOrganisationAlreadyExists({ email, displayName, error }) {
    if (!email || !String(email).includes('@')) return false;
    try {
        const { getServiceEmailConfig, sendServiceEmail } = require('../utils/emailService');
        const svc = await getServiceEmailConfig();
        if (!svc?.configured) return false;

        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
        const orgName = error?.existingOrganizationName || 'your organisation';
        const name = displayName || 'there';
        const subject = 'Your organisation is already on Bee Flow';
        const text = [
            `Hi ${name},`,
            '',
            `Someone (probably you) just tried to create a new Bee Flow organisation using your e-mail address. We could not do that, because ${orgName} is already registered with us.`,
            '',
            'To get access, ask an administrator at your organisation to send you an invitation — you will receive a link that takes you straight in.',
            '',
            `If this was not you, you can safely ignore this message. No account was created and nothing changed.`,
            '',
            clientHost,
        ].join('\n');
        await sendServiceEmail({ to: email, subject, text });
        log.info('[Signup] domain already registered — notified the address instead of answering the caller');
        return true;
    } catch (e) {
        log.warn('[Signup] could not send the organisation-exists notice:', e.message);
        return false;
    }
}

/**
 * Dutch Chamber of Commerce and VAT numbers, collected as "required" at signup
 * and — until now — never checked. The pentest submitted `12345678` and
 * `NL123456789B01` and both were accepted, so the fields were decoration.
 *
 * Format only. This does NOT prove the company exists (that needs the KvK API)
 * and is not pretending to; it raises the cost of automated tenant creation
 * from "type any digits" to "produce something structurally valid", and it
 * catches the honest typo, which is the more common case by far.
 *
 * Validated only when a value was supplied — the fields are optional outside the
 * Netherlands (see signupValidation.requiresDutchRegistration), and rejecting an
 * empty string would lock every non-Dutch company out of signup.
 */
function assertRegistrationNumbersValid({ kvk, vat }) {
    const k = String(kvk || '').replace(/\s/g, '');
    if (k) {
        // KvK numbers are exactly 8 digits.
        if (!/^\d{8}$/.test(k)) {
            throw new SignupError('ORG_REGISTRATION_INVALID', 'Please enter a valid Chamber of Commerce (KvK) number — 8 digits.');
        }
        // Structurally valid and never real: all-identical digits, or a straight
        // run. `12345678` is what the pentest submitted, and it was accepted.
        const identical = /^(\d)\1{7}$/.test(k);
        const ascending = [...k].every((d, i) => i === 0 || Number(d) === Number(k[i - 1]) + 1);
        const descending = [...k].every((d, i) => i === 0 || Number(d) === Number(k[i - 1]) - 1);
        if (identical || ascending || descending) {
            throw new SignupError('ORG_REGISTRATION_INVALID', 'Please enter a valid Chamber of Commerce (KvK) number.');
        }
    }

    const v = String(vat || '').replace(/[\s.\-]/g, '').toUpperCase();
    if (v) {
        // Dutch VAT: NL + 9 digits + B + 2 digits. Other EU member states use
        // their own layouts, so anything not starting with NL is only checked
        // for the shape every EU VAT number shares: two country letters plus
        // 2–13 alphanumerics.
        const ok = v.startsWith('NL')
            ? /^NL\d{9}B\d{2}$/.test(v)
            : /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(v);
        if (!ok) {
            throw new SignupError('ORG_REGISTRATION_INVALID', 'Please enter a valid VAT number (for example NL123456789B01).');
        }
    }
}

async function createOrgPlacement(intent) {
    // Invites are org-scoped and never create an org, so this gate can't lock one out.
    const orgSignupsEnabled = (await configStore.getConfig('signup_org_enabled')) ?? true;
    if (!orgSignupsEnabled) {
        throw new SignupError('ORG_SIGNUPS_DISABLED', 'Organization registration is currently disabled.');
    }

    const orgId = slugifyOrgId(intent.newOrgName);
    const od = intent.orgDetails || {};
    const orgEmail = od.email || intent.email || '';
    // Format-check the company registration BEFORE the domain lookup: it is
    // purely local, so a malformed KvK number should not cost a full table scan
    // of every organisation, and it must not be reachable as a side channel.
    assertRegistrationNumbersValid({ kvk: od.kvk, vat: od.vat });
    await assertDomainAvailable(orgEmail);

    // Markup is stripped here, not just on the admin edit route: this is the
    // ANONYMOUS path. Everything below arrives from a public signup body, and a
    // pentest's `<img src=x onerror=...>` in a tagline reached the column
    // verbatim. It never executed in the SPA — React escapes — but the same
    // values are interpolated into HTML invitation and connection-code emails,
    // which nothing escapes for you.
    const orgText = sanitizePlainTextFields({
        name: intent.newOrgName,
        description: od.description || '', tagline: od.tagline || '',
        address: od.address || '', email: orgEmail,
        phone: od.phone || '', website: od.website || '',
        kvk: od.kvk || '', vat: od.vat || '',
    }, ['name', 'description', 'tagline', 'address', 'email', 'phone', 'website', 'kvk', 'vat'],
        { maxLen: 2000 });

    const created = await userStore.createOrganization({
        id: orgId, ...orgText,
        logo: '', footerText: '',
        defaultGroups: [], allowSignup: !!od.allowSignup,
        authMethod: od.authMethod || intent.provider || '',
        registrationSource: 'direct',
    }, { autoGrantTrial: false }); // granted once in finalizeAccount, for both account types

    if (!created) {
        throw new SignupError('ORG_NAME_TAKEN', 'An organization with this name already exists');
    }

    // The founder IS the org admin — no default group is created.
    return { organizationId: orgId, orgRole: 'org_admin', groups: [], status: 'active', orgCreated: true };
}

async function joinOrgPlacement(intent) {
    const orgs = await userStore.getAllOrganizations();
    const org = orgs.find(o => o.id === intent.organizationId);
    if (!org) throw new SignupError('ORG_NOT_FOUND', 'Organization not found');

    const invited = !!intent.invite;
    // Invited users are auto-approved; self-signup depends on the org's allowSignup.
    return {
        organizationId: org.id,
        orgRole: intent.invite?.data?.role || intent.invite?.data?.org_role || '',
        groups: (invited || org.allowSignup) ? (org.defaultGroups || []) : [],
        status: (invited || org.allowSignup) ? 'active' : 'pending',
        orgCreated: false,
    };
}

/** @type {(intent?: object) => Promise<any>} every placement is handed the intent; this one needs none of it */
async function consumerPlacement() {
    const consumerSignupsEnabled = (await configStore.getConfig('signup_consumer_enabled')) ?? false;
    if (!consumerSignupsEnabled) {
        throw new SignupError('CONSUMER_SIGNUPS_DISABLED', 'Consumer account registration is currently disabled.');
    }
    // A consumer account IS an account with no organisation — that null is the
    // only discriminator there has ever been. There is no is_consumer column.
    return { organizationId: null, orgRole: '', groups: [], status: 'active', orgCreated: false };
}

/**
 * Layer the status policies that apply to every account type: the waitlist and
 * the email-verification gate. Both only ever downgrade an otherwise-'active'
 * account, so a pending org member is unaffected.
 */
async function applyStatusPolicy(placement, intent) {
    let status = placement.status;
    let needsVerification = false;

    // Invited users and new-org founders bypass the waitlist: an invite is its own
    // approval, and the founder of a new organisation IS its admin, so there is no
    // one else to approve them.
    if (status === 'active' && !intent.invite && intent.accountType !== 'organization') {
        const waitlistOn = (await configStore.getConfig('signup_waitlist_enabled')) ?? false;
        if (waitlistOn) status = 'waitlist';
    }

    // Fail-open by design: no email, an invited user, the toggle off, or service
    // email unconfigured all skip verification so no one is ever locked out.
    // SSO accounts skip it too — the identity provider already proved the address.
    if (status === 'active' && intent.email && !intent.invite && intent.channel !== 'oauth') {
        const verifyOn = (await configStore.getConfig('signup_email_verification_enabled')) ?? false;
        if (verifyOn) {
            try {
                const { getServiceEmailConfig } = require('../utils/emailService');
                const svc = await getServiceEmailConfig();
                if (svc.configured) {
                    needsVerification = true;
                    status = 'unverified';
                } else {
                    // Deliberately fail-open: on a self-hosted install with no
                    // outbound mail, failing closed would make signup impossible
                    // and lock the operator out of their own instance. But this
                    // is a security control silently doing nothing, so it is
                    // logged at error level — the operator turned the toggle on
                    // and is entitled to believe it took effect. GET
                    // /auth/admin/signup-settings reports the same state via
                    // emailVerificationEffective so the admin UI can warn.
                    log.error('[Signup] SECURITY: email verification is ENABLED but no service email is configured — accounts are being created WITHOUT address verification. Configure service email, or turn the toggle off to stop advertising a control that is not running.');
                }
            } catch (e) {
                log.error('[Signup] SECURITY: verification gate check failed — account created WITHOUT address verification:', e.message);
            }
        }
    }

    return { ...placement, status, needsVerification };
}

/**
 * Decide where the account lands, before any user row exists.
 * @returns {Promise<{organizationId, orgRole, groups, status, needsVerification, orgCreated}>}
 * @throws {SignupError}
 */
async function prepareAccountPlacement(intent, { req }) {
    await assertSignupAllowed(intent, req);

    let placement;
    switch (intent.accountType) {                                    // ◀── the only divergence
        case 'organization': placement = await createOrgPlacement(intent); break;
        case 'join_existing': placement = await joinOrgPlacement(intent); break;
        case 'consumer': placement = await consumerPlacement(intent); break;
        default: throw new SignupError('ORG_REQUIRED', 'Organization is required');
    }
    return applyStatusPolicy(placement, intent);
}

// ───────────────────────────────────────────────────────────────
// Phase 3 — finalize (branch-free)
// ───────────────────────────────────────────────────────────────

/** Org founders get an org-scoped shield; everyone else a personal one. */
function shieldKey(placement, userId) {
    return placement.orgCreated
        ? `org_privacy_shield_${placement.organizationId}`
        : `user_privacy_shield_${userId}`;
}

/** Trials attach to the org for founders and to the user for consumers. */
function trialTarget(placement, userId) {
    return placement.orgCreated
        ? { organizationId: placement.organizationId }
        : (placement.organizationId ? null : { userId });
}

async function writePrivacyShield(intent, placement, userId) {
    try {
        if (placement.orgCreated) {
            const { buildSignupShieldConfig } = require('../core/privacy/signupShield');
            const shield = buildSignupShieldConfig(intent.orgDetails || {});
            if (!shield) return; // null = shield deliberately off
            await configStore.setConfig(shieldKey(placement, userId), shield);
            log.info(`[Signup] Privacy shield for org ${placement.organizationId}: ${shield.piiDetectionCategories.length} PII categories, action=${shield.piiDetectionAction}`);
        } else if (!placement.organizationId) {
            // Consumer accounts used to be created without a shield and started
            // unprotected (BFSF-289).
            const { buildUserShieldConfig } = require('../core/privacy/userShieldDefaults');
            const shield = buildUserShieldConfig(intent.privacyShield, {
                updatedBy: intent.channel === 'oauth' ? 'system-signup-oauth' : 'system-signup',
            });
            await configStore.setConfig(shieldKey(placement, userId), shield);
            log.info(`[Signup] Personal Privacy Shield for ${userId}: enabled=${shield.enabled}, action=${shield.piiDetectionAction}`);
        }
        // Members joining an existing org inherit that org's shield.
    } catch (e) {
        log.warn('[Signup] failed to write privacy shield:', e.message);
    }
}

async function issueVerificationToken({ userId, displayName, email, organizationId, locale }) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await userStore.updateUser(userId, {
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: expires,
    });
    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    const orgName = organizationId ? (await userStore.getOrganization(organizationId))?.name : '';
    const audit = async (action, details) => {
        try {
            await userStore.logAccessAudit(action, 'user', userId, userId, null, { email, ...details }, organizationId || null);
        } catch (_) { /* best-effort */ }
    };
    const failed = (reason) => {
        const error = String(reason || 'unknown error').slice(0, 200);
        log.warn('[Signup] verification email failed:', error);
        return audit('user.email_verification_failed', { error });
    };
    // The audit records the outcome, not the attempt: sendServiceEmail resolves
    // { success: false } instead of throwing when the mail does not go out, so
    // "sent" is written only once the send reports success. Still not awaited:
    // a slow mail provider must not hold up the signup response.
    const { sendVerificationEmail } = require('../utils/emailService');
    sendVerificationEmail({ email, displayName, verifyUrl: `${clientHost}/auth/verify-email/${token}`, orgName, locale })
        .then(
            (result) => (result?.success ? audit('user.email_verification_sent', {}) : failed(result?.error)),
            (e) => failed(e?.message),
        );
}

async function markInviteAccepted(intent, placement, userId) {
    const invite = intent.invite;
    if (!invite) return;
    try {
        const invitationStore = require('../stores/invitationStore');
        await invitationStore.markAccepted(invite.token);
        log.info(`[Signup] Invitation accepted for ${intent.email} → org ${placement.organizationId}`);
        try {
            await userStore.logAccessAudit('invitation.redeem', 'user', userId, userId, null, {
                invitation_id: invite.data.id,
                email: invite.data.email,
                invited_by: invite.data.invited_by,
                orgRole: invite.data.org_role || invite.data.orgRole,
                groups: invite.data.groups,
            }, invite.data.organization_id || placement.organizationId || null);
        } catch (auditErr) {
            log.warn('[Signup] invitation.redeem audit failed:', auditErr.message);
        }
    } catch (e) {
        log.error('[Signup] Failed to mark invitation as accepted:', e.message);
    }
}

// Deliberately no onboarding-state seed here. OnboardingTour.jsx already owns
// its own completion state via POST /ai/user-settings; a second record written
// at signup would have no reader, and write-only data is how the `isConsumer`
// field this refactor removed came to exist in the first place.

function sendWelcomeEmailLater({ email, displayName, userId, organizationId, locale }) {
    if (!email) return;
    // claimNotification makes this idempotent, so refreshes and retries can
    // never double-send.
    Promise.resolve().then(async () => {
        try {
            const claimed = await userStore.claimNotification('user', userId, 'welcome_email', email);
            if (!claimed) return;
            const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
            const orgName = organizationId ? (await userStore.getOrganization(organizationId))?.name : '';
            const { sendWelcomeEmail } = require('../utils/emailService');
            await sendWelcomeEmail({ email, displayName, loginUrl: clientHost, orgName, locale });
        } catch (e) { log.warn('[Signup] welcome email failed:', e.message); }
    });
}

/**
 * Everything that happens once the user row exists. Identical for both account
 * types; the org/consumer difference is confined to shieldKey and trialTarget.
 * Every step is best-effort — a failed welcome email must never fail a signup.
 *
 * @returns {Promise<{preferredLocale:string, needsVerification:boolean}>}
 */
async function finalizeAccount({ userId, email, displayName, intent, placement, req }) {
    await writePrivacyShield(intent, placement, userId);

    const preferredLocale = await resolveSignupLocale(req, intent.locale);
    try { await userStore.updateUser(userId, { preferredLocale }); }
    catch (e) { log.warn('[Signup] failed to persist preferred locale:', e.message); }

    if (placement.needsVerification) {
        try {
            await issueVerificationToken({ userId, displayName, email, organizationId: placement.organizationId, locale: preferredLocale });
        } catch (e) { log.error('[Signup] failed to issue verification token:', e.message); }
    }

    await markInviteAccepted(intent, placement, userId);

    // One trial grant, at one layer, for both account types. trialService
    // swallows its own errors so Stripe trouble never blocks a signup.
    const target = trialTarget(placement, userId);
    if (target) {
        setImmediate(() => {
            const trialService = require('../services/trialService');
            if (target.organizationId) trialService.maybeAutoGrantOrgTrial(target.organizationId);
            else trialService.maybeAutoGrantConsumerTrial(target.userId);
        });
    }

    // Only accounts that are usable on creation get a welcome. Accounts pending
    // verification get theirs at verify time; waitlisted and pending-approval
    // accounts must not be told "you're in" before an admin has let them in.
    if (!placement.needsVerification && placement.status === 'active') {
        sendWelcomeEmailLater({ email, displayName, userId, organizationId: placement.organizationId, locale: preferredLocale });
    }

    // Remember a plan chosen during signup so the SPA can send the user straight
    // to checkout after the first login. Free plans need no checkout.
    if (intent.selectedPlanId && req?.session) {
        req.session.pendingCheckoutPlanId = intent.selectedPlanId;
    }

    return { preferredLocale, needsVerification: placement.needsVerification };
}

/**
 * Translate a createUserWithSeatCheck result into the historical HTTP errors.
 * Shared so both routes report a taken username and a full seat cap identically.
 */
function assertUserCreated(result) {
    if (result?.created) return result.created;
    if (result?.reason === 'duplicate_id') throw new SignupError('DUPLICATE_ID', 'Username already taken');
    throw new SignupError('CREATE_FAILED', result?.error || 'Failed to create user');
}

/** A consumer account is one with no organisation. There is no is_consumer column. */
function isConsumerAccount(userRow, { noOrganization = false } = {}) {
    const orgId = userRow?.organizationId || userRow?.organization_id || '';
    return !orgId && !noOrganization && (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud';
}

module.exports = {
    SignupError,
    SIGNUP_ERRORS,
    normalizeSignupIntent,
    prepareAccountPlacement,
    finalizeAccount,
    assertUserCreated,
    isConsumerAccount,
    slugifyOrgId,
    MAX_ORG_ID_LENGTH,
    notifyOrganisationAlreadyExists,
    // exported for tests
    assertDomainAvailable,
    assertRegistrationNumbersValid,
    applyStatusPolicy,
};
