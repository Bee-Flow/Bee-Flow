/**
 * facts.mts: the language-neutral half of the public integration pages
 * (/integrations/<id>, core/seo/integrationsDirectory.js).
 *
 * Per integration: which toolset carries its tools (a key of the toolset map
 * the route hands in, integrations/coreToolsets plus the media tools), how
 * those tools are grouped into the plain-language lines a page shows, which
 * automation events belong to it (rules over the trigger-source registry,
 * automation/triggerSources) and which pages it links to.
 *
 * Nothing here is shown as written. The page asks the shipped catalogues at
 * render time: a tool or an event that no longer exists is simply not shown,
 * and content.test.js fails on a name in here that the catalogues do not know,
 * so the website cannot promise a tool the product does not ship.
 */

/** One plain-language line on a page: the prose for `key` (per language) and the tools behind it. */
export interface ToolGroup { key: string; tools: readonly string[] }

/** Events of one trigger provider; `prefix` narrows them (the Nextcloud and Microsoft providers serve several apps). */
export interface EventRule { provider: string; prefix?: string }

export interface IntegrationFacts {
    /** Key of the toolset map (e.g. `GMAIL_TOOLS`). */
    toolset: string;
    groups: readonly ToolGroup[];
    events?: readonly EventRule[];
    /** Integrations linked first under "Related"; category siblings fill up the rest. */
    related?: readonly string[];
    /** Tools come through the Nextcloud integration (connector or the user's own sign-in). */
    nextcloud?: boolean;
    /** false: no read/write section (a generator has no data of yours to read or change). */
    effects?: false;
}

const g = (key: string, ...tools: string[]): ToolGroup => ({ key, tools });

const GOOGLE: Record<string, IntegrationFacts> = {
    gmail: {
        toolset: 'GMAIL_TOOLS',
        groups: [
            g('find', 'gmail_search', 'gmail_read', 'gmail_read_many', 'gmail_read_attachment'),
            g('write', 'gmail_compose', 'gmail_create_draft', 'gmail_reply_in_thread'),
            g('sort', 'gmail_list_labels', 'gmail_modify_labels', 'gmail_mark_read', 'gmail_mark_unread', 'gmail_archive', 'gmail_trash', 'gmail_bulk_modify'),
        ],
        events: [{ provider: 'gmail' }],
        related: ['google-calendar', 'google-drive', 'outlook', 'nextcloud-mail'],
    },
    'google-calendar': {
        toolset: 'CALENDAR_TOOLS',
        groups: [
            g('read', 'calendar_list_events', 'calendar_search_events'),
            g('change', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event'),
        ],
        events: [{ provider: 'google-calendar' }],
        related: ['gmail', 'ms-calendar', 'nextcloud-calendar'],
    },
    'google-drive': {
        toolset: 'DRIVE_TOOLS',
        groups: [
            g('find', 'drive_search', 'drive_list_files', 'drive_list_recent', 'drive_get_file'),
            g('read', 'drive_get_content'),
            g('organise', 'drive_move_file', 'drive_create_folder', 'drive_upload_file'),
        ],
        events: [{ provider: 'google-drive' }],
        related: ['google-docs', 'google-sheets', 'onedrive', 'nextcloud'],
    },
    'google-slides': {
        toolset: 'SLIDES_TOOLS',
        groups: [
            g('read', 'slides_list', 'slides_get'),
            g('make', 'slides_create', 'slides_replace_text'),
            g('export', 'slides_export_pdf'),
        ],
        events: [{ provider: 'google-slides' }],
        related: ['google-drive', 'gamma'],
    },
    'google-sheets': {
        toolset: 'SHEETS_TOOLS',
        groups: [
            g('read', 'sheets_list', 'sheets_list_tabs', 'sheets_get_values'),
            g('write', 'sheets_append_rows', 'sheets_update_range', 'sheets_create'),
        ],
        events: [{ provider: 'google-sheets' }],
        related: ['google-drive', 'nextcloud-tables'],
    },
    'google-docs': {
        toolset: 'DOCS_TOOLS',
        groups: [
            g('read', 'docs_read'),
            g('write', 'docs_create', 'docs_append', 'docs_replace_text'),
        ],
        related: ['google-drive', 'google-sheets'],
    },
    'google-contacts': {
        toolset: 'CONTACTS_TOOLS',
        groups: [
            g('find', 'contacts_search', 'contacts_list'),
            g('change', 'contacts_create', 'contacts_update'),
        ],
        events: [{ provider: 'google-contacts' }],
        related: ['gmail', 'ms-contacts', 'nextcloud-contacts'],
    },
    'google-keep': {
        toolset: 'KEEP_TOOLS',
        groups: [
            g('read', 'keep_list', 'keep_get'),
            g('change', 'keep_create', 'keep_delete'),
        ],
        events: [{ provider: 'google-keep' }],
        related: ['nextcloud-notes', 'google-docs'],
    },
    'google-groups': {
        toolset: 'GOOGLE_GROUPS_TOOLS',
        groups: [
            g('read', 'groups_list_conversations', 'groups_read_conversation'),
            g('reply', 'groups_reply'),
        ],
        related: ['gmail'],
    },
    maps: {
        toolset: 'MAPS_TOOLS',
        groups: [
            g('places', 'maps_search_places'),
            g('route', 'maps_directions'),
        ],
        related: ['google-calendar'],
    },
};

const MICROSOFT: Record<string, IntegrationFacts> = {
    outlook: {
        toolset: 'OUTLOOK_TOOLS',
        groups: [
            g('find', 'outlook_search', 'outlook_list_recent', 'outlook_read', 'outlook_read_many'),
            g('write', 'outlook_compose', 'outlook_create_draft', 'outlook_reply_in_thread'),
        ],
        events: [{ provider: 'msgraph', prefix: 'mail.' }],
        related: ['outlook-readonly', 'ms-calendar', 'gmail'],
    },
    'outlook-readonly': {
        toolset: 'OUTLOOK_READONLY_TOOLS',
        groups: [g('find', 'outlook_search', 'outlook_list_recent', 'outlook_read', 'outlook_read_many')],
        events: [{ provider: 'msgraph', prefix: 'mail.' }],
        related: ['outlook', 'ms-calendar'],
    },
    'ms-calendar': {
        toolset: 'MS_CALENDAR_TOOLS',
        groups: [
            g('read', 'ms_calendar_list_events', 'ms_calendar_search_events'),
            g('change', 'ms_calendar_create_event', 'ms_calendar_update_event', 'ms_calendar_delete_event'),
        ],
        events: [{ provider: 'msgraph', prefix: 'event.' }],
        related: ['outlook', 'google-calendar', 'nextcloud-calendar'],
    },
    onedrive: {
        toolset: 'ONEDRIVE_TOOLS',
        groups: [
            g('find', 'onedrive_search', 'onedrive_list_files', 'onedrive_list_recent', 'onedrive_get_file'),
            g('organise', 'onedrive_create_folder'),
        ],
        events: [{ provider: 'msgraph', prefix: 'file.' }],
        related: ['outlook', 'google-drive', 'nextcloud'],
    },
    'ms-contacts': {
        toolset: 'MS_CONTACTS_TOOLS',
        groups: [
            g('find', 'ms_contacts_search', 'ms_contacts_list'),
            g('change', 'ms_contacts_create', 'ms_contacts_update'),
        ],
        related: ['outlook', 'google-contacts', 'nextcloud-contacts'],
    },
};

const MEDIA: Record<string, IntegrationFacts> = {
    // music-gen has no entry: no tool of it is offered to a chat, agent or automation today
    // (routes/ai/musicGenTool.js holds an executor only), so its page keeps the catalogue line.
    'image-gen': { toolset: 'IMAGE_GEN_TOOLS', effects: false, groups: [g('make', 'generate_image')], related: ['video-gen', 'elevenlabs'] },
    'video-gen': { toolset: 'VIDEO_GEN_TOOLS', effects: false, groups: [g('make', 'generate_video')], related: ['image-gen', 'elevenlabs'] },
    elevenlabs: {
        toolset: 'ELEVENLABS_TOOLS',
        effects: false,
        groups: [g('music', 'elevenlabs_music'), g('speech', 'elevenlabs_tts'), g('sfx', 'elevenlabs_sfx')],
        related: ['image-gen', 'transcription'],
    },
    'agent-search': {
        toolset: 'AGENT_SEARCH_TOOLS',
        groups: [g('search', 'agent_search'), g('read', 'read_url')],
        related: ['browser-fetch', 'kb-search'],
    },
    'browser-fetch': { toolset: 'BROWSE_WEB_TOOLS', effects: false, groups: [g('browse', 'browse_web')], related: ['agent-search'] },
    transcription: { toolset: 'TRANSCRIPTION_TOOLS', groups: [g('transcribe', 'transcribe_audio')], related: ['fireflies', 'elevenlabs'] },
    'kb-search': { toolset: 'KB_SEARCH_TOOLS', groups: [g('search', 'kb_search'), g('original', 'kb_get_original')], related: ['agent-search', 'nextcloud'] },
};

const BUSINESS: Record<string, IntegrationFacts> = {
    fireflies: {
        toolset: 'FIREFLIES_TOOLS',
        groups: [g('find', 'fireflies_list_transcripts'), g('read', 'fireflies_get_summary', 'fireflies_get_transcript')],
        related: ['transcription', 'nextcloud-talk'],
    },
    gamma: {
        toolset: 'GAMMA_TOOLS',
        groups: [
            g('make', 'gamma_create_presentation', 'gamma_create_from_template', 'gamma_revise_as_new'),
            g('status', 'gamma_get_generation_status'),
            g('pick', 'gamma_list_themes', 'gamma_list_folders'),
        ],
        related: ['google-slides'],
    },
    signrequest: {
        toolset: 'SIGNREQUEST_TOOLS',
        groups: [
            g('send', 'signrequest_send_document'),
            g('follow', 'signrequest_check_status', 'signrequest_list_documents'),
            g('cancel', 'signrequest_cancel'),
        ],
        related: ['nextcloud', 'google-drive'],
    },
    'afas-profit': {
        toolset: 'AFAS_TOOLS',
        groups: [g('discover', 'afas_list_connectors', 'afas_describe_connector'), g('query', 'afas_query')],
        related: ['nmbrs', 'firebird', 'vplan'],
    },
    nmbrs: {
        toolset: 'NMBRS_TOOLS',
        groups: [
            g('structure', 'nmbrs_list_debtors', 'nmbrs_list_companies', 'nmbrs_list_employees', 'nmbrs_get_employee'),
            g('employee', 'nmbrs_list_employee_contracts', 'nmbrs_list_employee_salaries', 'nmbrs_list_employee_wage_components', 'nmbrs_list_payslips'),
            g('company', 'nmbrs_list_company_employments', 'nmbrs_list_company_contracts', 'nmbrs_list_company_salaries', 'nmbrs_list_company_personal_info', 'nmbrs_list_company_lease_cars', 'nmbrs_list_company_svw_settings'),
            g('runs', 'nmbrs_list_company_runs', 'nmbrs_get_company_run_payslips'),
        ],
        related: ['afas-profit', 'vplan'],
    },
    vplan: {
        toolset: 'VPLAN_TOOLS',
        groups: [
            g('planning', 'vplan_list_boards', 'vplan_list_cards', 'vplan_get_card', 'vplan_list_collections', 'vplan_get_collection'),
            g('capacity', 'vplan_list_resources', 'vplan_get_resource_availability', 'vplan_get_capacity'),
            g('hours', 'vplan_list_time_tracking', 'vplan_time_tracking_summary', 'vplan_list_activities'),
            g('orders', 'vplan_list_orders', 'vplan_get_order', 'vplan_list_master_data'),
            g('check', 'vplan_whoami'),
        ],
        related: ['afas-profit', 'nmbrs', 'firebird'],
    },
    firebird: {
        toolset: 'FIREBIRD_TOOLS',
        groups: [
            g('explore', 'firebird_list_tables', 'firebird_describe_table', 'firebird_sample_rows'),
            g('query', 'firebird_query'),
            g('check', 'firebird_whoami'),
        ],
        related: ['afas-profit', 'vplan'],
    },
    'frappe-crm': {
        toolset: 'FRAPPE_CRM_TOOLS',
        groups: [
            g('read', 'frappe_crm_list_leads', 'frappe_crm_get_lead', 'frappe_crm_list_deals', 'frappe_crm_get_deal',
                'frappe_crm_list_contacts', 'frappe_crm_get_contact', 'frappe_crm_list_organizations', 'frappe_crm_get_organization'),
            g('follow', 'frappe_crm_list_tasks', 'frappe_crm_list_notes', 'frappe_crm_list_statuses'),
            g('write', 'frappe_crm_create_lead', 'frappe_crm_update_lead', 'frappe_crm_create_deal', 'frappe_crm_update_deal',
                'frappe_crm_add_note', 'frappe_crm_create_task'),
        ],
        related: ['gmail', 'outlook'],
    },
    'scaleway-billing': {
        toolset: 'SCALEWAY_BILLING_TOOLS',
        groups: [g('list', 'scaleway_list_invoices'), g('download', 'scaleway_download_invoice')],
        events: [{ provider: 'scaleway-billing' }],
        related: ['nextcloud', 'google-drive'],
    },
    youtrack: {
        toolset: 'YOUTRACK_TOOLS',
        groups: [
            g('find', 'youtrack_list_projects', 'youtrack_search_issues', 'youtrack_get_issue', 'youtrack_get_issue_comments', 'youtrack_find_user'),
            g('change', 'youtrack_create_issue', 'youtrack_update_issue', 'youtrack_add_comment', 'youtrack_change_assignee',
                'youtrack_link_issues', 'youtrack_manage_tags', 'youtrack_log_work'),
        ],
        related: ['github', 'nextcloud-deck'],
    },
    github: {
        toolset: 'GITHUB_TOOLS',
        groups: [
            g('read', 'github_list_repos', 'github_get_repo', 'github_list_branches', 'github_list_contents', 'github_get_file'),
            g('create', 'github_create_repo'),
        ],
        related: ['youtrack'],
    },
    n8n: {
        toolset: 'N8N_WORKFLOW_TOOLS',
        groups: [
            g('read', 'n8n_workflow_list', 'n8n_workflow_get', 'n8n_workflow_nodes_find', 'n8n_execution_list', 'n8n_execution_get', 'n8n_execution_get_detail'),
            g('edit', 'n8n_workflow_create', 'n8n_workflow_update', 'n8n_workflow_patch', 'n8n_workflow_delete'),
            g('run', 'n8n_workflow_activate', 'n8n_workflow_deactivate', 'n8n_workflow_execute', 'n8n_execution_retry', 'n8n_execution_stop'),
        ],
        related: ['webpages'],
    },
    webpages: {
        toolset: 'WEBPAGE_AUTOMATION_TOOLS',
        groups: [
            g('data', 'webpage_db_schema', 'webpage_db_query', 'webpage_db_exec'),
            g('files', 'webpages_list', 'webpage_file_read', 'webpage_file_write', 'webpage_file_replace', 'webpage_file_patch'),
            g('create', 'webpage_create', 'webpage_set_metadata'),
        ],
        related: ['n8n'],
    },
    linkedin: { toolset: 'LINKEDIN_TOOLS', groups: [g('post', 'linkedin_create_post')], related: ['image-gen'] },
    withings: {
        toolset: 'WITHINGS_TOOLS',
        groups: [g('body', 'withings_get_measures'), g('sleep', 'withings_get_sleep_summary'), g('activity', 'withings_get_activity')],
    },
};

const nc = (toolset: string, groups: ToolGroup[], prefix: string | null, related: string[]): IntegrationFacts => ({
    toolset, groups, nextcloud: true, related,
    ...(prefix === null ? {} : { events: [{ provider: 'nextcloud', prefix }] }),
});

const NEXTCLOUD: Record<string, IntegrationFacts> = {
    nextcloud: {
        toolset: 'NEXTCLOUD_TOOLS',
        nextcloud: true,
        groups: [
            g('find', 'nextcloud_list_files', 'nextcloud_search_files', 'nextcloud_folder_tree', 'nextcloud_search', 'nextcloud_read_file'),
            g('create', 'nextcloud_upload_file', 'nextcloud_create_document', 'nextcloud_create_spreadsheet', 'nextcloud_create_presentation', 'nextcloud_convert_file'),
            g('organise', 'nextcloud_create_folder', 'nextcloud_move', 'nextcloud_copy', 'nextcloud_delete',
                'nextcloud_list_tags', 'nextcloud_create_tag', 'nextcloud_tag_file', 'nextcloud_untag_file', 'nextcloud_find_files_by_tag'),
            g('share', 'nextcloud_list_groups', 'nextcloud_create_share', 'nextcloud_share_with_user', 'nextcloud_share_with_group',
                'nextcloud_share_by_email', 'nextcloud_list_shares', 'nextcloud_update_share', 'nextcloud_delete_share', 'nextcloud_direct_link'),
            g('comments', 'nextcloud_list_file_comments', 'nextcloud_add_file_comment'),
            g('restore', 'nextcloud_list_trash', 'nextcloud_restore_from_trash', 'nextcloud_permanent_delete_trash', 'nextcloud_list_versions', 'nextcloud_restore_version'),
        ],
        events: [{ provider: 'nextcloud', prefix: 'file.' }, { provider: 'nextcloud', prefix: 'share.' }],
        related: ['nextcloud-activity', 'nextcloud-talk', 'nextcloud-tables', 'google-drive', 'onedrive'],
    },
    'nextcloud-calendar': nc('NEXTCLOUD_CALENDAR_TOOLS', [
        g('read', 'nextcloud_calendar_list', 'nextcloud_calendar_list_events', 'nextcloud_calendar_search_events', 'nextcloud_calendar_get_event'),
        g('change', 'nextcloud_calendar_create_event', 'nextcloud_calendar_update_event', 'nextcloud_calendar_delete_event'),
    ], 'calendar.', ['nextcloud-tasks', 'google-calendar', 'ms-calendar']),
    'nextcloud-contacts': nc('NEXTCLOUD_CONTACTS_TOOLS', [
        g('find', 'nextcloud_contacts_list_addressbooks', 'nextcloud_contacts_list', 'nextcloud_contacts_search', 'nextcloud_contacts_get'),
        g('change', 'nextcloud_contacts_create', 'nextcloud_contacts_update', 'nextcloud_contacts_delete'),
    ], null, ['nextcloud-mail', 'google-contacts', 'ms-contacts']),
    'nextcloud-deck': nc('NEXTCLOUD_DECK_TOOLS', [
        g('read', 'nextcloud_deck_list_boards', 'nextcloud_deck_get_board', 'nextcloud_deck_list_stacks', 'nextcloud_deck_list_cards',
            'nextcloud_deck_search_cards', 'nextcloud_deck_get_card', 'nextcloud_deck_list_comments'),
        g('cards', 'nextcloud_deck_create_card', 'nextcloud_deck_update_card', 'nextcloud_deck_archive_card', 'nextcloud_deck_delete_card',
            'nextcloud_deck_assign_label', 'nextcloud_deck_remove_label', 'nextcloud_deck_add_comment'),
        g('board', 'nextcloud_deck_create_stack', 'nextcloud_deck_update_stack', 'nextcloud_deck_delete_stack'),
    ], 'deck.', ['nextcloud-tasks', 'nextcloud-talk', 'youtrack']),
    'nextcloud-mail': nc('NEXTCLOUD_MAIL_TOOLS', [
        g('read', 'nextcloud_mail_list_accounts', 'nextcloud_mail_list_mailboxes', 'nextcloud_mail_search', 'nextcloud_mail_read', 'nextcloud_mail_read_attachment'),
        g('send', 'nextcloud_mail_send'),
        g('sort', 'nextcloud_mail_set_flags', 'nextcloud_mail_move', 'nextcloud_mail_save_attachment'),
    ], null, ['nextcloud-contacts', 'nextcloud', 'gmail', 'outlook']),
    'nextcloud-notifications': nc('NEXTCLOUD_NOTIFICATIONS_TOOLS', [
        g('read', 'nextcloud_notifications_list'),
        g('dismiss', 'nextcloud_notifications_dismiss', 'nextcloud_notifications_dismiss_all'),
        g('send', 'nextcloud_notifications_send'),
    ], 'notification.', ['nextcloud-activity', 'nextcloud-talk']),
    'nextcloud-talk': nc('NEXTCLOUD_TALK_TOOLS', [
        g('read', 'nextcloud_talk_list_rooms', 'nextcloud_talk_get_room', 'nextcloud_talk_list_participants', 'nextcloud_talk_list_messages', 'nextcloud_talk_search_messages'),
        g('post', 'nextcloud_talk_send_message', 'nextcloud_talk_share_file', 'nextcloud_talk_add_reaction', 'nextcloud_talk_remove_reaction',
            'nextcloud_talk_delete_message', 'nextcloud_talk_mark_read'),
        g('polls', 'nextcloud_talk_create_poll', 'nextcloud_talk_get_poll', 'nextcloud_talk_vote_poll', 'nextcloud_talk_close_poll'),
        g('rooms', 'nextcloud_talk_create_room', 'nextcloud_talk_start_recording', 'nextcloud_talk_stop_recording'),
    ], 'talk.', ['nextcloud-deck', 'nextcloud-notifications', 'fireflies']),
    'nextcloud-tasks': nc('NEXTCLOUD_TASKS_TOOLS', [
        g('read', 'nextcloud_tasks_list_lists', 'nextcloud_tasks_list', 'nextcloud_tasks_search', 'nextcloud_tasks_get'),
        g('change', 'nextcloud_tasks_create', 'nextcloud_tasks_update', 'nextcloud_tasks_complete', 'nextcloud_tasks_delete'),
    ], null, ['nextcloud-calendar', 'nextcloud-deck']),
    'nextcloud-notes': nc('NEXTCLOUD_NOTES_TOOLS', [
        g('read', 'nextcloud_notes_list', 'nextcloud_notes_search', 'nextcloud_notes_get', 'nextcloud_notes_list_categories'),
        g('change', 'nextcloud_notes_create', 'nextcloud_notes_append', 'nextcloud_notes_update', 'nextcloud_notes_delete'),
    ], null, ['nextcloud-tasks', 'google-keep']),
    'nextcloud-activity': nc('NEXTCLOUD_ACTIVITY_TOOLS', [
        g('read', 'nextcloud_activity_list', 'nextcloud_activity_list_for_file'),
    ], 'activity.', ['nextcloud', 'nextcloud-notifications']),
    'nextcloud-tables': nc('NEXTCLOUD_TABLES_TOOLS', [
        g('read', 'nextcloud_tables_list', 'nextcloud_tables_list_columns', 'nextcloud_tables_list_rows'),
        g('rows', 'nextcloud_tables_create_row', 'nextcloud_tables_update_row', 'nextcloud_tables_delete_row'),
        g('shape', 'nextcloud_tables_create', 'nextcloud_tables_update', 'nextcloud_tables_delete', 'nextcloud_tables_create_column', 'nextcloud_tables_delete_column'),
    ], 'tables.', ['nextcloud-forms', 'google-sheets']),
    'nextcloud-forms': nc('NEXTCLOUD_FORMS_TOOLS', [
        g('read', 'nextcloud_forms_list', 'nextcloud_forms_get', 'nextcloud_forms_get_submissions'),
        g('build', 'nextcloud_forms_create', 'nextcloud_forms_add_question', 'nextcloud_forms_update_settings', 'nextcloud_forms_delete'),
    ], 'forms.', ['nextcloud-tables', 'nextcloud-deck']),
    'nextcloud-teams': nc('NEXTCLOUD_TEAMS_TOOLS', [
        g('read', 'nextcloud_teams_list', 'nextcloud_teams_get', 'nextcloud_teams_list_members'),
        g('manage', 'nextcloud_teams_create', 'nextcloud_teams_add_members', 'nextcloud_teams_remove_member',
            'nextcloud_teams_set_member_level', 'nextcloud_teams_update', 'nextcloud_teams_delete'),
        g('share', 'nextcloud_share_with_team'),
    ], null, ['nextcloud', 'nextcloud-talk']),
    'nextcloud-status': nc('NEXTCLOUD_STATUS_TOOLS', [
        g('read', 'nextcloud_status_get'),
        g('set', 'nextcloud_status_set', 'nextcloud_status_set_predefined', 'nextcloud_status_clear'),
    ], null, ['nextcloud-calendar', 'nextcloud-talk']),
};

/** Every integration that has a page with content, by catalogue id. */
export const FACTS: Readonly<Record<string, IntegrationFacts>> = Object.freeze({
    ...GOOGLE, ...MICROSOFT, ...MEDIA, ...BUSINESS, ...NEXTCLOUD,
});
