// @typecheck
/**
 * ncScopeGuard — server-side enforcement of the per-user Nextcloud scope.
 *
 * Sits in core/tools/toolDispatcher immediately before the Nextcloud family
 * dispatch, so ONE guard covers chat, automations, AI tasks, cowork and
 * Studio apps. Two operations:
 *
 *   checkToolCall(...)  → null (allowed) | { error } (denied) — BEFORE the
 *                          family executor runs
 *   filterResult(...)   → the executor result with out-of-scope entries
 *                          removed — AFTER list/search tools return
 *
 * NARROW-ONLY BY CONSTRUCTION: there is no allow path here that
 * integrationTools/entitlements did not already grant — the guard can only
 * deny or filter. Resolved scope comes from ncScope.resolveNcScope
 * (org ∩ user ∩ agent, most restrictive wins).
 *
 * FAIL-CLOSED: if the scope store cannot be read, NC tool calls are denied
 * with a transient error. This is a privacy boundary shown to a
 * security-minded audience; "the database hiccuped so everything was
 * allowed" is not an acceptable failure mode.
 *
 * Per-tool policy under mode 'selected':
 *   { args: [...] }  every present listed arg must resolve to an allowed
 *                    resource (files: path-prefix; others: exact id);
 *                    a MISSING listed arg on tools where the executor would
 *                    fan out to everything is denied with a hint to name
 *                    the resource
 *   'filter'         allowed to run; result entries outside the scope are
 *                    removed by filterResult
 *   'navigate'       read-only listing: also allowed to run on an ANCESTOR of
 *                    a shared folder, and the listing is trimmed to the shared
 *                    subtree plus the folders leading down to it. Without this
 *                    a user who shares one folder can never be shown it — the
 *                    model's first move is to list "/" and it was refused, so
 *                    the assistant reported having no access at all and asked
 *                    the user to grant what they had already granted.
 *   'allow'          runs unrestricted under 'selected' (metadata-only or
 *                    creates a NEW resource)
 *   'deny'           cannot be scoped in v1 (id-indirect tools such as
 *                    fileId/messageId lookups) — denied with an honest hint
 *
 * A nextcloud_* tool that is missing from its family policy is DENIED under
 * 'selected' (fail-closed for tools added later); the colocated dispatcher
 * test enumerates every registered NC tool and fails when one is
 * unclassified, so the gap is caught in CI, not production.
 */

const { RESOURCE_KINDS } = require('./ncScope');
const { resolveScopeOrg, clearOrgMemo } = require('./ncScopeOrg');
const { PREFIX_TO_INTEGRATION, integrationIdForTool, FAMILY_POLICIES, MAIL_ARG_POLICIES, CROSS_FAMILY_ARGS, RESULT_ID_FIELDS, deniedError } = require('./ncScopePolicies');
const { pathAllowed, pathIsAncestorOfAllowed, idAllowed, _scopeCache, _mailMemoKey, _effectiveScope, _mailMemo, MAIL_MEMO_TTL_MS, filterResult } = require('./ncScopeFilter');

// ── Per-family tool policies under mode 'selected' ──────────────────────────

function _remembers(key, kind, value) {
    const hit = _mailMemo.get(key);
    if (!hit || Date.now() - hit.at >= MAIL_MEMO_TTL_MS) return false;
    return !!hit[kind] && hit[kind].has(String(value).trim());
}

function invalidateScopeCache(userId) {
    // The Mail memory is derived from a scope that just changed, so it goes
    // with it — otherwise a mailbox learned under the old selection would keep
    // vouching for itself after the user narrowed things down.
    if (!userId) { _scopeCache.clear(); _mailMemo.clear(); clearOrgMemo(); return; }
    for (const key of _scopeCache.keys()) {
        if (key.split('|')[1] === String(userId)) _scopeCache.delete(key);
    }
    for (const key of _mailMemo.keys()) {
        if (key.split('|')[1] === String(userId)) _mailMemo.delete(key);
    }
    clearOrgMemo(userId);
}

/**
 * Gate one Nextcloud tool call. Returns null when allowed, or the structured
 * { error } the dispatcher should hand back to the model.
 *
 * @param {{ toolName: string, toolArgs?: Record<string, any>, userId?: string|null, orgId?: string|null, agentId?: string|null, session?: any }} call
 */
async function checkToolCall({ toolName, toolArgs = {}, userId, orgId = null, agentId = null, session = null }) {
    const integrationId = integrationIdForTool(toolName);
    if (!integrationId) return null; // not a Nextcloud tool — not ours to gate

    let scope;
    try {
        // The org ceiling is resolved HERE so every caller gets it; an explicit
        // orgId stays authoritative. A failed lookup denies (fail closed).
        orgId = await resolveScopeOrg({ orgId, session, userId });
        scope = await _effectiveScope({ userId, orgId, agentId });
    } catch (e) {
        // Fail closed: a privacy boundary that cannot be read must deny.
        return { error: 'Nextcloud access settings are temporarily unavailable — this call was not executed. Please retry.', nc_scope_denied: true };
    }

    // Arguments owned by another family are checked FIRST and independently of
    // this tool's own family mode: a Talk scope of 'all' must not wave through
    // a file the Files scope excludes.
    const borrowed = CROSS_FAMILY_ARGS[toolName];
    if (borrowed) {
        for (const [argKey, ownerId] of Object.entries(borrowed)) {
            const value = toolArgs?.[argKey];
            if (value === undefined || value === null || value === '') continue;
            const owner = scope[ownerId] || { mode: 'all', selected: null };
            const ownerLabel = (RESOURCE_KINDS[ownerId] && RESOURCE_KINDS[ownerId].label) || ownerId;
            if (owner.mode === 'off') {
                return deniedError(ownerLabel, `This call would reach a Nextcloud file, and Files is turned off for this user.`);
            }
            if (owner.mode === 'selected' && !pathAllowed(owner.selected || new Set(), value)) {
                return deniedError(ownerLabel, `"${String(value).slice(0, 120)}" is outside the ${ownerLabel} this user has shared with Bee Flow.`);
            }
        }
    }

    const entry = scope[integrationId] || { mode: 'all', selected: null };
    const label = (RESOURCE_KINDS[integrationId] && RESOURCE_KINDS[integrationId].label) || integrationId;

    if (entry.mode === 'off') {
        return deniedError(label, `The ${integrationId.replace('nextcloud-', 'Nextcloud ').replace(/^nextcloud$/, 'Nextcloud Files')} integration is turned off for this user.`);
    }
    if (entry.mode !== 'selected') return null;

    const policies = FAMILY_POLICIES[integrationId];
    const policy = policies ? policies[toolName] : undefined;

    if (policy === 'allow') return null;
    if (policy === 'filter') return null; // runs; filterResult trims the output
    if (policy === 'navigate') {
        // An absent path means the executor starts at the root, which is an
        // ancestor of everything — so "list my files" works again and answers
        // with exactly the shared folders.
        const selected = entry.selected || new Set();
        const raw = toolArgs?.path;
        const p = (raw === undefined || raw === null || raw === '') ? '/' : raw;
        if (pathAllowed(selected, p) || pathIsAncestorOfAllowed(selected, p)) return null;
        return deniedError(label, `"${String(p).slice(0, 120)}" is outside the ${label} this user has shared with Bee Flow.`);
    }
    if (policy === 'mail') {
        const spec = MAIL_ARG_POLICIES[toolName] || {};
        const memoKey = _mailMemoKey({ userId, orgId, agentId }, entry);
        /** @type {Record<string, string>} */
        const HOW = {
            mailbox: 'List the mailboxes of one of the shared accounts first (nextcloud_mail_list_mailboxes).',
            message: 'Search a mailbox of one of the shared accounts first (nextcloud_mail_search) — a message can only be opened once it has come back from a search Bee Flow is allowed to run.',
        };
        for (const [kind, argKeys] of Object.entries(spec)) {
            for (const argKey of argKeys) {
                const value = toolArgs?.[argKey];
                if (value === undefined || value === null || value === '') continue;
                if (!_remembers(memoKey, kind, value)) {
                    return deniedError(label, `"${String(value).slice(0, 120)}" has not been shown to be inside the ${label} this user has shared with Bee Flow. ${HOW[kind]}`);
                }
            }
        }
        return null;
    }
    if (policy === undefined || policy === 'deny') {
        // Unknown tools fail closed on purpose: a tool added to a family
        // without a policy must not bypass a narrowed scope.
        return deniedError(label, `The tool ${toolName} cannot be limited to selected ${label} in this version, so it is blocked while a selection is active. Use a resource-specific tool, or widen the scope.`);
    }

    // { args: [...] } — every present listed arg must be in scope.
    const selected = entry.selected || new Set();
    const isFiles = integrationId === 'nextcloud';
    let sawAny = false;
    for (const argKey of policy.args) {
        const value = toolArgs?.[argKey];
        if (value === undefined || value === null || value === '') continue;
        sawAny = true;
        const ok = isFiles ? pathAllowed(selected, value) : idAllowed(selected, value);
        if (!ok) {
            // The Tables tools accept a table TITLE in `tableId`; the selection
            // holds ids, and this guard must not resolve names over the
            // network. Still denied — but say why, or the author reads
            // "outside the shared tables" about a table that IS shared.
            if (integrationId === 'nextcloud-tables' && typeof value === 'string' && !/^\s*\d+\s*$/.test(value)) {
                return deniedError(label, `"${String(value).slice(0, 120)}" is a table title; while a ${label} selection is active, name the table by its id (nextcloud_tables_list shows the shared tables with their ids).`);
            }
            return deniedError(label, `"${String(value).slice(0, 120)}" is outside the ${label} this user has shared with Bee Flow.`);
        }
    }
    if (!sawAny && !policy.allowMissing) {
        return deniedError(label, `This call must name one of the shared ${label} explicitly (argument: ${policy.args.join(' or ')}).`);
    }
    return null;
}

/**
 * check → run → filter, for a caller OUTSIDE core/tools/toolDispatcher.
 *
 * The guard has more than one call site, so every background feature
 * that reached a Nextcloud executor directly — the Talk auto-record scan, the
 * meeting-note write-back, the automation triggers for activity, notifications
 * and calendar, the Talk-meeting calendar lookup, the recordings route — would otherwise run
 * with no scope at all. The settings screen says "Enforced on the server for
 * chats, automations and apps alike"; those are the automations and the apps.
 *
 * orgId is derived from the session when not given, because a background
 * caller usually holds a session and not an org id, and dropping the org
 * ceiling would quietly enforce only half the scope.
 *
 * @template T
 * @param {() => Promise<T>} run  invoked only if the call is allowed
 * @returns the executor's result, filtered — or the structured denial
 */
async function guardedNcCall(toolName, toolArgs, /** @type {{ userId: string, session?: import('../entitlements/entitlementTypes').SessionLike | null, orgId?: string | null, agentId?: string | null }} */ { userId, session = null, orgId = null, agentId = null }, run) {
    const denial = await checkToolCall({ toolName, toolArgs, userId, orgId, agentId, session });
    if (denial) return denial;
    const raw = await run();
    if (raw === undefined) return raw;
    return await filterResult({ toolName, result: raw, userId, orgId, agentId, session });
}

module.exports = {
    checkToolCall,
    guardedNcCall,
    filterResult,
    integrationIdForTool,
    invalidateScopeCache,
    FAMILY_POLICIES,
    PREFIX_TO_INTEGRATION,
    RESULT_ID_FIELDS,
};

/**
 * @typedef {'allow' | 'filter' | 'navigate' | 'mail' | 'deny' | { args: string[], allowMissing: boolean }} ToolPolicy  a keyword, or the arguments to check
 * @typedef {Awaited<ReturnType<typeof import('./ncScope').resolveNcScope>>} EffectiveScope
 * @typedef {EffectiveScope[string]} ScopeEntry
 * @typedef {{ userId?: string | null, orgId?: string | null, agentId?: string | null }} ScopeIds
 * @typedef {{ at: number, mailbox: Set<string>, message: Set<string> }} MailMemo
 * @typedef {Record<string, unknown>} ResultItem  one entry of a Nextcloud tool result
 * @typedef {Parameters<typeof resolveScopeOrg>[0]['session']} ScopeSession
 */
