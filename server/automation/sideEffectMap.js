/**
 * Side-Effect Map — declares which tool names produce externally-visible effects.
 *
 * The runner uses this to (a) refuse side-effect calls during dry-run —
 * READ-ONLY tools run FOR REAL in a dry-run so the builder sees genuine
 * data/shapes; only writes are simulated — and (b) require a one-time
 * first-run confirmation before unleashing the automation unattended.
 *
 * **Policy: fail-closed.** Any tool not listed in READ_ONLY is treated as
 * sideEffect = true. This means new write-capable integrations get
 * conservative handling automatically.
 *
 * **Keep this complete.** Every tool of every app in `ALL_TOOL_APPS`
 * (automation/toolRegistry.js — TOOL_REGISTRY *plus* the inline-injected apps)
 * MUST be listed in exactly one of READ_ONLY / SIDE_EFFECTS below —
 * sideEffectMap.test.js enforces it. The test used to walk TOOL_REGISTRY only,
 * so the nine tools A2-1 added to the shared list (browse_web, notebook_*,
 * regex_*) fell outside exactly the check this paragraph promises. An unclassified read is not harmless:
 * the fail-closed default silently SIMULATES it in dry-runs, so the builder
 * plans against fake sample data instead of the user's real data (this is
 * exactly how AFAS/NMBRS/n8n reads regressed before the test existed).
 * READ_ONLY may additionally contain chat-only tool names that are not in
 * the automation registry.
 */

const READ_ONLY = new Set([
    // Gmail
    'gmail_search', 'gmail_read', 'gmail_read_attachment', 'gmail_list_labels',
    // Calendar
    'calendar_list_events', 'calendar_search_events', 'calendar_get_event',
    // Drive / Docs / Sheets / Slides
    'drive_search', 'drive_list_files', 'drive_get_file', 'drive_get_content', 'drive_read_file',
    'docs_read', 'docs_list',
    'sheets_list', 'sheets_get_values', 'sheets_list_tabs',
    'slides_list', 'slides_get', 'slides_export_pdf',
    // Contacts / Keep / Groups
    'contacts_search', 'contacts_list',
    'keep_list', 'keep_get', 'keep_search',
    'groups_list_conversations', 'groups_read_conversation',
    // ── Apps die INLINE worden geïnjecteerd (toolRegistry.INLINE_TOOL_APPS) ──
    // Sinds A2-1 staan de browser, de notebooks en de regex-regels in
    // `ALL_TOOL_APPS`, en dus in de kiezer: hun effect komt op het scherm en
    // stuurt de dry-run van de runner. Ze vielen alle negen op de fail-closed
    // default ('writes'), zodat een LEESACTIE als "verandert iets" werd
    // getekend en in een dry-run gesimuleerd werd — de builder plant dan tegen
    // verzonnen data. Hier staan ze uitgeschreven, niet per ongeluk.
    'notebook_read',
    'regex_list_rules', 'regex_test_pattern',
    // Outlook / MS
    'outlook_search', 'outlook_read', 'outlook_list_recent', 'outlook_list_folders',
    'ms_calendar_list_events', 'ms_calendar_search_events', 'ms_calendar_get_event',
    'onedrive_search', 'onedrive_list', 'onedrive_list_files', 'onedrive_get_file',
    'ms_contacts_search', 'ms_contacts_list',
    // YouTrack / GitHub / LinkedIn read-only
    'youtrack_search_issues', 'youtrack_get_issue', 'youtrack_get_issue_comments', 'youtrack_list_projects',
    'youtrack_find_user',
    'github_search_repos', 'github_get_repo', 'github_list_repos', 'github_list_branches',
    'github_get_file', 'github_list_contents', 'github_list_issues', 'github_get_issue',
    'linkedin_search_profiles', 'linkedin_get_profile',
    // Withings is a read-only integration by design — there is no write tool to
    // classify, and there never should be one for a medical-adjacent account.
    'withings_get_measures', 'withings_get_sleep_summary', 'withings_get_activity',
    // SignRequest / Gamma (status + catalog lookups)
    'signrequest_check_status', 'signrequest_list_documents',
    'gamma_get_generation_status', 'gamma_list_themes', 'gamma_list_folders',
    // AFAS Profit (read-only integration by design) / NMBRS payroll reads
    'afas_list_connectors', 'afas_describe_connector', 'afas_query',
    'nmbrs_list_debtors', 'nmbrs_list_companies', 'nmbrs_list_employees', 'nmbrs_get_employee',
    'nmbrs_list_employee_contracts', 'nmbrs_list_employee_salaries',
    'nmbrs_list_employee_wage_components', 'nmbrs_list_payslips',
    // vPlan (read-only planning integration by design)
    'vplan_whoami', 'vplan_list_boards', 'vplan_list_resources', 'vplan_get_resource_availability',
    'vplan_list_activities', 'vplan_list_collections', 'vplan_get_collection', 'vplan_list_cards',
    'vplan_get_card', 'vplan_list_orders', 'vplan_get_order', 'vplan_list_time_tracking',
    'vplan_time_tracking_summary', 'vplan_get_capacity', 'vplan_list_master_data',
    // Maps / Search / KB
    'maps_search_places', 'maps_geocode', 'maps_directions',
    'agent_search', 'kb_search',
    // A datatable read an agent's owner granted (core/tools/datatableTools.js).
    // Chat-only — it is not in the automation registry, which the docblock
    // above allows for exactly this. Classified rather than left to the
    // fail-closed default because that default is `writes`, and a read the
    // policy layer calls a write is a confirmation card in front of "what does
    // the XL cost?" — and, in an unattended run, the tool gone from the stack.
    'datatable_query',
    // Personal memory (read half) and a routine's own run history — both are
    // first-party reads of the caller's own data, so a dry-run does them for
    // real: a simulated run summary is the one thing an evolution proposal
    // must never be planned against.
    'memory_search', 'routine_runs_summary',
    // Fireflies
    'fireflies_list_transcripts', 'fireflies_get_summary', 'fireflies_get_transcript',
    // Transcription — a pure transform (audio in → text out) on our own
    // whisperx service; nothing external is mutated, so dry-runs do it for real.
    'transcribe_audio',
    // n8n (reads)
    'n8n_workflow_list', 'n8n_workflow_get', 'n8n_workflow_nodes_find',
    'n8n_execution_list', 'n8n_execution_get', 'n8n_execution_get_detail',
    // ── Nextcloud (read-only) — names verified against the tool modules ──
    // Files & WebDAV
    'nextcloud_list_files', 'nextcloud_search_files', 'nextcloud_read_file',
    'nextcloud_list_shares', 'nextcloud_list_file_comments',
    'nextcloud_list_tags', 'nextcloud_find_files_by_tag',
    'nextcloud_list_trash', 'nextcloud_list_versions',
    // Calendar
    'nextcloud_calendar_list', 'nextcloud_calendar_list_events',
    'nextcloud_calendar_search_events', 'nextcloud_calendar_get_event',
    // Contacts
    'nextcloud_contacts_list_addressbooks', 'nextcloud_contacts_list',
    'nextcloud_contacts_search', 'nextcloud_contacts_get',
    // Deck
    'nextcloud_deck_list_boards', 'nextcloud_deck_get_board',
    'nextcloud_deck_list_stacks', 'nextcloud_deck_list_cards',
    'nextcloud_deck_search_cards', 'nextcloud_deck_get_card',
    'nextcloud_deck_list_comments',
    // Talk
    'nextcloud_talk_list_rooms', 'nextcloud_talk_get_room', 'nextcloud_talk_list_participants',
    'nextcloud_talk_list_messages', 'nextcloud_talk_search_messages',
    // Tasks
    'nextcloud_tasks_list_lists', 'nextcloud_tasks_list',
    'nextcloud_tasks_search', 'nextcloud_tasks_get',
    // Notes
    'nextcloud_notes_list', 'nextcloud_notes_search',
    'nextcloud_notes_get', 'nextcloud_notes_list_categories',
    // Notifications / Activity / Status
    'nextcloud_notifications_list',
    'nextcloud_activity_list', 'nextcloud_activity_list_for_file',
    'nextcloud_status_get',
    // Nextcloud Teams (read-only)
    'nextcloud_teams_list', 'nextcloud_teams_get', 'nextcloud_teams_list_members',
    // Nextcloud unified search / directory (read-only)
    'nextcloud_search', 'nextcloud_list_groups',
    // Nextcloud Talk (read-only additions)
    'nextcloud_talk_get_poll',
    // Nextcloud Tables / Forms (read-only)
    'nextcloud_tables_list', 'nextcloud_tables_list_columns', 'nextcloud_tables_list_rows',
    'nextcloud_forms_list', 'nextcloud_forms_get', 'nextcloud_forms_get_submissions',
    // Nextcloud Files (read-only additions)
    'nextcloud_folder_tree', 'nextcloud_direct_link',
    // Nextcloud Mail (read-only)
    'nextcloud_mail_list_accounts', 'nextcloud_mail_list_mailboxes',
    'nextcloud_mail_search', 'nextcloud_mail_read', 'nextcloud_mail_read_attachment',
    // Webpages (read-only)
    'webpages_list', 'webpage_db_schema', 'webpage_db_query', 'webpage_file_read',
]);

/**
 * Explicit write/side-effect enumeration for every automation-registry tool.
 * NOT consulted by isSideEffect (the fail-closed default already covers
 * these) — it exists so sideEffectMap.test.js can prove every registry tool
 * was consciously classified, instead of a forgotten read silently falling
 * into the simulated bucket.
 *
 * Media generation (image/video/TTS/music/SFX) counts as a side effect even
 * though it mutates nothing of the user's: each call burns paid provider
 * quota, which a dry-run must never do.
 */
const SIDE_EFFECTS = new Set([
    // Gmail
    'gmail_compose', 'gmail_modify_labels', 'gmail_mark_read', 'gmail_mark_unread',
    'gmail_archive', 'gmail_trash', 'gmail_create_draft',
    // Google Calendar / Drive / Docs / Sheets / Slides
    'calendar_create_event', 'calendar_update_event', 'calendar_delete_event',
    'drive_move_file', 'drive_create_folder', 'drive_upload_file',
    'docs_create', 'docs_append', 'docs_replace_text',
    'sheets_append_rows', 'sheets_update_range', 'sheets_create',
    'slides_replace_text', 'slides_create',
    // Contacts / Keep / Groups
    'contacts_create', 'contacts_update',
    'keep_create', 'keep_delete',
    'groups_reply',
    // YouTrack / SignRequest / Gamma / LinkedIn / GitHub
    'youtrack_create_issue', 'youtrack_add_comment', 'youtrack_update_issue',
    'youtrack_link_issues', 'youtrack_change_assignee', 'youtrack_log_work', 'youtrack_manage_tags',
    'signrequest_send_document', 'signrequest_cancel',
    'gamma_create_presentation', 'gamma_create_from_template', 'gamma_revise_as_new',
    'linkedin_create_post',
    'github_create_repo',
    // Outlook / MS
    'outlook_compose',
    'ms_calendar_create_event', 'ms_calendar_update_event', 'ms_calendar_delete_event',
    'onedrive_create_folder',
    'ms_contacts_create', 'ms_contacts_update',
    // Inline geïnjecteerde apps (zie de READ_ONLY-kop hierboven).
    // `browse_web` staat hier BEWUST: hij leest niet alleen, hij bedient een
    // echte browser ("clicking through a cookie wall, expanding sections,
    // following links" — zijn eigen beschrijving), en dat is geen actie die een
    // dry-run ongevraagd voor het echie mag doen.
    'browse_web',
    'notebook_write', 'notebook_replace', 'notebook_insert',
    'regex_add_rules', 'regex_add_collection',
    // KB
    'knowledge_base_ingest',
    // Personal memory (write half) and routine self-evolution. Proposing is a
    // write too: it stores a proposal a human is then asked to approve, and a
    // dry-run that minted those would fill the approval queue with drafts.
    'memory_remember',
    'routine_propose_evolution', 'routine_apply_evolution',
    // Presentations — a .pptx is written into storage (chat) or Nextcloud.
    'create_presentation', 'nextcloud_create_presentation',
    // Nextcloud Files
    'nextcloud_upload_file', 'nextcloud_create_spreadsheet', 'nextcloud_create_document',
    'nextcloud_create_folder', 'nextcloud_delete', 'nextcloud_move', 'nextcloud_copy',
    'nextcloud_create_share', 'nextcloud_share_with_user', 'nextcloud_share_with_group',
    'nextcloud_share_by_email', 'nextcloud_update_share', 'nextcloud_delete_share',
    'nextcloud_add_file_comment', 'nextcloud_create_tag', 'nextcloud_tag_file',
    'nextcloud_untag_file', 'nextcloud_restore_from_trash', 'nextcloud_permanent_delete_trash',
    'nextcloud_restore_version',
    // Nextcloud Calendar / Contacts / Deck / Talk / Tasks / Notes
    'nextcloud_calendar_create_event', 'nextcloud_calendar_update_event', 'nextcloud_calendar_delete_event',
    'nextcloud_contacts_create', 'nextcloud_contacts_update', 'nextcloud_contacts_delete',
    'nextcloud_deck_create_stack', 'nextcloud_deck_update_stack', 'nextcloud_deck_delete_stack',
    'nextcloud_deck_create_card', 'nextcloud_deck_update_card', 'nextcloud_deck_archive_card',
    'nextcloud_deck_delete_card', 'nextcloud_deck_assign_label', 'nextcloud_deck_remove_label',
    'nextcloud_deck_add_comment',
    'nextcloud_talk_create_room', 'nextcloud_talk_start_recording', 'nextcloud_talk_stop_recording',
    'nextcloud_talk_send_message', 'nextcloud_talk_delete_message', 'nextcloud_talk_add_reaction',
    'nextcloud_talk_remove_reaction', 'nextcloud_talk_mark_read',
    'nextcloud_tasks_create', 'nextcloud_tasks_update', 'nextcloud_tasks_complete', 'nextcloud_tasks_delete',
    'nextcloud_notes_create', 'nextcloud_notes_append', 'nextcloud_notes_update', 'nextcloud_notes_delete',
    // Nextcloud Teams (writes)
    'nextcloud_teams_create', 'nextcloud_teams_add_members', 'nextcloud_teams_remove_member',
    'nextcloud_teams_set_member_level', 'nextcloud_teams_update', 'nextcloud_teams_delete',
    'nextcloud_share_with_team',
    // Nextcloud Talk polls + file shares (writes)
    'nextcloud_talk_create_poll', 'nextcloud_talk_vote_poll', 'nextcloud_talk_close_poll',
    'nextcloud_talk_share_file',
    // Nextcloud Tables / Forms (writes)
    'nextcloud_tables_create', 'nextcloud_tables_update', 'nextcloud_tables_delete',
    'nextcloud_tables_create_column', 'nextcloud_tables_delete_column',
    'nextcloud_tables_create_row', 'nextcloud_tables_update_row', 'nextcloud_tables_delete_row',
    'nextcloud_forms_create', 'nextcloud_forms_add_question', 'nextcloud_forms_update_settings',
    'nextcloud_forms_delete',
    // File conversion writes a new file into the user's storage.
    'nextcloud_convert_file',
    // Nextcloud Mail / Notifications / Status
    'nextcloud_mail_save_attachment', 'nextcloud_mail_send', 'nextcloud_mail_set_flags', 'nextcloud_mail_move',
    'nextcloud_notifications_dismiss', 'nextcloud_notifications_dismiss_all', 'nextcloud_notifications_send',
    'nextcloud_status_set', 'nextcloud_status_clear', 'nextcloud_status_set_predefined',
    // n8n (writes / executions)
    'n8n_workflow_create', 'n8n_workflow_update', 'n8n_workflow_patch', 'n8n_workflow_delete',
    'n8n_workflow_activate', 'n8n_workflow_deactivate', 'n8n_workflow_execute',
    'n8n_execution_retry', 'n8n_execution_stop',
    // Webpages (writes)
    'webpage_db_exec', 'webpage_file_write', 'webpage_file_replace', 'webpage_file_patch',
    'webpage_set_metadata', 'webpage_create',
    // Media generation (paid provider quota)
    'generate_image', 'generate_video',
    'elevenlabs_music', 'elevenlabs_tts', 'elevenlabs_sfx',
]);

/**
 * Returns true when calling this tool produces a user-visible side-effect.
 * Fail-closed: unlisted tools are treated as side-effecting.
 */
function isSideEffect(toolName) {
    if (!toolName || typeof toolName !== 'string') return true;
    return !READ_ONLY.has(toolName);
}

/**
 * The THIRD class: a write that leaves the building.
 *
 * `isSideEffect` answers "may a dry-run do this for real?" — a two-way split
 * that is exactly right for the runner and too coarse for a person deciding
 * what an agent may do unsupervised. Renaming a file and mailing a customer
 * are both "side effects"; only one of them is unrecallable and addressed to
 * someone outside the workspace. `effectOf` splits that off as `sends`, and
 * the agent confirm policy hangs on it: `sends` is ALWAYS confirmed, whatever
 * a stored config says (core/agentRuntime/toolPolicy.js).
 *
 * SENDS is a strict SUBSET of SIDE_EFFECTS — a test pins that, because a name
 * here that the completeness check does not also see would be a write nobody
 * classified.
 *
 * Calendar creates/updates are in, by name, even though the invitation only
 * goes out when the event carries attendees: `effectOf` is a NAME-level
 * question asked at config time, where the arguments do not exist yet, and the
 * conservative answer is the only honest one. It also matches what the product
 * already does — a calendar write from agent chat has always come back as a
 * `calendar_draft` card for approval.
 *
 * NOT here on purpose: `gmail_create_draft` (a draft is the opposite of a
 * send), comment/annotation writes (they notify watchers, but the artefact is
 * inside the workspace) and file shares that mint a link rather than address a
 * person. Link-by-email shares (`nextcloud_share_by_email`) ARE here.
 */
const SENDS = new Set([
    // Mail — a message addressed to a person, gone the moment it returns.
    'gmail_compose',
    'outlook_compose',
    'nextcloud_mail_send',
    'nextcloud_share_by_email',
    // Group / channel posts.
    'groups_reply',
    'nextcloud_talk_send_message',
    'nextcloud_talk_share_file',
    'linkedin_create_post',
    // Notifications delivered to other people's devices.
    'nextcloud_notifications_send',
    // Calendar invitations (see the docblock: name-level, so conservative).
    'calendar_create_event', 'calendar_update_event',
    'ms_calendar_create_event', 'ms_calendar_update_event',
    'nextcloud_calendar_create_event', 'nextcloud_calendar_update_event',
    // A signature request is mailed to the signer.
    'signrequest_send_document',
]);

/** The three effect classes, weakest first. */
const EFFECTS = Object.freeze(['reads', 'writes', 'sends']);

/**
 * Classify a tool name as `reads` | `writes` | `sends`.
 *
 * Fail-closed on `writes`: an unknown name is never a read. That is the same
 * posture `isSideEffect` takes and for the same reason — the cost of calling a
 * write a read is silent, and the cost of the reverse is one extra click.
 */
function effectOf(toolName) {
    if (!toolName || typeof toolName !== 'string') return 'writes';
    if (SENDS.has(toolName)) return 'sends';
    if (READ_ONLY.has(toolName)) return 'reads';
    return 'writes';
}

/** Rank for "max over the steps" style aggregation. */
function effectRank(effect) {
    const i = EFFECTS.indexOf(effect);
    return i === -1 ? 1 : i;         // unknown ⇒ writes
}

/**
 * The strongest of a list of effects (`reads` when the list is empty).
 *
 * Unrecognised entries are normalised to `writes` rather than carried through:
 * returning the caller's own junk string would put it in a UI label and,
 * worse, past a `=== 'sends'` policy check that only knows the three names.
 */
function maxEffect(effects) {
    let best = 'reads';
    for (const e of effects || []) {
        const normalised = EFFECTS.includes(e) ? e : 'writes';
        if (effectRank(normalised) > effectRank(best)) best = normalised;
    }
    return best;
}

/**
 * Read-only tools that are still NOT safe to answer twice from one memo.
 *
 * "Read-only" and "gives the same answer twice" are different questions, and
 * conflating them is how a status board freezes for five minutes.
 *
 * Every name below is in READ_ONLY above — a test asserts it, because an entry
 * here that is not read-only would be dead weight hiding a real bug.
 */
const NEVER_MEMO = new Set([
    // Inherently time-varying: asking again IS the point.
    'nextcloud_status_get',
    'nextcloud_notifications_list',
    'nextcloud_activity_list',
    'nextcloud_activity_list_for_file',
    'n8n_execution_list',
    'n8n_execution_get',
    'n8n_execution_get_detail',
]);

/**
 * Whole families where the DISPATCH is the enforcement point, so answering from
 * a memo would skip a live authorisation check.
 *
 * Every nextcloud_* call passes ncScopeGuard.checkToolCall at dispatch. That is
 * a DENY gate, not merely a result filter, and its own scope memo is
 * deliberately 15 SECONDS because scopes change. Serving a 5-minute memo would
 * widen an authorisation decision's staleness twentyfold.
 *
 * A prefix rather than a name list on purpose: there are ~60 nextcloud reads and
 * more arrive with every release, so an enumeration would silently fall behind.
 * Revisit only with a scope fingerprint in the memo key.
 */
const NEVER_MEMO_PREFIXES = ['nextcloud_'];

/**
 * May this tool's answer be reused within one run? Fail-closed three times
 * over: a write is never eligible, an unclassifiable name is never eligible,
 * and a family whose dispatch carries the permission check is never eligible.
 */
function isMemoisable(toolName) {
    if (!toolName || typeof toolName !== 'string') return false;
    if (isSideEffect(toolName)) return false;          // fail-closed for unknowns too
    if (NEVER_MEMO.has(toolName)) return false;
    return !NEVER_MEMO_PREFIXES.some(p => toolName.startsWith(p));
}

module.exports = {
    isSideEffect, isMemoisable, READ_ONLY, SIDE_EFFECTS, NEVER_MEMO, NEVER_MEMO_PREFIXES,
    SENDS, EFFECTS, effectOf, effectRank, maxEffect,
};
