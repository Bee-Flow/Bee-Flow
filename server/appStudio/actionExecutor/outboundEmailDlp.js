// @typecheck
const log = require('../../telemetry/log');

/**
 * Screen an outbound message against the org's privacy shield.
 *
 * Fail-OPEN by design: this is a hygiene layer over a user-authored reply, not
 * an authorization gate, and a scanner outage must not stop a support desk from
 * answering its customers. Blocking only happens when the org explicitly asked
 * for it AND the scan actually ran.
 */
async function screenOutboundEmail(app, { text, subject }) {
    try {
        const configStore = require('../../stores/configStore');
        const orgId = app.organizationId || null;
        if (!orgId) return { blocked: false, outcome: 'skipped_no_org' };

        const mode = await configStore.getConfig(`studio_app_email_dlp_${orgId}`).catch(() => null);
        // Default is scan-and-log. An org opts in to blocking deliberately.
        const shouldBlock = mode === 'block';

        const dlpRunner = require('../../core/dlp/dlpRunner');
        if (typeof dlpRunner.scan !== 'function') return { blocked: false, outcome: 'unavailable' };

        const shield = await require('../../core/privacy/orgShield').resolveOrgShield(orgId);
        // Mail leaves the platform whatever the org's LLM scope says, so scan it as 'all'.
        const result = await dlpRunner.scan(/** @type {any} */ ({
            messages: [{ role: 'user', content: `${subject}\n\n${text}` }],
            orgShieldConfig: { ...shield, dlpScope: 'all' },
        }));
        if (result?.scanStatus !== 'ok') return { blocked: false, outcome: result?.scanStatus === 'failed' ? 'scan_failed' : 'skipped' };
        const hits = result.findings?.length || 0;
        if (!hits) return { blocked: false, outcome: 'clean' };
        return { blocked: shouldBlock, outcome: shouldBlock ? 'blocked' : 'flagged' };
    } catch (e) {
        log.warn(`[ActionExecutor] outbound DLP scan failed for ${app.id}: ${e.message}`);
        return { blocked: false, outcome: 'scan_failed' };
    }
}

module.exports = { screenOutboundEmail };
