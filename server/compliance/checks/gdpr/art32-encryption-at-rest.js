/**
 * GDPR Art. 32 — Encryption at rest.
 *
 * Two things have to hold before message content is encrypted at rest:
 *   1. MASTER_ENCRYPTION_KEY and SESSION_SECRET are set (config-store secret
 *      encryption and the envelope-encryption key material), and
 *   2. the organisation's content-encryption tier actually encrypts the
 *      message bodies. The tier is per organisation (stores/encryptionPolicy)
 *      and defaults to 'none', which writes plaintext.
 *
 * The check used to pass on (1) alone and claim "messages stored encrypted at
 * rest" for every install on the default tier, whose messages are plaintext.
 */

const { resolvePolicy, shouldEncrypt, SURFACES } = require('../../../stores/encryptionPolicy');

/** The message-body surfaces this check speaks for. */
const MESSAGE_SURFACES = [SURFACES.MESSAGES, SURFACES.NOTEBOOK_MESSAGES];

module.exports = {
    id: 'GDPR-Art32-encryption-at-rest',
    regulation: 'GDPR',
    article: '32',
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(h)' }],
    severity: 'critical',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art32_ear.title',
    descriptionKey: 'compliance.checks.gdpr_art32_ear.desc',
    remediationKey: 'compliance.checks.gdpr_art32_ear.fix',
    remediationLink: null,
    async evaluate(orgId) {
        const hasMaster = !!process.env.MASTER_ENCRYPTION_KEY;
        const hasSession = !!process.env.SESSION_SECRET;
        const evidence = {
            MASTER_ENCRYPTION_KEY: hasMaster ? 'set' : 'missing',
            SESSION_SECRET: hasSession ? 'set' : 'missing',
            envelope_encryption: 'AES-256-GCM (messageEncryption)',
        };
        if (!hasMaster || !hasSession) {
            const missing = [!hasMaster && 'MASTER_ENCRYPTION_KEY', !hasSession && 'SESSION_SECRET'].filter(Boolean);
            return {
                status: 'fail',
                evidence,
                details: !hasMaster
                    ? `${missing.join(' and ')} not set — configuration secrets and message bodies are not encrypted.`
                    : 'SESSION_SECRET is not set — the encryption key material is incomplete, so message bodies are not encrypted.',
            };
        }

        const policy = await resolvePolicy(orgId && orgId !== 'default' ? orgId : null);
        const plaintext = MESSAGE_SURFACES.filter(s => !shouldEncrypt(policy, s));
        evidence.encryption_tier = policy.tier;
        evidence.messages_encrypted = !plaintext.includes(SURFACES.MESSAGES);
        evidence.plaintext_surfaces = plaintext;
        if (plaintext.length === 0) {
            return {
                status: 'pass',
                evidence,
                details: `Encryption keys are configured and this organisation writes message bodies encrypted (tier "${policy.tier}").`,
            };
        }
        return {
            status: 'warn',
            evidence,
            details: policy.enabled
                ? `Encryption keys are configured, but this organisation's encryption scope leaves ${plaintext.join(' and ')} in plaintext: new content there is stored unencrypted.`
                : 'Encryption keys are configured, but this organisation\'s content-encryption tier is "none": new message bodies are stored in plaintext. Choose the managed or zero-knowledge tier.',
        };
    },
};
