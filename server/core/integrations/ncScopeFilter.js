/** @typedef {import('../entitlements/betaFeatures').SessionLike} SessionLike */
// @typecheck
const { RESOURCE_KINDS, resolveNcScope, normalizeFolderPath } = require('./ncScope');
const { resolveScopeOrg } = require('./ncScopeOrg');
const { integrationIdForTool, CROSS_FAMILY_TOOLS, integrationForProvider, FAMILY_POLICIES, RESULT_ID_FIELDS, RESULT_CONTAINER_KEYS, SETTINGS_HINT, NAVIGATION_TOOLS } = require('./ncScopePolicies');

function pathAllowed(selectedSet, rawPath) {
    const p = normalizeFolderPath(rawPath);
    if (p === null) return false;
    for (const allowed of selectedSet) {
        if (allowed === '/' || p === allowed || p.startsWith(allowed + '/')) return true;
    }
    return false;
}

/** Is some shared folder strictly BELOW this path? (i.e. is it on the way down) */
function pathIsAncestorOfAllowed(selectedSet, rawPath) {
    const p = normalizeFolderPath(rawPath);
    if (p === null) return false;
    const prefix = p === '/' ? '/' : p + '/';
    for (const allowed of selectedSet) {
        if (allowed !== p && allowed.startsWith(prefix)) return true;
    }
    return false;
}

function idAllowed(selectedSet, value) {
    if (value === undefined || value === null || value === '') return false;
    return selectedSet.has(String(value).trim());
}

// In-process scope cache: getIntegrationTools + every tool call in the same
// turn would otherwise re-read two config rows per call. 15s is short enough
// that a settings change lands within one conversational beat.
const _scopeCache = new Map();

const SCOPE_CACHE_TTL_MS = 15_000;

function _scopeKey({ userId, orgId, agentId }) {
    return `${orgId || ''}|${userId || ''}|${agentId || ''}`;
}

/**
 * The mail memo is keyed by the SELECTION it was learned under, not just by
 * who learned it.
 *
 * Without the fingerprint the memo outlives the grant: unticking a mail
 * account leaves every mailbox and message id it taught still vouching for
 * itself, so the account-level tools correctly start refusing while READING
 * its messages keeps working — the failure hides behind its own half-fix. And
 * the only thing that cleared it, invalidateScopeCache, empties an in-process
 * Map: production runs two replicas, so the pod that did not serve the
 * settings write never heard about it.
 *
 * Appending the fingerprint makes a changed selection miss the old memo on
 * EVERY replica, within the 15s scope-cache TTL and with no cross-process
 * signalling. It can only ever make the key more specific — a memo can stop
 * matching, never start — so the worst case is one extra round trip, which is
 * the trade this memo already documents.
 */
function _mailMemoKey(ids, entry) {
    const sel = entry && entry.mode === 'selected'
        ? [...(entry.selected || [])].sort().join(',')
        : (entry && entry.mode) || 'all';
    return `${_scopeKey(ids)}|${sel}`;
}

/** @typedef {{ userId: string | null | undefined, orgId: string | null, agentId: string | null }} _effectiveScopeArgs */
/**
 * @param {_effectiveScopeArgs} param0
 */
async function _effectiveScope({ userId, orgId, agentId }) {
    const key = _scopeKey({ userId, orgId, agentId });
    const hit = _scopeCache.get(key);
    if (hit && Date.now() - hit.at < SCOPE_CACHE_TTL_MS) return hit.scope;
    const scope = await resolveNcScope({ orgId, userId, agentId });
    _scopeCache.set(key, { at: Date.now(), scope });
    return scope;
}

// ── What we have already vouched for (Mail) ────────────────────────────────
//
// Bounded and per-scope-key, so one user's memory can never answer for
// another's, and an agent with a narrower scope does not inherit the user's.
// Losing it costs a round trip (the model re-lists or re-searches) — never
// access, because an unremembered id is refused.
const _mailMemo = new Map();

const MAIL_MEMO_TTL_MS = 30 * 60_000;

const MAIL_MEMO_MAX = 2000;

function _memoFor(key) {
    const hit = _mailMemo.get(key);
    if (hit && Date.now() - hit.at < MAIL_MEMO_TTL_MS) return hit;
    // Keyed by the SAME words MAIL_ARG_POLICIES uses, so the two cannot drift.
    const fresh = { at: Date.now(), mailbox: new Set(), message: new Set() };
    _mailMemo.set(key, fresh);
    return fresh;
}

function _remember(key, kind, ids) {
    const memo = _memoFor(key);
    const set = memo[kind];
    if (!set) throw new Error(`ncScopeGuard: unknown mail memo kind "${kind}"`);
    for (const id of ids) {
        if (id === undefined || id === null || id === '') continue;
        set.add(String(id).trim());
    }
    // Oldest-first trim: a Set preserves insertion order, so this drops the
    // ids least likely to still be in play.
    while (set.size > MAIL_MEMO_MAX) set.delete(set.values().next().value);
    // Deliberately NOT refreshing memo.at: sliding it on every learn meant a
    // user still working in a shared account kept renewing the lease on ids
    // learned half an hour earlier, so MAIL_MEMO_TTL_MS never actually
    // expired anything.
}

function _filterArray(arr, predicate) {
    return Array.isArray(arr) ? arr.filter(predicate) : arr;
}

/**
 * Trim a 'filter'-policy tool result to the allowed resources. Anything the
 * filter cannot positively identify is REMOVED (fail-closed). Non-filter
 * tools and mode!=selected return the result untouched.
 */
async function filterResult({ toolName, result, userId, orgId = null, agentId = null, session = null }) {
    const integrationId = integrationIdForTool(toolName);
    if (!integrationId || !result || typeof result !== 'object' || result.error) return result;

    let scope;
    try {
        orgId = await resolveScopeOrg({ orgId, session, userId });
        scope = await _effectiveScope({ userId, orgId, agentId });
    } catch (_) {
        return { error: 'Nextcloud access settings are temporarily unavailable — the result was withheld.', nc_scope_denied: true };
    }
    // Cross-family tools are filtered by the provider that produced each row,
    // and BEFORE the single-family early-return below — their rows are not
    // governed by the family the tool name happens to sort into, so a Files
    // mode of 'all' must not wave through mail and Talk hits.
    if (CROSS_FAMILY_TOOLS.has(toolName)) {
        const keep = (item) => {
            const id = integrationForProvider(item?.provider);
            if (!id) return false;                       // unmappable → drop
            const e = scope[id] || { mode: 'all', selected: null };
            if (e.mode === 'off') return false;
            if (e.mode !== 'selected') return true;
            // Under a selection we can only vouch for a row we can locate.
            // Files hits carry a path; a mail/Talk/Deck hit carries no id we
            // can match against the user's chosen resources, so it is dropped
            // rather than assumed in scope.
            if (id !== 'nextcloud') return false;
            const p = item?.path ?? item?.filePath ?? item?.href ?? null;
            return p !== null && pathAllowed(e.selected || new Set(), p);
        };
        return _filterContainers(result, keep);
    }

    const entry = scope[integrationId];
    if (!entry || entry.mode !== 'selected') return result;

    // Talk's POST /room is IDEMPOTENT for a one-to-one: asking to "open a chat
    // with Bob" returns the EXISTING conversation when there is one, and the
    // executor cannot tell 200-existing from 201-created. Because create_room
    // is policy 'allow', its result must not pass through untouched — that hands a
    // user who had narrowed Talk the last message of a conversation they never
    // selected. The room itself is not granted (that would be the widening
    // this guard exists to prevent); only its message content is withheld, and
    // the caller is told why.
    // Learn from the results the guard has just vouched for. list_mailboxes is
    // account-gated, so every mailbox it returns provably belongs to a shared
    // account; search is mailbox-gated, so every message it returns provably
    // sits in one of those mailboxes. This is the whole basis on which the
    // message-level tools are allowed at all.
    if (integrationId === 'nextcloud-mail') {
        const memoKey = _mailMemoKey({ userId, orgId, agentId }, entry);
        if (toolName === 'nextcloud_mail_list_mailboxes' && Array.isArray(result.mailboxes)) {
            _remember(memoKey, 'mailbox', result.mailboxes.map(m => m?.id));
        } else if (toolName === 'nextcloud_mail_search' && Array.isArray(result.messages)) {
            _remember(memoKey, 'message', result.messages.map(m => m?.id));
        }
    }

    // A table or form Bee Flow just CREATED is not in the user's selection —
    // it did not exist when they last opened the picker — so every follow-up
    // (add a column, add a row, add a question, read submissions, and even
    // delete the thing again) is refused, and the list tool hides it. The
    // assistant reads that as "creation failed" and tries again, leaving a
    // second empty table behind.
    //
    // NOT self-granting the new id. That looks obvious and is unsafe: the same
    // mechanism applied to Talk would permanently add a conversation the user
    // never selected, because POST /room is idempotent for a one-to-one and
    // returns an EXISTING room. Instead the handoff is made honest — the id is
    // named, and so is the one action that makes it usable. The picker behind
    // "What Bee Flow may access" lists resources unfiltered, so the new table
    // is there to tick.
    const CREATED_ID = {
        nextcloud_tables_create: (r) => r?.table?.id,
        nextcloud_forms_create: (r) => r?.form?.id,
    };
    if (CREATED_ID[toolName]) {
        const id = CREATED_ID[toolName](result);
        const label = (RESOURCE_KINDS[integrationId] && RESOURCE_KINDS[integrationId].label) || integrationId;
        if (id !== undefined && id !== null && !idAllowed(entry.selected || new Set(), id)) {
            return {
                ...result,
                nc_scope_note: `Created, but ${label} are limited to a selection that does not include this new one (id ${id}), `
                    + `so Bee Flow cannot add to it or read it back yet. Tick it under ${SETTINGS_HINT.replace(/^You can change this under /, '')} `
                    + 'It is already listed there — do not create another one.',
            };
        }
    }

    if (toolName === 'nextcloud_talk_create_room' && result.room && typeof result.room === 'object') {
        const token = result.room.token;
        if (!idAllowed(entry.selected || new Set(), token)) {
            // An ALLOWLIST. Stripping lastMessage by name left the other
            // sixteen fields of mapRoom intact — the other party's display
            // name, unread count, whether they mentioned you, when they last
            // wrote, whether they are in a call and whether it is being
            // recorded. Since POST /room is idempotent for a one-to-one, that
            // is queryable for any uid on the instance: an activity oracle
            // over conversations the user never shared, not one slip.
            const room = { token: result.room.token, type: result.room.type };
            return {
                ...result,
                room,
                nc_scope_note: 'This conversation is not among the ones shared with Bee Flow, so its contents are withheld. '
                    + SETTINGS_HINT,
            };
        }
    }

    const policies = FAMILY_POLICIES[integrationId];
    const policy = policies ? policies[toolName] : undefined;
    if (policy !== 'filter' && policy !== 'navigate') return result;

    const selected = entry.selected || new Set();

    if (integrationId === 'nextcloud') {
        // Files results carry paths in various fields; keep entries whose
        // path is inside an allowed folder, drop entries with no
        // recognisable path at all.
        const pathOf = (item) => item?.path ?? item?.filePath ?? item?.originalPath ?? item?.originalLocation ?? item?.href ?? null;
        if (NAVIGATION_TOOLS.has(toolName)) {
            // The tree arrives nested and its nodes may carry only a name, so
            // it is pruned recursively with the path composed on the way down
            // — a shallow filter over the top level is what returned an empty
            // tree to the user who had shared exactly one folder.
            if (Array.isArray(result.tree)) {
                return { ...result, tree: _pruneFileTree(result.tree, '/', selected) };
            }
            // Flat listing: the shared subtree, plus the folders leading to it.
            const keepNav = (item) => {
                const p = pathOf(item);
                if (p === null) return false;
                return pathAllowed(selected, p) || pathIsAncestorOfAllowed(selected, p);
            };
            return _filterContainers(result, keepNav);
        }
        const keep = (item) => { const p = pathOf(item); return p !== null && pathAllowed(selected, p); };
        return _filterContainers(result, keep);
    }

    const idFields = RESULT_ID_FIELDS[integrationId] || ['id'];
    const keep = (item) => {
        if (!item || typeof item !== 'object') return false;
        for (const f of idFields) {
            if (item[f] !== undefined && item[f] !== null && selected.has(String(item[f]).trim())) return true;
        }
        return false;
    };
    return _filterContainers(result, keep);
}

/**
 * Prune a nested folder tree to the shared subtrees.
 *
 * A node is kept when it is INSIDE the selection (with its whole subtree — the
 * user shared it, so everything under it is theirs to see) or when it is on the
 * way DOWN to one (kept, but recursed into, so its unshared siblings stay
 * invisible). Anything else is dropped.
 *
 * Nextcloud's folder-tree nodes are not guaranteed to carry a full path — a
 * child may only give its own name — so the path is composed from the parent
 * as we descend, and written back onto the node. That is not cosmetic: it is
 * what lets the model take a node from the tree and hand it straight to
 * nextcloud_list_files. A node whose path cannot be established is dropped.
 */
function _pruneFileTree(nodes, parentPath, selected) {
    if (!Array.isArray(nodes)) return [];
    const out = [];
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const own = node.path ?? node.filePath ?? node.href ?? null;
        const name = node.basename ?? node.name ?? node.displayName ?? null;
        const composed = name ? `${parentPath === '/' ? '' : parentPath}/${name}` : null;
        const p = normalizeFolderPath(own !== null ? own : composed);
        if (p === null) continue;
        const childKey = Array.isArray(node.children) ? 'children'
            : (Array.isArray(node.entries) ? 'entries' : null);
        if (pathAllowed(selected, p)) { out.push({ ...node, path: p }); continue; }
        if (!pathIsAncestorOfAllowed(selected, p)) continue;
        const pruned = childKey ? _pruneFileTree(node[childKey], p, selected) : [];
        out.push(childKey ? { ...node, path: p, [childKey]: pruned } : { ...node, path: p });
    }
    return out;
}

function _filterContainers(result, keep) {
    if (Array.isArray(result)) return result.filter(keep);
    const out = { ...result };
    let filteredAny = false;
    for (const key of RESULT_CONTAINER_KEYS) {
        if (Array.isArray(out[key])) {
            out[key] = _filterArray(out[key], keep);
            filteredAny = true;
        }
    }
    if (!filteredAny) {
        // No recognised container — withhold rather than leak an unknown
        // shape. The drift test keeps the container list in step with the
        // executors, so this branch firing in CI means "extend the list".
        return { error: 'The result shape of this Nextcloud tool is not scope-filterable — the result was withheld under the active selection.', nc_scope_denied: true };
    }
    if (typeof out.count === 'number') {
        const firstList = RESULT_CONTAINER_KEYS.map(k => out[k]).find(Array.isArray);
        if (firstList) out.count = firstList.length;
    }
    return out;
}

module.exports = { pathAllowed, pathIsAncestorOfAllowed, idAllowed, _scopeCache, _mailMemoKey, _effectiveScope, _mailMemo, MAIL_MEMO_TTL_MS, filterResult };
