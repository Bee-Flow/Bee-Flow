/**
 * Where a catalog app sits in the step picker's Action group: its integration
 * category and its rank inside it, plus the tool-name → integration resolver.
 * The category/rank data is the web's config/integrationCatalog.js, and the
 * resolver its utils/integrationIcons.js `resolveIntegrationFromTool` (which
 * mirrors the server's integrationToolMap). palette.lockstep.test.ts requires
 * both web modules and compares.
 */

/** Display order of the categories; unknown ones sort after, as 'Other'. */
export const INTEGRATION_CATEGORY_ORDER = [
    'Google Workspace', 'Microsoft 365', 'Nextcloud', 'AI & Media',
    'Developer', 'Automation', 'Productivity', 'Health', 'Social',
] as const;

/** The catch-all category for apps the catalog does not know. */
export const OTHER_CATEGORY = 'Other';

const G = 'Google Workspace';
const MS = 'Microsoft 365';
const NC = 'Nextcloud';
const AI = 'AI & Media';

/** catalog id → [category, rank?]. `rank` orders an app inside its category; unranked sort A→Z after. */
export const APP_CATEGORIES: Readonly<Record<string, readonly [string, number?]>> = {
    gmail: [G], 'google-calendar': [G], 'google-drive': [G], 'google-slides': [G], 'google-sheets': [G],
    'google-docs': [G], 'google-contacts': [G], 'google-keep': [G], maps: [G], 'google-groups': [G],
    outlook: [MS], 'outlook-readonly': [MS], 'ms-calendar': [MS], onedrive: [MS], 'ms-contacts': [MS],
    'image-gen': [AI], 'music-gen': [AI], 'video-gen': [AI], elevenlabs: [AI], 'agent-search': [AI],
    'browser-fetch': [AI], transcription: [AI], 'kb-search': [AI],
    fireflies: ['Productivity'], gamma: ['Productivity'], 'afas-profit': ['Productivity'], nmbrs: ['Productivity'],
    vplan: ['Productivity'], signrequest: ['Productivity'], 'scaleway-billing': ['Productivity'],
    youtrack: ['Developer'], github: ['Developer'],
    n8n: ['Automation'], webpages: ['Automation'],
    linkedin: ['Social'], withings: ['Health'],
    nextcloud: [NC, 1], 'nextcloud-talk': [NC, 2], 'nextcloud-calendar': [NC, 3], 'nextcloud-deck': [NC, 4],
    'nextcloud-tables': [NC, 5], 'nextcloud-forms': [NC, 6], 'nextcloud-mail': [NC, 7], 'nextcloud-tasks': [NC, 8],
    'nextcloud-notes': [NC, 9], 'nextcloud-contacts': [NC, 10], 'nextcloud-teams': [NC, 11],
    'nextcloud-notifications': [NC, 12], 'nextcloud-activity': [NC, 13], 'nextcloud-status': [NC, 14],
};

/** Prefix → integration id, longest first so `ms_calendar_` wins over `ms_`. */
const PREFIX_TO_INTEGRATION: readonly (readonly [string, string])[] = (
    [
        ['nextcloud_calendar_', 'nextcloud_calendar'], ['nextcloud_contacts_', 'nextcloud_contacts'],
        ['nextcloud_deck_', 'nextcloud_deck'], ['nextcloud_notifications_', 'nextcloud_notifications'],
        ['nextcloud_talk_', 'nextcloud_talk'], ['nextcloud_tasks_', 'nextcloud_tasks'],
        ['nextcloud_notes_', 'nextcloud_notes'], ['nextcloud_mail_', 'nextcloud_mail'],
        ['nextcloud_activity_', 'nextcloud_activity'], ['nextcloud_status_', 'nextcloud_status'],
        ['nextcloud_', 'nextcloud'], ['ms_calendar_', 'ms_calendar'], ['ms_contacts_', 'ms_contacts'],
        ['keyword_planner_', 'keyword_planner'], ['n8n_workflow_', 'n8n'], ['n8n_', 'n8n'], ['gmail_', 'gmail'],
        ['calendar_', 'google_calendar'], ['drive_', 'google_drive'], ['docs_', 'google_docs'],
        ['contacts_', 'google_contacts'], ['keep_', 'google_keep'], ['groups_', 'google_groups'],
        ['outlook_', 'outlook'], ['onedrive_', 'onedrive'], ['fireflies_', 'fireflies'], ['youtrack_', 'youtrack'],
        ['signrequest_', 'signrequest'], ['gamma_', 'gamma'], ['afas_', 'afas_profit'], ['nmbrs_', 'nmbrs'],
        ['linkedin_', 'linkedin'], ['github_', 'github'], ['generate_', 'media_gen'], ['maps_', 'maps'],
        ['transcribe_', 'transcription'], ['memory_', 'memory'], ['webpage_', 'webpages'], ['webpages_', 'webpages'],
    ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

const STATIC_TOOL_TO_INTEGRATION: Readonly<Record<string, string>> = {
    agent_search: 'web_search', web_search: 'web_search', kb_search: 'kb_search', kb_fetch: 'kb_search',
    knowledge_base_ingest: 'kb_ingest', automation_runs_summary: 'automation_evolution',
    automation_propose_evolution: 'automation_evolution', automation_apply_evolution: 'automation_evolution',
    create_presentation: 'presentation_builder',
    send_email: 'email', read_emails: 'email', search_emails: 'email',
    read_calendar: 'calendar', create_calendar_event: 'calendar',
    search_maps: 'maps', get_directions: 'maps',
    generate_image: 'image_gen', generate_video: 'video_gen',
    generate_music: 'elevenlabs', generate_song: 'elevenlabs', generate_tts: 'elevenlabs', generate_sfx: 'elevenlabs',
    n8n_execute: 'n8n',
};

/** A tool name → its integration id, or null for an internal tool. */
export function resolveIntegrationFromTool(toolName: string | null | undefined): string | null {
    if (!toolName) return null;
    if (Object.prototype.hasOwnProperty.call(STATIC_TOOL_TO_INTEGRATION, toolName)) return STATIC_TOOL_TO_INTEGRATION[toolName] as string;
    for (const [prefix, id] of PREFIX_TO_INTEGRATION) if (toolName.startsWith(prefix)) return id;
    if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) return 'mcp';
    return null;
}

const normalizeId = (id: unknown) => String(id || '').toLowerCase().replace(/-/g, '_');
const BY_NORMALIZED = new Map(Object.entries(APP_CATEGORIES).map(([id, entry]) => [normalizeId(id), entry]));

/** The category and rank for an app, by its catalog id or its integration id. */
export function appPlacement(appId: unknown, integrationId: unknown): { category: string; rank: number | null } | null {
    const known = BY_NORMALIZED.get(normalizeId(appId)) || BY_NORMALIZED.get(normalizeId(integrationId));
    if (!known) return null;
    return { category: known[0], rank: known[1] ?? null };
}
