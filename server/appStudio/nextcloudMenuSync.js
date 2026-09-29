/**
 * nextcloudMenuSync.js — tell the org's Nextcloud connector "the app menu
 * changed, sync now".
 *
 * An owner who ticks "Show in the Nextcloud app menu" used to wait for the
 * connector's poll (every few minutes) before the icon existed, with nothing
 * telling them whether it had worked. This module closes that gap: it POSTs
 * the connector's `/hooks/studio-menus`, the connector reconciles against
 * AppAPI right then, and the answer says whether the OCS rows now exist —
 * which is the only honest basis for "reload Nextcloud to see it".
 *
 * Transport is the channel the SaaS already has into a paired connector:
 * `organizations.connector_callback_url` (Nextcloud's AppAPI proxy in front of
 * the connector) signed with the tenant-key HMAC from integrations/ncSigning.js
 * — the same headers `ncProxy.verifyHmac` checks for every `/nc/*` call. The
 * hook path sits under the ExApp manifest's existing PUBLIC `hooks/` route, so
 * a connector that has the handler needs no re-registration to receive it.
 *
 * What goes over the wire: ids only. The connector fetches the authoritative
 * list itself (routes/nextcloudStudioApps.js) — this call carries no app name,
 * no owner, nothing a customer's Nextcloud does not already get through that
 * list. The body exists so the connector's log can say why it synced.
 *
 * TRAP in that body: Nextcloud parses a JSON request body into the controller
 * parameters AFTER the URL parameters, and the AppAPI proxy route this call
 * goes through is `/proxy/{appId}/{other}`. A top-level `appId` (or `other`)
 * key therefore replaces `bee_flow` in the controller's own arguments — "no
 * such ExApp" 404 for a string, a 400 for null — before the connector ever
 * sees the request. Hence `studioAppId`, and never a key named like a route
 * parameter of Nextcloud's proxy.
 *
 * Failure is a first-class outcome, never an exception: the poll remains the
 * backstop, so the worst case of a lost push is the old latency, not a lost
 * publish. Two guards keep a bad day cheap:
 *   - per-org coalescing: one push in flight, at most one queued behind it,
 *     shared by every caller that arrives meanwhile;
 *   - cooldowns: a 401/403/429 is what an OLD connector answers (it has no
 *     handler and the AppAPI gate refuses the un-authed call) — and each such
 *     answer is billed as a bruteforce attempt against the SaaS's IP on the
 *     customer's Nextcloud. Ten minutes between retries keeps that harmless.
 *
 * Outcomes:
 *   synced        the connector reconciled and answered ok
 *   not_connected the org has no paired connector (no callback URL / key)
 *   unsupported   404 — a connector build without the hook
 *   unauthorized  401/403/429 — old connector, or a key/clock problem
 *   unreachable   network error, timeout, 5xx, or the connector said ok:false
 */

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { signedConnectorHeaders } = require('../integrations/ncSigning');
const log = require('../telemetry/log');

const HOOK_PATH = '/hooks/studio-menus';
// A reconcile is one SaaS GET plus a couple of OCS calls — well under a second
// when healthy. The owner is waiting on this, so the ceiling is short.
const PUSH_TIMEOUT_MS = 6_000;
const COOLDOWN_MS = Object.freeze({
    unauthorized: 10 * 60_000,
    unreachable: 30_000,
});

/** Per-org push state. Keyed by org id; entries are tiny and never expire. */
const _orgs = new Map();

function orgState(orgId) {
    let s = _orgs.get(orgId);
    if (!s) {
        s = { inflight: null, followUp: null, cooldownUntil: 0, cooldownOutcome: null };
        _orgs.set(orgId, s);
    }
    return s;
}

/**
 * Where and how to reach the org's connector, or null when the org has no
 * paired Nextcloud. Reads the raw column names: `getOrganization` spreads the
 * row without camelCase aliases for these (the camelCase forms are accepted
 * for callers that hand in an already-normalised org, e.g. tests).
 */
async function resolveTarget(orgId) {
    const org = await userStore.getOrganization(orgId);
    if (!org) return null;
    const callbackUrl = org.connector_callback_url || org.connectorCallbackUrl || null;
    const ncInstanceId = org.nc_instance_id || org.ncInstanceId || null;
    if (!callbackUrl || !ncInstanceId) return null;
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${orgId}`);
    if (!tenantKey) return null;
    return { callbackUrl: String(callbackUrl).replace(/\/+$/, ''), tenantKey };
}

function outcomeForStatus(status) {
    if (status === 404) return 'unsupported';
    if (status === 401 || status === 403 || status === 429) return 'unauthorized';
    return 'unreachable';
}

async function pushOnce(target, meta) {
    const body = JSON.stringify({
        reason: meta.reason || 'change',
        studioAppId: meta.appId || null,
        sentAt: new Date().toISOString(),
    });
    let res;
    try {
        res = await fetch(`${target.callbackUrl}${HOOK_PATH}`, {
            method: 'POST',
            headers: {
                ...signedConnectorHeaders({ tenantKey: target.tenantKey, method: 'POST', path: HOOK_PATH, ncUid: '', body }),
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
    } catch (err) {
        return { outcome: 'unreachable', detail: err.name === 'TimeoutError' ? 'timeout' : err.message };
    }
    if (!res.ok) return { outcome: outcomeForStatus(res.status), detail: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) {
        return { outcome: 'unreachable', detail: (data && data.error) || 'connector answered ok:false' };
    }
    return {
        outcome: 'synced',
        result: { added: data.added | 0, removed: data.removed | 0, updated: data.updated | 0 },
    };
}

async function runPush(orgId, meta) {
    const started = Date.now();
    const state = orgState(orgId);
    let out;
    try {
        const target = await resolveTarget(orgId);
        out = target ? await pushOnce(target, meta) : { outcome: 'not_connected' };
    } catch (err) {
        out = { outcome: 'unreachable', detail: err.message };
    }
    const ms = Date.now() - started;
    const cooldown = COOLDOWN_MS[out.outcome];
    if (cooldown) {
        state.cooldownUntil = Date.now() + cooldown;
        state.cooldownOutcome = out.outcome;
    } else {
        state.cooldownUntil = 0;
        state.cooldownOutcome = null;
    }
    const line = `[NextcloudMenuSync] org=${orgId} reason=${meta.reason || 'change'} outcome=${out.outcome}`
        + `${out.detail ? ` detail=${out.detail}` : ''}`
        + `${out.result ? ` +${out.result.added} -${out.result.removed} ~${out.result.updated}` : ''} (${ms}ms)`;
    if (out.outcome === 'synced' || out.outcome === 'not_connected') log.info(line);
    else log.warn(line);
    return { ...out, ms };
}

/**
 * Ask the org's connector to sync now and wait for the verdict.
 * Never throws. Concurrent callers for one org share at most one follow-up
 * push behind the one in flight — the follow-up sees every change saved
 * before it started, so nobody's toggle is answered with a stale reconcile.
 */
function requestMenuSync(orgId, meta = {}) {
    if (!orgId) return Promise.resolve({ outcome: 'not_connected', ms: 0 });
    const state = orgState(orgId);
    if (state.cooldownUntil > Date.now()) {
        return Promise.resolve({ outcome: state.cooldownOutcome, detail: 'cooldown', ms: 0 });
    }
    if (!state.inflight) {
        state.inflight = runPush(orgId, meta).finally(() => { state.inflight = null; });
        return state.inflight;
    }
    if (!state.followUp) {
        state.followUp = state.inflight.catch(() => {}).then(() => {
            state.followUp = null;
            return requestMenuSync(orgId, meta);
        });
    }
    return state.followUp;
}

/**
 * Fire-and-forget form for the routes where nobody is waiting on the answer
 * (publish, rename, delete). The outcome still lands in the log.
 */
function notifyMenuChange(orgId, meta = {}) {
    requestMenuSync(orgId, meta).catch(() => { /* requestMenuSync never rejects */ });
}

function _resetForTests() {
    _orgs.clear();
}

module.exports = { requestMenuSync, notifyMenuChange, HOOK_PATH, PUSH_TIMEOUT_MS, COOLDOWN_MS, _resetForTests };
