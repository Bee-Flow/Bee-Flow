// @typecheck strict
/**
 * Nextcloud Connector bootstrap, returning bind: what ties a bootstrap for an
 * instance id that is already bound to the Nextcloud the org is bound to.
 *
 * The capabilities round-trip (ncVerify.js) shows that the Nextcloud at the
 * caller's base URL reports this instance id; WHICH Nextcloud that is, is
 * what the binding records. Two proofs:
 *   'base_url'   the caller's base URL is the one recorded at bind time (the
 *                normal re-bootstrap: a restart that lost the key cache, or a
 *                reinstall on the same address);
 *   'tenant_key' the request is signed with the org's current tenant key
 *                (X-Beeflow-Sig, the scheme every other connector call uses),
 *                for a connector that still holds the key and moved address.
 * Neither: the Nextcloud re-pairs with a pairing code (bootstrap branch 0),
 * which is also what a changed address needs.
 */

const log = require('../../telemetry/log');
const { orgHealth } = require('./serviceDeps');
const { fallback } = require('../../utils/bestEffort');

// connectorSig is required lazily (through DEFAULT_DEPS): it stands up the
// stores on first use, which infra-free unit tests must not do. Tests swap it
// through _setDepsForTests.
const DEFAULT_DEPS = {
    verifyConnectorSig: (/** @type {import('express').Request} */ req) => require('../connectorSig').verifyConnectorSig(req),
};
let _deps = { ...DEFAULT_DEPS };

/**
 * The comparable form of a Nextcloud base URL: scheme, lower-cased host,
 * port, path without a trailing slash. Null for anything that is not an
 * http(s) URL.
 * @param {string | null | undefined} url
 */
function normaliseNcBaseUrl(url) {
    let parsed;
    try {
        parsed = new URL(String(url || '').trim());
    } catch (_) {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const port = parsed.port ? `:${parsed.port}` : '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}`;
}

/**
 * @param {{ req: import('express').Request, ncBaseUrl: string }} ctx
 * @param {{ id: string, nc_base_url?: string | null }} org
 * @returns {Promise<'base_url' | 'tenant_key' | null>}
 */
async function provesExistingBinding(ctx, org) {
    const bound = normaliseNcBaseUrl(org.nc_base_url);
    if (bound && bound === normaliseNcBaseUrl(ctx.ncBaseUrl)) return 'base_url';
    const signedFor = await _deps.verifyConnectorSig(ctx.req).catch((err) => fallback('rebindProof:connector-sig', err, null));
    if (signedFor && signedFor.id === org.id) return 'tenant_key';
    return null;
}

/**
 * Answer a returning bootstrap that proved nothing: 403, with the org-health
 * problem that tells the operator which Nextcloud address knocked.
 * @param {{ req: import('express').Request, res: import('express').Response, ncInstanceId: string, ncBaseUrl: string }} ctx
 * @param {{ id: string }} org
 */
function refuseRebind(ctx, org) {
    const { req, res, ncInstanceId, ncBaseUrl } = ctx;
    log.warn(`[ConnectorBootstrap] rebind_proof_required org=${org.id} ncInstance=${ncInstanceId} ncBaseUrl=${ncBaseUrl}`);
    orgHealth.problem('bootstrap.rebind_proof_required', {
        orgId: org.id, source: 'connectorBootstrap', req,
        meta: { ncInstanceId, ncBaseUrl, reason: 'base_url_differs_from_binding' },
    });
    return res.status(403).json({
        error: 'This Nextcloud instance is already bound to a Bee Flow organisation from a different address.',
        code: 'NC_REBIND_PROOF_REQUIRED',
        remediation: 'The Nextcloud bound to this organisation lives at another address than the one this connector sent. If your Nextcloud moved, ask a Bee Flow organisation admin to generate a pairing code (Settings → Organisation → Pair a new Nextcloud), set it as the BEEFLOW_PAIRING_CODE env var on this connector, and redeploy. Otherwise check BEEFLOW_NC_PUBLIC_URL on the connector.',
    });
}

/**
 * Test seam: replace the lazily required signature verifier; no argument
 * restores the real one.
 * @param {Partial<typeof DEFAULT_DEPS> | null} [over]
 */
function _setDepsForTests(over = null) {
    _deps = { ...DEFAULT_DEPS, ...(over || {}) };
}

module.exports = { normaliseNcBaseUrl, provesExistingBinding, refuseRebind, _setDepsForTests };
