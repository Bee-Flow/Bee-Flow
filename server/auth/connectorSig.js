// @typecheck
/**
 * Tenant-key HMAC verification for machine-to-machine calls FROM the Nextcloud
 * connector — no user session is involved; the caller identifies the org by
 * its NC instance id and proves possession of that org's tenant key.
 *
 * Scheme (must stay byte-identical to the connector's signing side, e.g.
 * nextcloud-connector/src/taskProcessing.js executeViaSaaS and
 * studioAppMenus.js):
 *
 *   X-Beeflow-NC-Instance-Id: <instance id bound at bootstrap>
 *   X-Beeflow-Sig: <unixSeconds>.<hex hmac-sha256>
 *   message = `${ts}\n${METHOD}\n${originalUrl}\n${rawBody}`
 *
 * `originalUrl` is the full mounted path (+ query string) as Express saw it;
 * GET requests sign an empty body. 5-minute clock-skew tolerance, constant-
 * time comparison. Returns the org row on success, null on any failure —
 * callers answer 401 without detailing which check failed.
 *
 * Shared by routes/nextcloudTaskProcessing.js and routes/nextcloudStudioApps.js.
 */

const crypto = require('crypto');
// configStore and userStore are required lazily inside the function, not here:
// importing configStore stands up the Postgres pool at module load, which makes
// dependants un-requireable in infra-free unit tests.

async function verifyConnectorSig(req) {
    const configStore = require('../stores/configStore');
    const instanceId = String(req.headers['x-beeflow-nc-instance-id'] || '');
    if (!instanceId) return null;
    const userStore = require('../stores/userStore');
    const org = await userStore.getOrganizationByNcInstanceId(instanceId).catch(() => null);
    if (!org) return null;
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${org.id}`);
    if (!tenantKey) return null;

    const sigHeader = String(req.headers['x-beeflow-sig'] || '');
    const dot = sigHeader.indexOf('.');
    if (dot === -1) return null;
    const ts = parseInt(sigHeader.slice(0, dot), 10);
    const sig = sigHeader.slice(dot + 1);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return null;

    const message = `${ts}\n${req.method}\n${req.originalUrl}\n${req.rawBody || ''}`;
    const expected = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
    if (expected.length !== sig.length) return null;
    try {
        if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return null;
    } catch { return null; }
    return org;
}

module.exports = { verifyConnectorSig };
