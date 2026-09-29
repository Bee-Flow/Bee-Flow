/**
 * Per-user Nextcloud access scope — which parts of their Nextcloud a user
 * lets Bee Flow touch.
 *
 * The model Christian Fu Müller's Moltagent made canonical, applied to a
 * connector: you share folders/calendars/boards with the assistant exactly
 * like onboarding a colleague, and you can revoke everything in one click.
 * Nextcloud itself has no declarative ExApp scoping (ApiScopes were removed
 * in AppAPI 3.2; OAuth2 is unscoped by their own admin manual), so this
 * layer is enforced HERE, server-side, in core/tools/toolDispatcher via
 * ncScopeGuard — never in the UI alone.
 *
 * Storage (configStore, no migration):
 *   user_nc_scope_<userId>  — the user's own narrowing (this module's API)
 *   org_nc_scope_<orgId>    — RESERVED org ceiling, same shape; composed by
 *                             the resolver already, no UI writes it yet
 *   agent_nc_scope_<agentId> — RESERVED for per-agent identity scoping
 *                             (Moltagent-style); the resolver signature
 *                             accepts agentId now so the layer can slot in
 *                             without call-site churn later
 *
 * Document shape (v1):
 *   { v: 1,
 *     integrations: { [ncIntegrationId]: { mode: 'all'|'selected'|'off',
 *                                          selected?: string[] } },
 *     updatedAt, updatedBy }
 *
 * Absent doc or absent integration id ⇒ mode 'all' (allow-all default —
 * shipping this feature changes nothing until a user narrows).
 *
 * Composition (org ∩ user, most restrictive wins):
 *   off      beats selected beats all
 *   selected ∩ selected = set intersection
 * A user can therefore only NARROW what entitlements/org toggles already
 * grant — resolved AFTER isAppOn() by the consumers, never before.
 *
 * Two distinct zero states, deliberately:
 *   revokeAll() writes every integration 'off' — the one-click offboarding
 *   resetToDefault() deletes the doc — back to allow-all
 */

const configStore = require('../../stores/configStore');
const { NC_INTEGRATIONS, NC_INTEGRATION_ID_SET } = require('./ncIntegrationCatalog');

const MODES = new Set(['all', 'selected', 'off']);
const MAX_SELECTED = 200;
const MAX_ID_LEN = 500;

// Which integrations support resource-level 'selected' mode in v1, and what
// the resource is. Integrations absent here are all|off only. Kept in ONE
// place with the guard's tool policies (ncScopeGuard) keyed off it; the
// dispatcher drift test asserts every catalog id is classified.
const RESOURCE_KINDS = {
    'nextcloud': { kind: 'folder', label: 'folders', listTool: 'nextcloud_folder_tree' },
    'nextcloud-calendar': { kind: 'calendar', label: 'calendars', listTool: 'nextcloud_calendar_list' },
    'nextcloud-contacts': { kind: 'addressbook', label: 'address books', listTool: 'nextcloud_contacts_list_addressbooks' },
    'nextcloud-deck': { kind: 'board', label: 'boards', listTool: 'nextcloud_deck_list_boards' },
    'nextcloud-talk': { kind: 'room', label: 'conversations', listTool: 'nextcloud_talk_list_rooms' },
    'nextcloud-tasks': { kind: 'list', label: 'task lists', listTool: 'nextcloud_tasks_list_lists' },
    'nextcloud-mail': { kind: 'account', label: 'mail accounts', listTool: 'nextcloud_mail_list_accounts' },
    'nextcloud-tables': { kind: 'table', label: 'tables', listTool: 'nextcloud_tables_list' },
    'nextcloud-forms': { kind: 'form', label: 'forms', listTool: 'nextcloud_forms_list' },
};

function userKey(userId) { return `user_nc_scope_${userId}`; }
function orgKey(orgId) { return `org_nc_scope_${orgId}`; }
function agentKey(agentId) { return `agent_nc_scope_${agentId}`; }

function isScopable(integrationId) { return integrationId in RESOURCE_KINDS; }

/**
 * Normalise a files-scope folder path: rooted, single slashes, no trailing
 * slash, no traversal. Returns null for anything unusable.
 */
function normalizeFolderPath(raw) {
    if (typeof raw !== 'string') return null;
    let p = raw.trim();
    if (!p) return null;
    p = ('/' + p).replace(/\\/g, '/').replace(/\/+/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    if (p.split('/').some(seg => seg === '..' || seg === '.')) return null;
    if (p.length > MAX_ID_LEN) return null;
    return p;
}

function sanitizeSelected(integrationId, list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        let v = null;
        if (integrationId === 'nextcloud') {
            v = normalizeFolderPath(raw);
        } else if (typeof raw === 'string' || typeof raw === 'number') {
            const s = String(raw).trim();
            v = s && s.length <= MAX_ID_LEN ? s : null;
        }
        if (v !== null && !seen.has(v)) {
            seen.add(v);
            out.push(v);
            if (out.length >= MAX_SELECTED) break;
        }
    }
    return out;
}

/**
 * Validate + normalise a full or partial integrations map. Unknown ids and
 * malformed entries are dropped, never stored. 'selected' on an unscopable
 * integration degrades to 'off' — fail-closed: the user asked for "less
 * than everything" on a surface that cannot narrow, so nothing is safer
 * than everything.
 */
function sanitizeIntegrations(patch) {
    const out = {};
    if (!patch || typeof patch !== 'object') return out;
    for (const [id, entry] of Object.entries(patch)) {
        if (!NC_INTEGRATION_ID_SET.has(id)) continue;
        if (!entry || typeof entry !== 'object') continue;
        let mode = MODES.has(entry.mode) ? entry.mode : null;
        if (!mode) continue;
        if (mode === 'selected' && !isScopable(id)) mode = 'off';
        const doc = { mode };
        if (mode === 'selected') doc.selected = sanitizeSelected(id, entry.selected);
        out[id] = doc;
    }
    return out;
}

async function getOrgScopeDoc(orgId) {
    if (!orgId) return null;
    // Deliberately uncaught — see resolveNcScope: "store is down" must stay
    // distinguishable from "nothing configured".
    return await configStore.getConfig(orgKey(orgId));
}

/**
 * Write the org ceiling. This is what the org-admin's Nextcloud integration
 * toggles now persist.
 *
 * Absent doc (or absent id within it) means "never configured — everything
 * the plan allows", which is the state every organisation is in until an
 * admin saves the panel for the first time. That is what keeps this
 * enforceable without taking Nextcloud away from anyone on deploy: nothing
 * changes until somebody makes a choice here.
 */
async function saveOrgScope(orgId, patch, { updatedBy = null } = {}) {
    if (!orgId) throw new Error('orgId required');
    const current = (await getOrgScopeDoc(orgId)) || { v: 1, integrations: {} };
    const before = sanitizeIntegrations(current.integrations);
    const merged = { ...before };
    const incoming = patch?.integrations || {};
    for (const [id, entry] of Object.entries(incoming)) {
        if (!NC_INTEGRATION_ID_SET.has(id)) continue;
        if (entry === null || entry === undefined || entry?.mode === 'all') {
            delete merged[id];
        } else {
            const clean = sanitizeIntegrations({ [id]: entry })[id];
            if (clean) merged[id] = clean;
        }
    }
    const doc = {
        v: 1,
        integrations: merged,
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || null,
    };
    await configStore.setConfig(orgKey(orgId), doc);
    await _audit({ userId: updatedBy, orgId, updatedBy, summary: _diffSummary(before, merged), scope: 'org' });
    return doc;
}

/**
 * Replace the org ceiling with exactly this set of enabled integration ids —
 * the shape the admin panel speaks (a list of ticked boxes). Ids absent from
 * the list are stored as an explicit `off`, which is how "untick everything"
 * becomes expressible at all: an empty legacy array could never say that.
 */
async function setOrgEnabledIntegrations(orgId, enabledIds, { updatedBy = null } = {}) {
    const enabled = new Set((Array.isArray(enabledIds) ? enabledIds : []).filter(id => NC_INTEGRATION_ID_SET.has(id)));
    const integrations = {};
    for (const { id } of NC_INTEGRATIONS) {
        integrations[id] = enabled.has(id) ? { mode: 'all' } : { mode: 'off' };
    }
    return await saveOrgScope(orgId, { integrations }, { updatedBy });
}

async function getUserScopeDoc(userId) {
    if (!userId) return null;
    // No catch: an unreadable store must THROW, not read as "no doc". A
    // swallowed error here would resolve to allow-all (fail-open) in the
    // guard, and in saveUserScope it would silently overwrite the stored
    // scope with a merge against nothing.
    return await configStore.getConfig(userKey(userId));
}

/**
 * Resolve the EFFECTIVE scope for a caller: Map-like plain object
 * { [integrationId]: { mode, selected: Set<string> } } covering every
 * catalog id (absent layers ⇒ 'all').
 *
 * agentId is accepted now, composed last (a further narrowing layer), so a
 * future per-agent identity story needs no signature change. No UI writes
 * agent docs yet.
 */
async function resolveNcScope({ orgId = null, userId = null, agentId = null } = {}) {
    // No catch on these reads: "the store is down" and "no scope stored"
    // must stay distinguishable. ncScopeGuard catches the throw and DENIES
    // (fail-closed); swallowing here would quietly resolve to allow-all.
    const [orgDoc, userDoc, agentDoc] = await Promise.all([
        orgId ? configStore.getConfig(orgKey(orgId)) : null,
        userId ? configStore.getConfig(userKey(userId)) : null,
        agentId ? configStore.getConfig(agentKey(agentId)) : null,
    ]);
    const layers = [orgDoc, userDoc, agentDoc]
        .map(d => sanitizeIntegrations(d?.integrations));

    const effective = {};
    for (const { id } of NC_INTEGRATIONS) {
        let mode = 'all';
        let selected = null; // null = unrestricted
        for (const layer of layers) {
            const entry = layer[id];
            if (!entry) continue;
            if (entry.mode === 'off' || mode === 'off') { mode = 'off'; selected = null; continue; }
            if (entry.mode === 'selected') {
                const set = new Set(entry.selected || []);
                if (mode === 'selected') {
                    // intersection of the two narrowings
                    selected = new Set([...selected].filter(x => set.has(x)));
                } else {
                    mode = 'selected';
                    selected = set;
                }
            }
            // entry.mode === 'all' narrows nothing
        }
        effective[id] = { mode, selected: mode === 'selected' ? (selected || new Set()) : null };
    }
    return effective;
}

function _diffSummary(before, after) {
    const parts = [];
    const ids = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const id of ids) {
        const b = before?.[id]; const a = after?.[id];
        const show = (e) => !e ? 'all' : e.mode === 'selected' ? `selected(${(e.selected || []).length})` : e.mode;
        if (show(b) !== show(a)) parts.push(`${id}: ${show(b)}→${show(a)}`);
    }
    return parts.join(', ') || 'no-op';
}

async function _audit({ userId, orgId, updatedBy: _updatedBy, summary, scope = 'user' }) {
    try {
        const guardrailEventStore = require('../../stores/guardrailEventStore');
        await guardrailEventStore.logGuardrailEvent({
            organization_id: orgId || null,
            user_id: userId,
            violation_type: scope === 'org' ? 'admin_action' : 'user_action',
            violation_categories: `nc_scope:${scope}`,
            direction: 'config',
            action_taken: summary.slice(0, 1000),
            source: 'nc_scope',
        });
    } catch (_) { /* audit is best-effort — never block the setting change */ }
}

/**
 * Merge-save the user's scope. `patch.integrations` entries replace the
 * stored entry per integration id; an entry of null/undefined removes the
 * override (back to 'all') — that is how a row's "Everything" choice is
 * stored as absence, keeping absent-means-default true everywhere.
 */
async function saveUserScope(userId, patch, { orgId = null, updatedBy = null } = {}) {
    if (!userId) throw new Error('userId required');
    const current = (await getUserScopeDoc(userId)) || { v: 1, integrations: {} };
    const before = sanitizeIntegrations(current.integrations);
    const merged = { ...before };
    const incoming = patch?.integrations || {};
    for (const [id, entry] of Object.entries(incoming)) {
        if (!NC_INTEGRATION_ID_SET.has(id)) continue;
        if (entry === null || entry === undefined || entry?.mode === 'all') {
            delete merged[id];
        } else {
            const clean = sanitizeIntegrations({ [id]: entry })[id];
            if (clean) merged[id] = clean;
        }
    }
    const doc = {
        v: 1,
        integrations: merged,
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || userId,
    };
    await configStore.setConfig(userKey(userId), doc);
    await _audit({ userId, orgId, updatedBy, summary: _diffSummary(before, merged) });
    return doc;
}

/** One-click offboarding: every integration explicitly off. */
async function revokeAll(userId, { orgId = null, updatedBy = null } = {}) {
    if (!userId) throw new Error('userId required');
    const current = (await getUserScopeDoc(userId)) || { v: 1, integrations: {} };
    const before = sanitizeIntegrations(current.integrations);
    const integrations = {};
    for (const { id } of NC_INTEGRATIONS) integrations[id] = { mode: 'off' };
    const doc = { v: 1, integrations, updatedAt: new Date().toISOString(), updatedBy: updatedBy || userId };
    await configStore.setConfig(userKey(userId), doc);
    await _audit({ userId, orgId, updatedBy, summary: `revoke-all (${_diffSummary(before, integrations)})` });
    return doc;
}

/** Back to allow-all: delete the doc (absent = default). */
async function resetToDefault(userId, { orgId = null, updatedBy = null } = {}) {
    if (!userId) throw new Error('userId required');
    const current = (await getUserScopeDoc(userId)) || { v: 1, integrations: {} };
    const before = sanitizeIntegrations(current.integrations);
    await configStore.deleteConfig(userKey(userId));
    await _audit({ userId, orgId, updatedBy, summary: `reset-to-default (was: ${_diffSummary({}, before) || 'default'})` });
    return { v: 1, integrations: {} };
}

module.exports = {
    RESOURCE_KINDS,
    isScopable,
    normalizeFolderPath,
    sanitizeIntegrations,
    getUserScopeDoc,
    getOrgScopeDoc,
    saveOrgScope,
    setOrgEnabledIntegrations,
    resolveNcScope,
    saveUserScope,
    revokeAll,
    resetToDefault,
    _userKey: userKey,
    _orgKey: orgKey,
};
