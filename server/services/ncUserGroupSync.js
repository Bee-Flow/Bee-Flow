/**
 * Mirror Nextcloud users + groups into Bee Flow.
 *
 * Two trigger paths share the same apply* helpers:
 *
 *   1. Webhook (real-time) — server/routes/webhooks/ncEvents.js. The Bee
 *      Flow ExApp connector subscribes to OCP\User and OCP\Group events
 *      via NC's AppAPI events_listener and forwards each fire here.
 *
 *   2. Periodic backstop — server/jobs/ncSyncBackstop.js. Catches gaps
 *      from missed webhooks (NC restart, event listener drift) by doing
 *      a full diff every 6 hours.
 *
 * Sync mode per org (organizations.nc_sync_mode):
 *   - 'mirror_all'        Every NC user gets a Bee Flow account on creation.
 *                         Default for newly bootstrapped orgs.
 *   - 'selective_groups'  Only users in nc_sync_groups[] are mirrored.
 *   - 'manual'            No auto-sync. Org-admin invites users one by one.
 *
 * Excluded groups (nc_sync_excluded_groups[]) opt members out of mirroring
 * regardless of mode. New-user default status (nc_new_user_default_status)
 * controls whether mirrored users land 'active' or 'pending' for admin
 * approval — set to 'pending' for high-trust enterprise orgs.
 */

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { signedConnectorHeaders } = require('../integrations/ncSigning');
const orgHealth = require('./orgHealth');
const log = require('../telemetry/log');

// Org-health code for "the full sync could not read the NC user list". Open
// while the connection is broken; the backstop backs off on it
// (jobs/ncSyncBackstop.js) and a successful sync, manual or scheduled,
// resolves it.
const NC_SYNC_FAILED = 'connector.nc_sync_failed';

function slugifyId(s) {
    return String(s || '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40) || 'user';
}

// Service-level call to the connector's NC reverse proxy. Used to fetch
// NC user / group metadata when mirroring. Mirrors the HMAC scheme in
// nextcloudClient.resolveConnectorAuth.
async function ncProxyFetch(org, ncPath, ncUid = '') {
    const callbackUrl = org?.connector_callback_url;
    if (!callbackUrl) throw new Error(`Org ${org?.id} has no connector_callback_url`);
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${org.id}`);
    if (!tenantKey) throw new Error(`Org ${org.id} has no tenant key`);
    // The uid here becomes AppAPI impersonation at the connector: whoever it
    // names, Nextcloud answers as. Every caller in this module is
    // service-level (no user input reaches it), but an allow-list makes that
    // a property of the code rather than of the current call sites — a future
    // caller cannot turn a mirrored NC username into "read anyone's data".
    const allowedUid = _assertImpersonatable(org, ncUid);
    const path = ncPath.startsWith('/') ? `/nc${ncPath}` : `/nc/${ncPath}`;
    const url = `${callbackUrl.replace(/\/+$/, '')}${path}`;
    const res = await fetch(url, {
        headers: {
            // v2 (body-bound) signing via the shared signer. The connector
            // still accepts the pre-body-hash v1 form "for one release" —
            // this module was the last v1 signer, so removing v1 upstream is
            // now a no-op instead of silently breaking user/group sync.
            ...signedConnectorHeaders({ tenantKey, method: 'GET', path, ncUid: allowedUid, body: null }),
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        // `status` travels structurally so callers can classify the failure
        // without parsing the message.
        throw Object.assign(new Error(`NC proxy ${path} HTTP ${res.status}`), { status: res.status });
    }
    return res.json();
}

/**
 * Impersonation allow-list for service-level NC reads: the org's stored NC
 * admin (group/user enumeration) or the uid currently being mirrored.
 * `''` is the anonymous/public context and always allowed.
 */
function _assertImpersonatable(org, ncUid) {
    const uid = String(ncUid || '');
    if (!uid) return '';
    const admin = String(org?.nc_admin_uid || org?.ncAdminUid || '');
    if (admin && uid === admin) return uid;
    if (_syncingUids.has(_syncKey(org, uid))) return uid;
    throw new Error(`Refusing to impersonate NC uid "${uid}" — not the org admin or the uid being synced`);
}

// uids currently being mirrored, REFERENCE-COUNTED and keyed per org.
//
// A boolean "did I add it?" flag was wrong on both axes. Counting: two syncs
// of the same uid overlap in normal operation (the 6-hourly backstop while a
// webhook-driven sync runs, or a manual "Sync now"), and the second saw the
// entry already present, added nothing, and then had its permission deleted
// out from under it when the FIRST finished — its next OCS read threw inside
// the try/catch that swallows transient failures, so it silently completed
// with no groups and no status change. Keying: the entry said "this uid may
// be impersonated" without saying for which organisation, so one tenant's
// in-flight sync briefly widened what another tenant's could ask for.
const _syncingUids = new Map(); // `${orgId}|${uid}` -> depth

function _syncKey(org, uid) {
    return `${org?.id || ''}|${uid}`;
}

async function _withSyncingUid(org, ncUid, fn) {
    const uid = String(ncUid || '');
    if (!uid) return await fn();
    const key = _syncKey(org, uid);
    _syncingUids.set(key, (_syncingUids.get(key) || 0) + 1);
    try {
        return await fn();
    } finally {
        const left = (_syncingUids.get(key) || 1) - 1;
        if (left > 0) _syncingUids.set(key, left);
        else _syncingUids.delete(key);
    }
}

async function fetchNcUser(org, ncUid) {
    const body = await ncProxyFetch(org, `/ocs/v2.php/cloud/users/${encodeURIComponent(ncUid)}?format=json`, ncUid);
    return body?.ocs?.data || null;
}

async function fetchNcUserGroups(org, ncUid) {
    const body = await ncProxyFetch(org, `/ocs/v2.php/cloud/users/${encodeURIComponent(ncUid)}/groups?format=json`, ncUid);
    return body?.ocs?.data?.groups || [];
}

function shouldMirrorUser(org, userGroups) {
    const mode = org.nc_sync_mode || 'mirror_all';
    if (mode === 'manual') return false;
    if (org.ncSyncExcludedGroups?.length) {
        if (userGroups.some(g => org.ncSyncExcludedGroups.includes(g))) return false;
    }
    if (mode === 'selective_groups') {
        if (!org.ncSyncGroups?.length) return false;
        return userGroups.some(g => org.ncSyncGroups.includes(g));
    }
    return true; // mirror_all
}

async function applyUserCreated(org, ncUid) {
    return await _withSyncingUid(org, ncUid, () => _applyUserCreated(org, ncUid));
}

async function _applyUserCreated(org, ncUid) {
    const existing = await userStore.getUserByNcUid(org.id, ncUid);
    if (existing) {
        const updates = {};
        // Refresh metadata from NC on every sync so admin-side changes (rename,
        // email, group membership) propagate without manual user-edit. Each
        // fetch is wrapped so a transient OCS failure doesn't drop the rest.
        try {
            const ncUser = await fetchNcUser(org, ncUid);
            if (ncUser) {
                if (ncUser.email && ncUser.email !== existing.email) updates.email = ncUser.email;
                const ncDisplay = ncUser.displayname || ncUser.displayName;
                if (ncDisplay && ncDisplay !== existing.displayName) updates.displayName = ncDisplay;
            }
        } catch { /* leave identity untouched on transient errors */ }
        // Groups must be resolved BEFORE the reactivation decision below.
        let ncGroups = null;
        try {
            ncGroups = await fetchNcUserGroups(org, ncUid);
            const expected = ncGroups.filter(g => g !== 'admin').map(g => ncGroupToBfId(org.id, g));
            const current = Array.isArray(existing.groups) ? existing.groups.slice().sort() : [];
            const next = expected.slice().sort();
            if (current.join(',') !== next.join(',')) updates.groups = expected;
        } catch { /* leave groups untouched on transient errors */ }
        // Reactivate only when the sync mode still admits this user.
        //
        // This used to be an unconditional `status = 'active'` at the top of
        // the branch — before the groups were even fetched, and never
        // consulting shouldMirrorUser (which only gated the create path). So
        // every user that applyGroupMemberChange had just deactivated for
        // falling outside selective_groups / entering an excluded group came
        // back at the next backstop run, and the one after that: an access
        // decision quietly undone every six hours.
        //
        // A null ncGroups means the OCS read failed: a status UPGRADE must
        // fail closed, or an excluded user returns whenever Nextcloud hiccups.
        if (existing.status === 'inactive'
            && ncGroups !== null
            && shouldMirrorUser(org, ncGroups)) {
            updates.status = 'active';
        }
        if (Object.keys(updates).length > 0) {
            await userStore.updateUser(existing.id, updates);
        }
        return { action: 'update', userId: existing.id, changed: Object.keys(updates) };
    }
    let ncUser, ncGroups;
    try {
        ncUser = await fetchNcUser(org, ncUid);
        ncGroups = await fetchNcUserGroups(org, ncUid);
    } catch (e) {
        log.warn(`[ncSync] Could not fetch NC user ${ncUid} for org ${org.id}: ${e.message}`);
        return { action: 'error', error: e.message };
    }
    if (!ncUser?.email) {
        log.warn(`[ncSync] Skipping NC user ${ncUid} — no email`);
        return { action: 'skip', reason: 'no_email' };
    }
    if (!shouldMirrorUser(org, ncGroups)) {
        return { action: 'skip', reason: 'sync_mode_excludes' };
    }
    const status = (org.nc_new_user_default_status === 'pending') ? 'pending' : 'active';
    const userId = `nc_${org.id}_${slugifyId(ncUid)}`;
    // Map NC group memberships to Bee Flow group ids — relies on mirrorGroups
    // having populated the groups table for this org. NC's `admin` group is
    // intentionally not mirrored, so it gets dropped here.
    const bfGroupIds = (ncGroups || [])
        .filter(g => g !== 'admin')
        .map(g => ncGroupToBfId(org.id, g));
    const r = await userStore.createUserWithSeatCheck({
        id: userId,
        username: ncUser.email,
        email: ncUser.email,
        displayName: ncUser.displayname || ncUid,
        role: 'user',
        orgRole: '',
        organizationId: org.id,
        ncUid,
        provider: 'nextcloud_connector',
        autoProvisioned: true,
        status,
        groups: bfGroupIds,
    }, { strict: false });
    if (!r.created) {
        if (r.reason === 'seat_cap') {
            log.warn(`[ncSync] seat.cap.skipped org=${org.id} nc_uid=${ncUid} current=${r.current} max=${r.max}`);
            return { action: 'skip', reason: 'seat_cap' };
        }
        log.warn(`[ncSync] createUser failed for ${ncUid}: ${r.reason}`);
        return { action: 'skip', reason: r.reason };
    }
    log.info(`[ncSync] Mirrored NC user ${ncUid} → ${userId} (status=${status}, groups=${bfGroupIds.length})`);
    return { action: 'create', userId, status, groups: bfGroupIds };
}

async function applyUserDeleted(org, ncUid) {
    const user = await userStore.getUserByNcUid(org.id, ncUid);
    if (!user) return { action: 'noop' };
    // Soft-delete: set status=inactive so audit + history is preserved.
    // Hard-delete only on org-admin explicit purge (separate endpoint).
    await userStore.updateUser(user.id, { status: 'inactive' });
    log.info(`[ncSync] Soft-deleted user ${user.id} after NC delete of ${ncUid}`);
    return { action: 'deactivate', userId: user.id };
}

async function applyGroupMemberChange(org, ncUid /* , groupId */) {
    return await _withSyncingUid(org, ncUid, () => _applyGroupMemberChange(org, ncUid));
}

async function _applyGroupMemberChange(org, ncUid /* , groupId */) {
    // Re-evaluate membership: user may have entered/left a group that
    // changes their inclusion under selective_groups / excluded_groups.
    // Always also propagates the NC group set to the BF user.groups[] so
    // group-based access in Bee Flow tracks NC.
    const user = await userStore.getUserByNcUid(org.id, ncUid);
    let groups;
    try { groups = await fetchNcUserGroups(org, ncUid); } catch { return { action: 'noop' }; }
    const shouldExist = shouldMirrorUser(org, groups);
    if (shouldExist && !user) {
        return applyUserCreated(org, ncUid);
    }
    const expectedGroups = (groups || []).filter(g => g !== 'admin').map(g => ncGroupToBfId(org.id, g));
    if (!shouldExist && user && user.status === 'active') {
        await userStore.updateUser(user.id, { status: 'inactive', groups: expectedGroups });
        return { action: 'deactivate', userId: user.id };
    }
    if (shouldExist && user && user.status === 'inactive') {
        await userStore.updateUser(user.id, { status: 'active', groups: expectedGroups });
        return { action: 'reactivate', userId: user.id };
    }
    if (shouldExist && user) {
        const current = Array.isArray(user.groups) ? user.groups.slice().sort() : [];
        const next = expectedGroups.slice().sort();
        if (current.join(',') !== next.join(',')) {
            await userStore.updateUser(user.id, { groups: expectedGroups });
            return { action: 'groups_updated', userId: user.id, groups: expectedGroups };
        }
    }
    return { action: 'noop' };
}

function ncGroupToBfId(orgId, ncGroupName) {
    return `nc_${orgId}_${String(ncGroupName).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
}

async function mirrorGroups(org) {
    const userStore = require('../stores/userStore');
    let ncGroupNames = [];
    try {
        ncGroupNames = await listNcGroups(org);
    } catch (e) {
        return { created: 0, errors: [{ error: e.message }] };
    }
    const existing = await userStore.getAllGroups();
    const existingByNcName = new Map();
    for (const g of existing) {
        if (g.organizationId === org.id && g.source === 'nextcloud') {
            existingByNcName.set(g.name, g);
        }
    }
    let created = 0;
    const errors = [];
    for (const name of ncGroupNames) {
        // Skip the NC `admin` group — it shouldn't gate Bee Flow capabilities.
        if (name === 'admin') continue;
        if (existingByNcName.has(name)) continue;
        try {
            await userStore.createGroup({
                id: ncGroupToBfId(org.id, name),
                name,
                organizationId: org.id,
                source: 'nextcloud',
                lastSyncedAt: new Date().toISOString(),
            });
            created++;
        } catch (e) { errors.push({ name, error: e.message }); }
    }
    return { created, total: ncGroupNames.length, errors };
}

/**
 * What an org-health row may say about a failed NC read. Built from an
 * allow-list of classified fields rather than from the error message: the
 * message names the proxy path, and a later change to ncProxyFetch could put
 * the callback URL (or worse) in it without anyone looking here.
 *
 * @param {any} err
 * @returns {{ stage: string, reason: string, httpStatus?: number, errorCode?: string }}
 */
function summarizeSyncError(err) {
    const summary = { stage: 'list_users', reason: 'error' };
    const status = Number(err && err.status);
    const message = String((err && err.message) || '');
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
        summary.reason = `http_${status}`;
        summary.httpStatus = status;
    } else if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        summary.reason = 'timeout';
    } else if (/has no tenant key/.test(message)) {
        summary.reason = 'no_tenant_key';
    } else if (/has no connector_callback_url/.test(message)) {
        summary.reason = 'no_callback_url';
    } else if (message === 'fetch failed') {
        summary.reason = 'unreachable';
        const code = err && err.cause && err.cause.code;
        if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) summary.errorCode = code;
    }
    return summary;
}

// Periodic backstop: list all NC users + groups, diff against Bee Flow
// users.nc_uid, apply create/deactivate. Idempotent, safe to run on cron.
//
// Also the manual "Sync now" (routes/admin/ncSync.js). Neither path is gated
// here: the 24-hour backoff after a failure belongs to the backstop alone, so
// an admin who just fixed the connector can always retry at once. Both paths
// record the outcome on the org's health, though — a failure opens
// NC_SYNC_FAILED (which is what the backstop backs off on) and a success
// resolves it.
async function runFullSync(org) {
    if (!org?.id) return { error: 'no_org' };
    if ((org.nc_sync_mode || 'mirror_all') === 'manual') return { skipped: 'manual_mode' };
    const result = { created: 0, deactivated: 0, groupsCreated: 0, errors: [] };

    // 1. Mirror groups first so user-membership sync below can resolve names.
    const groupResult = await mirrorGroups(org);
    result.groupsCreated = groupResult.created;
    if (groupResult.errors?.length) result.errors.push(...groupResult.errors);

    let ncUsers = [];
    try {
        // AppAPI's own users-list endpoint accepts service-level shared-secret
        // auth (empty userId), unlike the standard /cloud/users which needs an
        // admin uid. Returns a flat array of NC uids.
        const body = await ncProxyFetch(org, '/ocs/v2.php/apps/app_api/api/v1/users?format=json');
        ncUsers = Array.isArray(body?.ocs?.data) ? body.ocs.data : [];
    } catch (e) {
        // Returns before ncLastSyncAt is written, so without the health row
        // the backstop would retry (and log) this org on every tick.
        await orgHealth.problem(NC_SYNC_FAILED, { orgId: org.id, meta: summarizeSyncError(e), source: 'ncSync' });
        return { error: e.message };
    }

    for (const ncUid of ncUsers) {
        try {
            const r = await applyUserCreated(org, ncUid);
            if (r.action === 'create') result.created++;
        } catch (e) { result.errors.push({ ncUid, error: e.message }); }
    }

    // Deactivate Bee Flow users whose NC counterpart no longer exists.
    const ncSet = new Set(ncUsers);
    const bfUsers = await userStore.getAllUsers();
    for (const u of bfUsers) {
        if (u.organizationId !== org.id) continue;
        if (!u.nc_uid || u.provider !== 'nextcloud_connector') continue;
        if (u.status === 'inactive') continue;
        if (!ncSet.has(u.nc_uid)) {
            try { await userStore.updateUser(u.id, { status: 'inactive' }); result.deactivated++; }
            catch (e) { result.errors.push({ userId: u.id, error: e.message }); }
        }
    }

    await userStore.updateOrganization(org.id, { ncLastSyncAt: new Date().toISOString() });
    await orgHealth.resolve(org.id, [NC_SYNC_FAILED]);
    log.info(`[ncSync] Full sync for org ${org.id}: created=${result.created} deactivated=${result.deactivated} errors=${result.errors.length}`);
    return result;
}

async function listNcGroups(org) {
    // /cloud/groups requires NC admin context; impersonate the org's stored
    // nc_admin_uid (captured during bootstrap) so the call resolves.
    const adminUid = org?.nc_admin_uid || '';
    const body = await ncProxyFetch(org, '/ocs/v2.php/cloud/groups?format=json', adminUid);
    return body?.ocs?.data?.groups || [];
}

module.exports = {
    applyUserCreated,
    applyUserDeleted,
    applyGroupMemberChange,
    runFullSync,
    listNcGroups,
    ncProxyFetch,
    summarizeSyncError,
    NC_SYNC_FAILED,
    _assertImpersonatable, // exported for tests — the impersonation allow-list
};
