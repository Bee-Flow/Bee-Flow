/**
 * Package loader: the entitlement gates.
 *
 * The hub gate for paid modules (a signature-verified grant from the hub's
 * entitlement list), the offline `.bfgrant` stash for air-gapped installs,
 * and the sideload gate that tries, in order, the stashed offline grant, a
 * signed `license_class: 'free'`, and the hub when connected.
 */

'use strict';

const { deps, grantKeyResolver } = require('./packageState');
const { _safeSeg } = require('./packageStaging');

const { hubClient, moduleEntitlements, subjects, configStore } = deps;

// ── Entitlement gate (paid modules) ────────────────────────────────────────
function _subjectIds() {
    return subjects().subjectIds();
}

/**
 * Require a currently-valid, signature-verified grant for `moduleId`. Returns
 * the entitlement + verified payload so the caller can persist the timestamp
 * gate. Throws HubError('not_entitled') when no valid grant exists.
 */
async function _entitlementGate(moduleId, manifest, { now = Math.floor(Date.now() / 1000) } = {}) {
    const { HubError } = hubClient();
    let list;
    try { ({ entitlements: list } = await hubClient().fetchEntitlements()); }
    catch (e) { if (e && e.code) throw e; throw new HubError('hub_unavailable', e.message); }
    const ent = (list || []).find(e => e && e.module_id === moduleId);
    if (!ent || !ent.grant_token) throw new HubError('not_entitled', `no entitlement grant for ${moduleId}`);
    const subjectIds = await _subjectIds();
    const res = await moduleEntitlements().verifyModuleGrant(ent.grant_token, {
        moduleId,
        subjectIds: subjectIds.length ? subjectIds : undefined,
        now,
        publicKeyResolver: grantKeyResolver(),
    });
    if (!res.valid) throw new HubError('not_entitled', `grant invalid: ${res.error}`);
    return {
        entitlement: {
            kind: res.payload.kind || ent.kind || 'unknown',
            status: 'active',
            exp: res.payload.exp,
            entitlement_id: res.payload.entitlement_id || ent.entitlement_id || null,
            current_period_end: ent.current_period_end || null,
        },
        payload: res.payload,
    };
}

// ── Sideload + offline grants (M3.1 — air-gapped installs) ─────────────────
const OFFLINE_GRANT_CONFIG_PREFIX = 'beeflow_hub_offline_grant_';

function _offlineGrantKey(moduleId) { return `${OFFLINE_GRANT_CONFIG_PREFIX}${_safeSeg(moduleId)}`; }

/** Validate a parsed `.bfgrant` file's envelope (signature verified separately). */
function _validateGrantFile(g) {
    if (!g || typeof g !== 'object') return 'bad_grant_file';
    if (g.format !== 'beeflow-offline-grant') return 'bad_grant_format';
    if (Number(g.format_version) !== 1) return 'bad_grant_version';
    if (typeof g.module_id !== 'string' || !g.module_id) return 'bad_grant_module';
    if (typeof g.grant_token !== 'string' || !g.grant_token) return 'bad_grant_token';
    return null;
}

/**
 * Verify + stash an offline `.bfgrant` for a module. Works pre-install (the
 * grant waits in configStore) and post-402 (activate-staged picks it up).
 */
async function applyOfflineGrant(moduleId, grantFile) {
    const bad = _validateGrantFile(grantFile);
    if (bad) { const e = new Error(bad); e.code = bad; throw e; }
    if (grantFile.module_id !== moduleId) { const e = new Error('grant_module_mismatch'); e.code = 'grant_module_mismatch'; throw e; }
    const subjectIds = await _subjectIds();
    const res = await moduleEntitlements().verifyModuleGrant(grantFile.grant_token, {
        moduleId,
        subjectIds: subjectIds.length ? subjectIds : undefined,
        publicKeyResolver: grantKeyResolver(),
    });
    if (!res.valid) { const e = new Error(`grant_invalid: ${res.error}`); e.code = 'grant_invalid'; e.detail = res.error; throw e; }
    await configStore().setConfig(_offlineGrantKey(moduleId), {
        format: grantFile.format, format_version: 1, module_id: moduleId,
        subject: grantFile.subject || null, kind: grantFile.kind || res.payload.kind || 'admin_granted',
        grant_token: grantFile.grant_token, kid: grantFile.kid || null,
        expires_at: grantFile.expires_at || null, note: grantFile.note || null,
    });
    return {
        ok: true,
        entitlement: {
            kind: res.payload.kind || grantFile.kind || 'admin_granted',
            status: 'active',
            exp: res.payload.exp,
            entitlement_id: res.payload.entitlement_id || null,
            source: 'offline',
            grantToken: grantFile.grant_token,
        },
    };
}

/**
 * Entitlement gate for a sideloaded package, in order: (1) a stashed offline
 * .bfgrant, (2) `license_class:'free'` pinned in the package's SIGNED payload
 * (absent ⇒ paid), (3) the hub when connected. No match ⇒
 * offline_grant_required (→ 402); the package stays staged for a later
 * activate-staged once a grant arrives.
 */
async function _sideloadEntitlementGate(moduleId, manifest, signedPayload) {
    let stash = null;
    try { stash = await configStore().getConfig(_offlineGrantKey(moduleId)); } catch (_) {}
    if (stash && stash.grant_token) {
        const subjectIds = await _subjectIds();
        const res = await moduleEntitlements().verifyModuleGrant(stash.grant_token, {
            moduleId, subjectIds: subjectIds.length ? subjectIds : undefined,
            publicKeyResolver: grantKeyResolver(),
        });
        if (res.valid) {
            return {
                entitlement: {
                    kind: res.payload.kind || stash.kind || 'admin_granted', status: 'active',
                    exp: res.payload.exp, entitlement_id: res.payload.entitlement_id || null,
                    source: 'offline', grantToken: stash.grant_token,
                },
            };
        }
    }
    if (signedPayload && signedPayload.license_class === 'free') {
        return { entitlement: { kind: 'free', status: 'active', exp: null, entitlement_id: null, source: 'offline' } };
    }
    try {
        if (await hubClient().isConnected()) return await _entitlementGate(moduleId, manifest);
    } catch (_) { /* fall through to 402 */ }
    const e = new Error('offline_grant_required');
    e.code = 'offline_grant_required';
    throw e;
}

module.exports = {
    _entitlementGate,
    applyOfflineGrant,
    _sideloadEntitlementGate,
};
