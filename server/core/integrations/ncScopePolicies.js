// @typecheck

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

/**
 * @param {string} toolName
 */
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

const SETTINGS_HINT = 'You can change this under Settings → Connections → Nextcloud → “What Bee Flow may access”.';

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

module.exports = { PREFIX_TO_INTEGRATION, integrationIdForTool, CROSS_FAMILY_TOOLS, integrationForProvider, FAMILY_POLICIES, MAIL_ARG_POLICIES, CROSS_FAMILY_ARGS, RESULT_ID_FIELDS, RESULT_CONTAINER_KEYS, SETTINGS_HINT, deniedError, NAVIGATION_TOOLS };
