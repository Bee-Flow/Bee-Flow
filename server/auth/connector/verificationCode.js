// @typecheck strict
/**
 * Nextcloud Connector: the emailed one-time code of the email-verification
 * branch (generation, masking the address it goes to, and the caps around it).
 * Split out of auth/connectorBootstrap.js, which re-exports what it exported.
 */

const crypto = require('crypto');

const PENDING_TTL_SECONDS = 1800;
const MAX_VERIFICATIONS_PER_ORG = 5;

// 6-digit numeric one-time code, zero-padded. crypto.randomInt is uniform.
function generateVerificationCode() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// Mask an email for display in the connector / SPA without leaking the full
// local-part: tomsmit@beeflow.nl → t•••t@beeflow.nl.
/** @param {string | null | undefined} email */
function maskEmail(email) {
    const [local = '', domain = ''] = String(email || '').split('@');
    if (!domain) return '***';
    const first = local.slice(0, 1) || '*';
    const last = local.length > 1 ? local.slice(-1) : '';
    return `${first}${'•'.repeat(3)}${last}@${domain}`;
}

module.exports = {
    PENDING_TTL_SECONDS,
    MAX_VERIFICATIONS_PER_ORG,
    generateVerificationCode,
    maskEmail,
};
