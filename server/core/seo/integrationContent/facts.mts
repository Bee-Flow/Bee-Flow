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

import { g, type IntegrationFacts } from './factsShape.mts';
import { NEXTCLOUD } from './factsNextcloud.mts';

export type { EventRule, IntegrationFacts, ToolGroup } from './factsShape.mts';

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

/** Every integration that has a page with content, by catalogue id. */
export const FACTS: Readonly<Record<string, IntegrationFacts>> = Object.freeze({
    ...GOOGLE, ...MICROSOFT, ...MEDIA, ...BUSINESS, ...NEXTCLOUD,
});
