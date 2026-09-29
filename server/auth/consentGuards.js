// @typecheck
/**
 * Consent Guards
 *
 * The server-side trust boundary for the consents the product still records.
 * The clickwrap legal-document set was retired, so there is no signup consent
 * gate and no re-consent check; what remains are the standalone consents:
 *
 *   validateWaiver   — gate: is the checkout right-of-withdrawal waiver present?
 *   recordWaiver     — record a consumer right-of-withdrawal waiver at checkout.
 *   auditClientIp    — originating client IP for the consent evidence ledger.
 *
 * The append-only `consent_acceptances` ledger they write to is also used by the
 * optional consents (marketing, and the GDPR Art. 9(2)(a) biometric consent that
 * voiceprint enrolment requires) — see legal/documentRegistry.js.
 */

const documentRegistry = require('../legal/documentRegistry');
const { clientIp } = require('./signupGuards');
const userStore = require('../stores/userStore');

/**
 * Best-effort ORIGINATING client IP for the consent evidence ledger.
 *
 * Unlike `clientIp` (which uses express `req.ip` — pinned by `trust proxy` so it
 * can't be spoofed, the right choice for geo-blocking), the legal ledger wants
 * the actual visitor's address, not the last internal proxy hop. Behind the
 * cluster ingress + the agent-hub nginx, `req.ip` lands on an internal pod
 * address (e.g. 172.16.x.x). The leftmost X-Forwarded-For entry is the client as
 * first seen at the edge, so we prefer it here and fall back to req.ip.
 */
function auditClientIp(req) {
    const fwd = req?.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) {
        const left = fwd.split(',')[0].trim();
        if (left) return left.replace(/^::ffff:/, '');
    }
    return clientIp(req);
}

/**
 * Whether the consent ledger is active at all.
 *
 * Recorded consent is a Bee Flow Cloud concept only. On a self-hosted install
 * the customer relationship is governed by their licence agreement, so the
 * ledger is disabled and these guards become no-ops.
 *
 * Sourced from DEPLOYMENT_MODE (default 'cloud'). Only two modes exist: 'cloud'
 * and 'self-hosted'; the legacy 'private-cloud' value is treated as self-hosted,
 * mirroring license/index.js → deploymentMode().
 */
function consentEnabled() {
    return (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud';
}

/**
 * Validate the consumer right-of-withdrawal waiver submitted at paid checkout.
 * @param {object} waiver - { accepted: boolean }
 */
function validateWaiver(waiver) {
    if (!waiver || waiver.accepted !== true) {
        return {
            ok: false,
            status: 400,
            error: 'To start a paid plan immediately you must confirm the waiver of your right of withdrawal.',
            code: 'WAIVER_REQUIRED',
        };
    }
    return { ok: true, waiver: documentRegistry.getWithdrawalWaiver() };
}

/**
 * Record a consumer withdrawal-waiver acceptance at checkout.
 * @param {object} args - { userId, email, req, organizationId? }
 */
async function recordWaiver({ userId, email, req, organizationId = null }) {
    const w = documentRegistry.getWithdrawalWaiver();
    await userStore.recordConsentAcceptance({
        userId,
        email,
        accountType: 'consumer',
        docId: w.docId,
        docVersion: w.version,
        docSha256: null,
        method: 'checkout_waiver',
        route: req?.originalUrl || null,
        ip: req ? auditClientIp(req) : null,
        userAgent: req?.headers?.['user-agent'] || null,
        organizationId,
    });
}

module.exports = {
    consentEnabled,
    validateWaiver,
    recordWaiver,
    auditClientIp,
};
