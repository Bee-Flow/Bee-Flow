/**
 * The English namespaces each public feature demo renders (issue #252).
 *
 * The demo is its own document, so it used to download the whole 3.9 MB English
 * catalogue for a few dozen keys. It now loads just these. The lists were taken
 * from the string literals in each demo's import closure and are deliberately
 * generous; a namespace left out is harmless, because t() falls back to the
 * English written at the call site. A demo with no entry loads everything.
 */
export const DEMO_NAMESPACES: Record<string, string[]> = {
    automations: [
        'admin', 'agent', 'agent_schedules', 'agent_skills', 'agent_studio', 'agent_usage',
        'agent_wizard', 'app', 'app_studio', 'approvals', 'apps', 'automation_editor',
        'automations', 'chat', 'chat_monitoring', 'cms_site', 'code_step', 'comments', 'common',
        'compliance', 'condition_node', 'connections', 'cowork', 'datatables', 'dlp', 'documents',
        'editor', 'encryption', 'error', 'flatten_node', 'forms', 'http_query', 'knowledge',
        'license', 'managed_part', 'meeting_notes', 'meetings', 'modules', 'notebooks', 'org',
        'pii', 'playbooks', 'privacy', 'project_chat', 'project_home', 'project_tasks', 'projects',
        'run_status', 'runs', 'settings', 'sidebar', 'skill_form', 'skills', 'skills_studio',
        'solution_stages', 'solutions', 'spreadsheet', 'stage_settings', 'studio', 'studio_apps_bi',
        'studio_apps_edit', 'studio_apps_insp', 'studio_apps_panels', 'studio_apps_runtime',
        'studio_apps_tables', 'studio_misc', 'suggestions', 'support', 'tier', 'time', 'training',
        'usage', 'versions', 'visibility', 'webpages',
    ],
    'privacy-shield': [
        'admin', 'common', 'dlp', 'egress_map', 'error', 'forms', 'license', 'org', 'pii',
        'privacy', 'shield_activity', 'shield_checks', 'shield_data', 'shield_look',
        'shield_overview', 'shield_shell', 'time', 'usage',
    ],
    agents: [
        'admin', 'agent', 'agent_schedules', 'agent_studio', 'agent_usage', 'agent_wizard', 'chat',
        'common', 'compliance', 'error', 'knowledge', 'license', 'managed_part', 'notebooks', 'org',
        'skills_studio', 'studio', 'tier', 'time', 'usage', 'visibility',
    ],
    notebooks: [
        'admin', 'agent', 'agent_skills', 'agent_studio', 'apps', 'automations', 'chat',
        'chat_monitoring', 'comments', 'common', 'compliance', 'cowork', 'dlp', 'documents',
        'editor', 'encryption', 'error', 'license', 'managed_part', 'notebooks', 'org', 'privacy',
        'project_chat', 'project_home', 'project_tasks', 'settings', 'skill_form', 'skills',
        'spreadsheet', 'studio', 'suggestions', 'tier', 'time', 'usage', 'versions',
    ],
    'meeting-notes': [
        'admin', 'agent_studio', 'chat', 'common', 'compliance', 'condition_node', 'datatables',
        'dlp', 'error', 'license', 'meeting_notes', 'meetings', 'notebooks', 'org', 'privacy',
        'studio', 'studio_misc', 'tier', 'time', 'usage', 'visibility',
    ],
    support: [
        'admin', 'admin_monitoring', 'common', 'error', 'license', 'org', 'studio', 'studio_misc',
        'support',
    ],
    skills: [
        'admin', 'agent', 'agent_schedules', 'agent_skills', 'agent_studio', 'agent_usage',
        'agent_wizard', 'app', 'app_studio', 'approvals', 'apps', 'automation_editor',
        'automations', 'chat', 'chat_monitoring', 'cms_site', 'code_step', 'comments', 'common',
        'compliance', 'condition_node', 'connections', 'cowork', 'datatables', 'dlp', 'documents',
        'editor', 'encryption', 'error', 'flatten_node', 'forms', 'http_query', 'knowledge',
        'license', 'managed_part', 'meeting_notes', 'meetings', 'modules', 'notebooks', 'org',
        'pii', 'playbooks', 'privacy', 'project_chat', 'project_home', 'project_tasks', 'projects',
        'run_status', 'runs', 'settings', 'sidebar', 'skill_form', 'skills', 'skills_studio',
        'solution_stages', 'solutions', 'spreadsheet', 'stage_settings', 'studio', 'studio_apps_bi',
        'studio_apps_edit', 'studio_apps_insp', 'studio_apps_panels', 'studio_apps_runtime',
        'studio_apps_tables', 'studio_misc', 'suggestions', 'support', 'tier', 'time', 'training',
        'usage', 'versions', 'visibility', 'webpages',
    ],
    knowledge: [
        'admin', 'agent', 'agent_studio', 'agent_wizard', 'chat', 'common', 'datatables', 'error',
        'knowledge', 'license', 'notebooks', 'org', 'skills_studio', 'studio', 'studio_misc',
        'time', 'usage', 'visibility',
    ],
    monitoring: [
        'admin', 'chat', 'common', 'error', 'license', 'org', 'tier', 'usage',
    ],
    compliance: [
        'admin', 'admin_shared', 'chat_monitoring', 'common', 'compliance', 'error', 'license',
        'org', 'settings', 'studio', 'training',
    ],
    'app-studio': [
        'admin', 'agent', 'agent_schedules', 'agent_skills', 'agent_studio', 'agent_usage',
        'agent_wizard', 'app', 'app_studio', 'approvals', 'apps', 'automation_editor',
        'automations', 'chat', 'chat_monitoring', 'cms_site', 'code_step', 'comments', 'common',
        'compliance', 'condition_node', 'connections', 'cowork', 'datatables', 'dlp', 'documents',
        'editor', 'encryption', 'error', 'flatten_node', 'forms', 'http_query', 'knowledge',
        'license', 'managed_part', 'meeting_notes', 'meetings', 'modules', 'notebooks', 'org',
        'pii', 'playbooks', 'privacy', 'project_chat', 'project_home', 'project_tasks', 'projects',
        'run_status', 'runs', 'settings', 'sidebar', 'skill_form', 'skills', 'skills_studio',
        'solution_stages', 'solutions', 'spreadsheet', 'stage_settings', 'studio', 'studio_apps_bi',
        'studio_apps_edit', 'studio_apps_insp', 'studio_apps_panels', 'studio_apps_runtime',
        'studio_apps_tables', 'studio_misc', 'suggestions', 'support', 'tier', 'time', 'training',
        'usage', 'versions', 'visibility', 'webpages',
    ],
};

export function namespacesForDemo(featureId: string): string[] | undefined {
    return Object.prototype.hasOwnProperty.call(DEMO_NAMESPACES, featureId) ? DEMO_NAMESPACES[featureId] : undefined;
}

/** The namespaces for the demo the document is showing, from its /__demo__/<id> address. */
export function namespacesForPath(pathname: unknown): string[] | undefined {
    if (typeof pathname !== 'string') return undefined;
    const match = pathname.match(/^\/__demo__\/([a-z0-9-]+)\/?$/);
    return match ? namespacesForDemo(match[1]) : undefined;
}
