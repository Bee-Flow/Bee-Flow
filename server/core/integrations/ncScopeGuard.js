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

const { RESOURCE_KINDS, resolveNcScope, normalizeFolderPath } = require('./ncScope');

// Longest-prefix wins — 'nextcloud_calendar_list' must resolve to the
// calendar family, not files. Mirrors core/integrations/integrationToolMap
// (tripwire-tested against it).
const PREFIX_TO_INTEGRATION = [
    ['nextcloud_calendar_', 'nextcloud-calendar'],
    ['nextcloud_contacts_', 'nextcloud-contacts'],
    ['nextcloud_deck_', 'nextcloud-deck'],
    ['nextcloud_notifications_', 'nextcloud-notifications'],
    ['nextcloud_talk_', 'nextcloud-talk'],
    ['nextcloud_tasks_', 'nextcloud-tasks'],
    ['nextcloud_notes_', 'nextcloud-notes'],
    ['nextcloud_mail_', 'nextcloud-mail'],
    ['nextcloud_activity_', 'nextcloud-activity'],
    ['nextcloud_teams_', 'nextcloud-teams'],
    ['nextcloud_tables_', 'nextcloud-tables'],
    ['nextcloud_forms_', 'nextcloud-forms'],
    ['nextcloud_status_', 'nextcloud-status'],
    ['nextcloud_', 'nextcloud'],
];

function integrationIdForTool(toolName) {
    if (typeof toolName !== 'string') return null;
    for (const [prefix, id] of PREFIX_TO_INTEGRATION) {
        if (toolName.startsWith(prefix)) return id;
    }
    return null;
}

// ── Tools whose results span MORE THAN ONE family ───────────────────────────
//
// The prefix map above necessarily files every tool under exactly one family,
// which is right for tools that touch one app. `nextcloud_search` does not:
// it asks Nextcloud which search providers exist and fans out to all of them,
// so a single call returns mail subjects, Talk messages, Deck cards and
// calendar entries alongside files. Scoping it by its nominal family (Files)
// alone means a user who switched Mail off is still answered with mail — the
// integration's own switch bypassed by a tool filed under a different one.
//
// Their rows are therefore filtered by the PROVIDER that produced them, and
// a row whose provider we cannot map is dropped rather than guessed at.
const CROSS_FAMILY_TOOLS = new Set(['nextcloud_search']);

// Nextcloud's provider ids are app-defined and not perfectly stable, so match
// on a prefix and fail closed on anything unrecognised.
const PROVIDER_PREFIX_TO_INTEGRATION = [
    ['files', 'nextcloud'],
    ['mail', 'nextcloud-mail'],
    ['talk', 'nextcloud-talk'],
    ['spreed', 'nextcloud-talk'],
    ['deck', 'nextcloud-deck'],
    ['calendar', 'nextcloud-calendar'],
    ['contacts', 'nextcloud-contacts'],
    ['tasks', 'nextcloud-tasks'],
    ['notes', 'nextcloud-notes'],
    ['activity', 'nextcloud-activity'],
    ['tables', 'nextcloud-tables'],
    ['forms', 'nextcloud-forms'],
    ['circles', 'nextcloud-teams'],
    ['teams', 'nextcloud-teams'],
    ['systemtags', 'nextcloud'],
    ['comments', 'nextcloud'],
];

function integrationForProvider(provider) {
    const p = String(provider || '').toLowerCase();
    if (!p) return null;
    for (const [prefix, id] of PROVIDER_PREFIX_TO_INTEGRATION) {
        if (p.startsWith(prefix)) return id;
    }
    return null;
}

// ── Per-family tool policies under mode 'selected' ──────────────────────────

const FILES_POLICIES = {
    nextcloud_list_files: 'navigate',
    nextcloud_read_file: { args: ['path'], allowMissing: false },
    nextcloud_upload_file: { args: ['path'], allowMissing: false },
    nextcloud_create_spreadsheet: { args: ['path'], allowMissing: false },
    nextcloud_create_document: { args: ['path'], allowMissing: false },
    nextcloud_create_presentation: { args: ['path', 'templatePath'], allowMissing: false },
    nextcloud_create_folder: { args: ['path'], allowMissing: false },
    nextcloud_delete: { args: ['path'], allowMissing: false },
    nextcloud_move: { args: ['source', 'destination'], allowMissing: false },
    nextcloud_copy: { args: ['source', 'destination'], allowMissing: false },
    nextcloud_create_share: { args: ['path'], allowMissing: false },
    nextcloud_share_with_user: { args: ['path'], allowMissing: false },
    nextcloud_share_with_group: { args: ['path'], allowMissing: false },
    nextcloud_share_by_email: { args: ['path'], allowMissing: false },
    // Executed by the TEAMS executor but named nextcloud_* — so the prefix
    // table files it here, under Files, where it had no policy at all and was
    // therefore denied whenever a folder selection was active. It is a share
    // of a FILE path, so Files is the right family to judge it: same rule as
    // its share_with_user / share_with_group siblings above.
    nextcloud_share_with_team: { args: ['path'], allowMissing: false },
    // 'originalPath' names the DESTINATION only in appearance: the file is
    // selected by the unchecked 'trashPath', and Nextcloud restores it to the
    // location recorded in its own trash metadata, ignoring what we ask for.
    // Gating on it validated a string the caller invented, so it joins the
    // id-indirect denials below.
    nextcloud_restore_from_trash: 'deny',
    // list_shares without a path lists every share — filterable by path.
    nextcloud_list_shares: 'filter',
    nextcloud_search_files: 'filter',
    nextcloud_search: 'filter',
    nextcloud_find_files_by_tag: 'filter',
    nextcloud_folder_tree: 'navigate',
    nextcloud_list_trash: 'filter',
    // Metadata-only reads: tag names carry no file content.
    nextcloud_list_tags: 'allow',
    nextcloud_create_tag: 'allow',
    nextcloud_list_groups: 'allow',
    // fileId/shareId-indirect tools: the id cannot be mapped to a folder
    // without an extra lookup — v1 denies them under 'selected'.
    nextcloud_convert_file: 'deny',
    nextcloud_direct_link: 'deny',
    nextcloud_update_share: 'deny',
    nextcloud_delete_share: 'deny',
    nextcloud_list_file_comments: 'deny',
    nextcloud_add_file_comment: 'deny',
    nextcloud_tag_file: 'deny',
    nextcloud_untag_file: 'deny',
    nextcloud_permanent_delete_trash: 'deny',
    nextcloud_list_versions: 'deny',
    nextcloud_restore_version: 'deny',
};

const FAMILY_POLICIES = {
    'nextcloud': FILES_POLICIES,
    'nextcloud-calendar': {
        nextcloud_calendar_list: 'filter',
        nextcloud_calendar_list_events: { args: ['calendar'], allowMissing: false },
        nextcloud_calendar_search_events: { args: ['calendar'], allowMissing: false },
        nextcloud_calendar_get_event: { args: ['calendar'], allowMissing: false },
        nextcloud_calendar_create_event: { args: ['calendar'], allowMissing: false },
        nextcloud_calendar_update_event: { args: ['calendar'], allowMissing: false },
        nextcloud_calendar_delete_event: { args: ['calendar'], allowMissing: false },
    },
    'nextcloud-contacts': {
        nextcloud_contacts_list_addressbooks: 'filter',
        nextcloud_contacts_list: { args: ['addressbook'], allowMissing: false },
        nextcloud_contacts_search: { args: ['addressbook'], allowMissing: false },
        nextcloud_contacts_get: { args: ['addressbook'], allowMissing: false },
        nextcloud_contacts_create: { args: ['addressbook'], allowMissing: false },
        nextcloud_contacts_update: { args: ['addressbook'], allowMissing: false },
        nextcloud_contacts_delete: { args: ['addressbook'], allowMissing: false },
    },
    'nextcloud-deck': {
        nextcloud_deck_list_boards: 'filter',
        nextcloud_deck_get_board: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_list_stacks: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_create_stack: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_update_stack: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_delete_stack: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_list_cards: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_search_cards: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_get_card: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_create_card: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_update_card: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_archive_card: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_delete_card: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_assign_label: { args: ['boardId'], allowMissing: false },
        nextcloud_deck_remove_label: { args: ['boardId'], allowMissing: false },
        // cardId-only — no board context without a lookup.
        nextcloud_deck_add_comment: 'deny',
        nextcloud_deck_list_comments: 'deny',
    },
    'nextcloud-talk': {
        nextcloud_talk_list_rooms: 'filter',
        nextcloud_talk_get_room: { args: ['token'], allowMissing: false },
        nextcloud_talk_list_participants: { args: ['token'], allowMissing: false },
        nextcloud_talk_start_recording: { args: ['token'], allowMissing: false },
        nextcloud_talk_stop_recording: { args: ['token'], allowMissing: false },
        nextcloud_talk_list_messages: { args: ['token'], allowMissing: false },
        nextcloud_talk_send_message: { args: ['token'], allowMissing: false },
        nextcloud_talk_delete_message: { args: ['token'], allowMissing: false },
        nextcloud_talk_add_reaction: { args: ['token'], allowMissing: false },
        nextcloud_talk_remove_reaction: { args: ['token'], allowMissing: false },
        nextcloud_talk_mark_read: { args: ['token'], allowMissing: false },
        nextcloud_talk_create_poll: { args: ['token'], allowMissing: false },
        nextcloud_talk_get_poll: { args: ['token'], allowMissing: false },
        nextcloud_talk_vote_poll: { args: ['token'], allowMissing: false },
        nextcloud_talk_close_poll: { args: ['token'], allowMissing: false },
        nextcloud_talk_share_file: { args: ['token'], allowMissing: false },
        // Creates a NEW conversation — nothing existing to protect.
        nextcloud_talk_create_room: 'allow',
        // Cross-room search: the request cannot be narrowed (the endpoint has
        // no token parameter), but every hit CAN be placed — Talk's provider
        // names the conversation, and the executor now surfaces it as `token`.
        // So it runs and its hits are trimmed to the shared rooms, instead of
        // being refused for want of an argument the tool does not have.
        nextcloud_talk_search_messages: 'filter',
    },
    'nextcloud-tasks': {
        nextcloud_tasks_list_lists: 'filter',
        nextcloud_tasks_list: { args: ['list'], allowMissing: false },
        nextcloud_tasks_search: { args: ['list'], allowMissing: false },
        nextcloud_tasks_get: { args: ['list'], allowMissing: false },
        nextcloud_tasks_create: { args: ['list'], allowMissing: false },
        nextcloud_tasks_update: { args: ['list'], allowMissing: false },
        nextcloud_tasks_complete: { args: ['list'], allowMissing: false },
        nextcloud_tasks_delete: { args: ['list'], allowMissing: false },
    },
    'nextcloud-mail': {
        nextcloud_mail_list_accounts: 'filter',
        nextcloud_mail_list_mailboxes: { args: ['accountId'], allowMissing: false },
        nextcloud_mail_send: { args: ['accountId'], allowMissing: false },
        // mailboxId and messageId are account-INDIRECT, which is why these
        // were all denied: an account selection granted a list of accounts,
        // a list of mailboxes, and the ability to send — but no way to read a
        // single subject. Selecting your work account and asking "anything
        // important in my inbox?" was answered with a refusal.
        //
        // They are gated by memory instead (see MAIL_ARG_POLICIES): a mailbox
        // id is honoured once it has come back from an account-gated
        // list_mailboxes, and a message id once it has come back from a
        // mailbox-gated search. That is the order the model must work in
        // anyway — list_accounts' own description says "Always call this
        // first" — so nothing is lost, and an id that never passed through an
        // in-scope result is still refused.
        nextcloud_mail_search: 'mail',
        nextcloud_mail_read: 'mail',
        nextcloud_mail_read_attachment: 'mail',
        nextcloud_mail_save_attachment: 'mail',
        nextcloud_mail_set_flags: 'mail',
        nextcloud_mail_move: 'mail',
    },
    'nextcloud-tables': {
        nextcloud_tables_list: 'filter',
        nextcloud_tables_update: { args: ['tableId'], allowMissing: false },
        nextcloud_tables_delete: { args: ['tableId'], allowMissing: false },
        nextcloud_tables_list_columns: { args: ['tableId'], allowMissing: false },
        nextcloud_tables_create_column: { args: ['tableId'], allowMissing: false },
        nextcloud_tables_list_rows: { args: ['tableId'], allowMissing: false },
        nextcloud_tables_create_row: { args: ['tableId'], allowMissing: false },
        // PUT /rows/{rowId} is table-independent — tableId is used only to
        // resolve column names — so an in-scope tableId cannot vouch for the
        // row being written. Same reason delete_row is denied below.
        nextcloud_tables_update_row: 'deny',  // rowId-only
        nextcloud_tables_create: 'allow',       // creates a NEW table
        nextcloud_tables_delete_column: 'deny', // columnId-only
        nextcloud_tables_delete_row: 'deny',    // rowId-only
    },
    'nextcloud-forms': {
        nextcloud_forms_list: 'filter',
        nextcloud_forms_get: { args: ['formId'], allowMissing: false },
        nextcloud_forms_add_question: { args: ['formId'], allowMissing: false },
        nextcloud_forms_get_submissions: { args: ['formId'], allowMissing: false },
        nextcloud_forms_update_settings: { args: ['formId'], allowMissing: false },
        nextcloud_forms_delete: { args: ['formId'], allowMissing: false },
        nextcloud_forms_create: 'allow',        // creates a NEW form
    },
    // all|off-only families: no per-tool policies needed — 'selected' cannot
    // be stored for them (ncScope degrades it to 'off').
    'nextcloud-notes': null,
    'nextcloud-activity': null,
    'nextcloud-notifications': null,
    'nextcloud-status': null,
    'nextcloud-teams': null,
};

// Which remembered set vouches for which Mail argument. `mailbox` ids are
// learned from an account-gated list_mailboxes; `message` ids from a
// mailbox-gated search. Anything not learned is refused.
const MAIL_ARG_POLICIES = {
    nextcloud_mail_search: { mailbox: ['mailboxId'] },
    nextcloud_mail_read: { message: ['messageId'] },
    nextcloud_mail_read_attachment: { message: ['messageId'] },
    nextcloud_mail_save_attachment: { message: ['messageId'] },
    nextcloud_mail_set_flags: { message: ['messageId'] },
    // Both halves: the message must be one we vouched for, and it may only be
    // moved into a mailbox of a shared account — otherwise "move" becomes a
    // way to walk mail out of the selection.
    nextcloud_mail_move: { message: ['messageId'], mailbox: ['destMailboxId'] },
};

// ── Arguments that belong to ANOTHER family ────────────────────────────────
//
// integrationIdForTool files a tool by its name prefix, which is right for
// every tool that touches one app — and wrong for the handful that carry a
// resource from another. nextcloud_talk_share_file is judged against the TALK
// scope because of its name, but its `path` argument names a FILE: a user who
// narrowed Files to /Invoice2 could still have /Private/salaries.xlsx posted
// into a conversation, because nothing on that call ever consulted the Files
// scope. Same shape for a mail attachment saved into Files.
//
// So these arguments get a SECOND check against the family that actually owns
// them, after the tool's own family policy has passed. Narrowing only: this
// can add a denial, never remove one.
const CROSS_FAMILY_ARGS = {
    nextcloud_talk_share_file: { path: 'nextcloud' },
    nextcloud_mail_save_attachment: { targetPath: 'nextcloud' },
};

// Result-filter item candidates: which fields identify an entry, per family.
const RESULT_ID_FIELDS = {
    'nextcloud-calendar': ['slug'],
    'nextcloud-contacts': ['slug', 'name', 'id'],
    'nextcloud-deck': ['id'],
    'nextcloud-talk': ['token'],
    'nextcloud-tasks': ['slug', 'name', 'id'],
    'nextcloud-mail': ['id', 'accountId'],
    'nextcloud-tables': ['id'],
    'nextcloud-forms': ['id'],
};

// Container keys a { count, <plural>: [...] } result may use, per family.
const RESULT_CONTAINER_KEYS = ['calendars', 'addressbooks', 'boards', 'rooms', 'conversations',
    'lists', 'accounts', 'tables', 'forms', 'results', 'files', 'items', 'shares', 'trash', 'tree', 'matches',
    'messages'];

const SETTINGS_HINT = 'You can change this under Settings → Integrations → Nextcloud → “What Bee Flow may access”.';

function deniedError(label, detail) {
    return {
        error: `${detail} Access to ${label} is limited by this user's Nextcloud access settings. ${SETTINGS_HINT}`,
        nc_scope_denied: true,
    };
}

// ── Navigation: finding what you were given ────────────────────────────────
//
// Every other family answers "what may I use?" with a discovery tool marked
// 'filter' — it runs, and the result is trimmed to the allowed set. Files had
// no such tool: its discovery IS nextcloud_list_files, gated on a 'path' that
// the model must already know. Starting at "/" (or any ancestor of the shared
// folder) was therefore refused, and folder_tree came back empty because the
// filter dropped every node it could not place inside the selection.
//
// So these two run against an ancestor and are trimmed afterwards. What that
// discloses is bounded: an ancestor of a folder the user deliberately shared,
// whose existence their own grant already implies. Nothing beside the shared
// subtree survives the filter — a sibling folder is still invisible.
//
// Only these two. A search hit or a trash entry is not navigation: those stay
// strictly inside the selection, because "show me what I may reach" and "find
// me things" are different questions.
const NAVIGATION_TOOLS = new Set(['nextcloud_list_files', 'nextcloud_folder_tree']);

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

function _remembers(key, kind, value) {
    const hit = _mailMemo.get(key);
    if (!hit || Date.now() - hit.at >= MAIL_MEMO_TTL_MS) return false;
    return !!hit[kind] && hit[kind].has(String(value).trim());
}

// Last-resort org lookup.
//
// The session fallbacks above only work for a session that carries connector
// fields or a `user` object — and the background callers are exactly the ones
// that carry neither: triggerBus.loadSession returns
// {accessToken, refreshToken, oauthProvider, routineProviders, _source} on its
// two non-connector paths. With org null, resolveNcScope skips the org layer
// entirely (it reads the org doc only `orgId ? ... : null`), so an org that had
// switched an integration off had that decision silently dropped for every
// OAuth and app-password user — the ceiling gone while the user layer still
// looked enforced. Memoised on the same TTL as the scope itself.
const _orgMemo = new Map();

async function _orgForUser(userId) {
    if (!userId) return null;
    const hit = _orgMemo.get(userId);
    if (hit && Date.now() - hit.at < SCOPE_CACHE_TTL_MS) return hit.orgId;
    let orgId = null;
    try {
        const row = await require('../../stores/userStore').getUser(userId);
        orgId = row?.organizationId || row?.organization_id || null;
    } catch (_) {
        orgId = null; // resolveNcScope still applies the user layer
    }
    _orgMemo.set(userId, { at: Date.now(), orgId });
    return orgId;
}

function invalidateScopeCache(userId) {
    // The Mail memory is derived from a scope that just changed, so it goes
    // with it — otherwise a mailbox learned under the old selection would keep
    // vouching for itself after the user narrowed things down.
    if (!userId) { _scopeCache.clear(); _mailMemo.clear(); _orgMemo.clear(); return; }
    for (const key of _scopeCache.keys()) {
        if (key.split('|')[1] === String(userId)) _scopeCache.delete(key);
    }
    for (const key of _mailMemo.keys()) {
        if (key.split('|')[1] === String(userId)) _mailMemo.delete(key);
    }
    _orgMemo.delete(String(userId));
    _orgMemo.delete(userId);
}

/**
 * Gate one Nextcloud tool call. Returns null when allowed, or the structured
 * { error } the dispatcher should hand back to the model.
 */
async function checkToolCall({ toolName, toolArgs = {}, userId, orgId = null, agentId = null }) {
    const integrationId = integrationIdForTool(toolName);
    if (!integrationId) return null; // not a Nextcloud tool — not ours to gate

    let scope;
    try {
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

function _filterArray(arr, predicate) {
    return Array.isArray(arr) ? arr.filter(predicate) : arr;
}

/**
 * Trim a 'filter'-policy tool result to the allowed resources. Anything the
 * filter cannot positively identify is REMOVED (fail-closed). Non-filter
 * tools and mode!=selected return the result untouched.
 */
async function filterResult({ toolName, result, userId, orgId = null, agentId = null }) {
    const integrationId = integrationIdForTool(toolName);
    if (!integrationId || !result || typeof result !== 'object' || result.error) return result;

    let scope;
    try {
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
    // is policy 'allow', its result used to pass through untouched — handing a
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

/**
 * check → run → filter, for a caller OUTSIDE core/tools/toolDispatcher.
 *
 * The guard used to have exactly one call site, so every background feature
 * that reached a Nextcloud executor directly — the Talk auto-record scan, the
 * meeting-note write-back, the automation triggers for activity, notifications
 * and calendar, the Talk-meeting calendar lookup, the recordings route — ran
 * with no scope at all. The settings screen says "Enforced on the server for
 * chats, automations and apps alike"; those are the automations and the apps.
 *
 * orgId is derived from the session when not given, because a background
 * caller usually holds a session and not an org id, and dropping the org
 * ceiling would quietly enforce only half the scope.
 *
 * @param {Function} run  invoked only if the call is allowed
 * @returns the executor's result, filtered — or the structured denial
 */
async function guardedNcCall(toolName, toolArgs, { userId, session = null, orgId = null, agentId = null }, run) {
    const org = orgId || session?.connectorOrgId || session?.user?.organizationId || await _orgForUser(userId);
    const denial = await checkToolCall({ toolName, toolArgs, userId, orgId: org, agentId });
    if (denial) return denial;
    const raw = await run();
    if (raw === undefined) return raw;
    return await filterResult({ toolName, result: raw, userId, orgId: org, agentId });
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
