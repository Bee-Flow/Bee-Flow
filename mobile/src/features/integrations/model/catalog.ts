/**
 * The integration catalogue, and the connectors that have an OAuth handshake.
 *
 * Two separate things, deliberately kept apart because the server does too:
 *
 *   - CONNECTORS are accounts you link. Each has its own router under
 *     `/api/integrations/<provider>` with `/status`, `/auth-url` and
 *     `/disconnect`, and NO two of them return the same status shape (see
 *     IntegrationStatus in ./types.ts). There are five.
 *
 *   - INTEGRATION_CATALOG is the list of tools a model may call on your
 *     behalf. It is a per-user allow-list stored as `enabledApps` on
 *     `/ai/user-settings`, intersected server-side with whatever the
 *     organisation permits (`orgEnabledIntegrations`). There are forty-nine,
 *     and toggling one does not connect anything — it decides whether the
 *     model is offered the tool at all.
 *
 * Mirrored from agent-hub/src/config/integrationCatalog.js. The ids match the
 * runtime gates in server/core/integrationTools.js and
 * server/core/ncIntegrationCatalog.js; never rename one here alone.
 */

import { translate } from '@/core/i18n';

import type { CatalogEntry, Copy } from './types';

/** Brand names that a connector and a catalogue entry both show: one key each. */
const GOOGLE_WORKSPACE: Copy = { i18nKey: 'settings.integrations_google_workspace', en: 'Google Workspace' };
const MICROSOFT_365: Copy = { i18nKey: 'integ.microsoft_group', en: 'Microsoft 365' };
const GITHUB: Copy = { i18nKey: 'mobile.integrations.app_github', en: 'GitHub' };
const LINKEDIN: Copy = { i18nKey: 'mobile.integrations.app_linkedin', en: 'LinkedIn' };
const WITHINGS: Copy = { i18nKey: 'mobile.integrations.app_withings', en: 'Withings' };

export interface Connector {
    /** Path segment under /api/integrations — NOT the catalogue id. */
    provider: string;
    label: Copy;
    description: Copy;
    /**
     * How this provider's `/status` names the connected account, so the row
     * can show it. Google and Microsoft return `email`, LinkedIn `name`,
     * GitHub `username`, Withings nothing at all.
     */
    identityField: 'email' | 'name' | 'username' | null;
    /**
     * True when the provider reports whether an administrator has configured
     * its client credentials. Without that, "not connected" and "impossible to
     * connect" look identical, and the user hunts for a button that can never
     * work.
     */
    reportsConfigured: boolean;
    /**
     * Connecting needs a browser round trip that lands back on the SERVER's
     * callback, carrying the CSRF state stashed in the session. GitHub is the
     * exception: `POST /api/integrations/github/connect` takes a personal
     * access token directly, so it never leaves the app.
     */
    flow: 'oauth' | 'token';
}

export const CONNECTORS: Connector[] = [
    {
        provider: 'google',
        label: GOOGLE_WORKSPACE,
        description: { i18nKey: 'mobile.integrations.connector_google_desc', en: 'Gmail, Calendar, Drive, Docs, Contacts and Keep' },
        identityField: 'email',
        reportsConfigured: true,
        flow: 'oauth',
    },
    {
        provider: 'microsoft',
        label: MICROSOFT_365,
        description: { i18nKey: 'mobile.integrations.connector_microsoft_desc', en: 'Outlook, Calendar, OneDrive and Contacts' },
        identityField: 'email',
        reportsConfigured: true,
        flow: 'oauth',
    },
    {
        provider: 'linkedin',
        label: LINKEDIN,
        description: { i18nKey: 'mobile.integrations.connector_linkedin_desc', en: 'Post to your LinkedIn feed' },
        identityField: 'name',
        reportsConfigured: false,
        flow: 'oauth',
    },
    {
        provider: 'withings',
        label: WITHINGS,
        description: { i18nKey: 'mobile.integrations.connector_withings_desc', en: 'Weight, blood pressure, sleep and activity from Health Mate' },
        identityField: null,
        reportsConfigured: false,
        flow: 'oauth',
    },
    {
        provider: 'github',
        label: GITHUB,
        description: { i18nKey: 'mobile.integrations.connector_github_desc', en: 'Repositories, issues and code' },
        identityField: 'username',
        reportsConfigured: false,
        flow: 'token',
    },
];

/**
 * A connector's display name for its provider slug ('google' → 'Google
 * Workspace'), or null for a slug that is not one of the connectors here — a
 * notification names the provider by slug, and the slug is not a name.
 */
export function connectorLabel(provider: string | null | undefined): string | null {
    const slug = String(provider ?? '').toLowerCase();
    const label = CONNECTORS.find((c) => c.provider === slug)?.label;
    return label ? translate(label.i18nKey, label.en) : null;
}

/**
 * The category names are identities (an entry's `category` is compared with
 * them, and an unknown one is appended rather than dropped), so they stay
 * English strings; what a group's heading SAYS comes from here. The web's
 * Settings → Integrations groups already have most of these words.
 */
const CATEGORY_COPY: Record<string, Copy> = {
    'Google Workspace': GOOGLE_WORKSPACE,
    'Microsoft 365': MICROSOFT_365,
    Nextcloud: { i18nKey: 'settings.integrations_nextcloud', en: 'Nextcloud' },
    'AI & Media': { i18nKey: 'mobile.integrations.category_ai_media', en: 'AI & Media' },
    Developer: { i18nKey: 'settings.integrations_developer', en: 'Developer' },
    Automation: { i18nKey: 'mobile.integrations.category_automation', en: 'Automation' },
    Productivity: { i18nKey: 'settings.integrations_productivity', en: 'Productivity' },
    Health: { i18nKey: 'settings.integrations_health', en: 'Health' },
    Social: { i18nKey: 'settings.integrations_social', en: 'Social' },
};

/** A category's heading words, or null for a category this app has none for. */
export function categoryCopy(category: string): Copy | null {
    return Object.hasOwn(CATEGORY_COPY, category) ? (CATEGORY_COPY[category] ?? null) : null;
}

export const CATEGORY_ORDER: string[] = [
    'Google Workspace',
    'Microsoft 365',
    'Nextcloud',
    'AI & Media',
    'Developer',
    'Automation',
    'Productivity',
    'Health',
    'Social',
];

/**
 * The catalogue's copy, shared where two entries say the same words: one key
 * each, so a translation of "Calendar" covers both calendars.
 */
const CALENDAR: Copy = { i18nKey: 'mobile.integrations.app_calendar', en: 'Calendar' };
const CONTACTS: Copy = { i18nKey: 'mobile.integrations.app_contacts', en: 'Contacts' };
const DESC_EMAIL: Copy = { i18nKey: 'mobile.integrations.desc_send_read_emails', en: 'Send and read emails' };
const DESC_CALENDAR: Copy = { i18nKey: 'mobile.integrations.desc_manage_calendar', en: 'Manage calendar events' };
const DESC_FILES: Copy = { i18nKey: 'mobile.integrations.desc_access_files', en: 'Access and manage files' };
const DESC_PRESENTATIONS: Copy = { i18nKey: 'mobile.integrations.desc_create_presentations', en: 'Create presentations' };
const DESC_CONTACTS: Copy = { i18nKey: 'mobile.integrations.desc_contacts', en: 'Search, create and update contacts' };

/**
 * One catalogue entry. `label` and `description` stay the English strings the
 * other features read (a skill's "may use", the agent editor); the keys beside
 * them are what this feature renders through `t()`.
 */
function app(id: string, category: string, label: Copy, description: Copy): CatalogEntry {
    return {
        id,
        category,
        label: label.en,
        labelKey: label.i18nKey,
        description: description.en,
        descriptionKey: description.i18nKey,
    };
}

export const INTEGRATION_CATALOG: CatalogEntry[] = [
    app('gmail', 'Google Workspace', { i18nKey: 'mobile.integrations.app_gmail', en: 'Gmail' }, DESC_EMAIL),
    app('google-calendar', 'Google Workspace', CALENDAR, DESC_CALENDAR),
    app('google-drive', 'Google Workspace', { i18nKey: 'mobile.integrations.app_google_drive', en: 'Drive' }, DESC_FILES),
    app('google-slides', 'Google Workspace', { i18nKey: 'mobile.integrations.app_google_slides', en: 'Slides' }, DESC_PRESENTATIONS),
    app('google-sheets', 'Google Workspace', { i18nKey: 'mobile.integrations.app_google_sheets', en: 'Sheets' }, { i18nKey: 'mobile.integrations.app_google_sheets_desc', en: 'Work with spreadsheets' }),
    app('google-docs', 'Google Workspace', { i18nKey: 'mobile.integrations.app_google_docs', en: 'Docs' }, { i18nKey: 'mobile.integrations.app_google_docs_desc', en: 'Create and edit documents' }),
    app('google-contacts', 'Google Workspace', CONTACTS, DESC_CONTACTS),
    app('google-keep', 'Google Workspace', { i18nKey: 'mobile.integrations.app_google_keep', en: 'Keep' }, { i18nKey: 'mobile.integrations.app_google_keep_desc', en: 'List, create and delete notes' }),
    app('google-groups', 'Google Workspace', { i18nKey: 'mobile.integrations.app_google_groups', en: 'Google Groups' }, { i18nKey: 'mobile.integrations.app_google_groups_desc', en: 'List and manage Workspace groups' }),
    app('maps', 'Google Workspace', { i18nKey: 'mobile.integrations.app_maps', en: 'Google Maps' }, { i18nKey: 'mobile.integrations.app_maps_desc', en: 'Places search, directions, geocoding' }),

    app('outlook', 'Microsoft 365', { i18nKey: 'mobile.integrations.app_outlook', en: 'Outlook' }, DESC_EMAIL),
    app('outlook-readonly', 'Microsoft 365', { i18nKey: 'mobile.integrations.app_outlook_readonly', en: 'Outlook (read-only)' }, { i18nKey: 'mobile.integrations.app_outlook_readonly_desc', en: 'Search and read emails only' }),
    app('ms-calendar', 'Microsoft 365', CALENDAR, DESC_CALENDAR),
    app('onedrive', 'Microsoft 365', { i18nKey: 'mobile.integrations.app_onedrive', en: 'OneDrive' }, DESC_FILES),
    app('ms-contacts', 'Microsoft 365', CONTACTS, DESC_CONTACTS),

    app('nextcloud', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud', en: 'Nextcloud Files' }, { i18nKey: 'mobile.integrations.app_nextcloud_desc', en: 'List, search, read, upload and share' }),
    app('nextcloud-talk', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_talk', en: 'Nextcloud Talk' }, { i18nKey: 'mobile.integrations.app_nextcloud_talk_desc', en: 'Chat rooms, messages, reactions' }),
    app('nextcloud-calendar', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_calendar', en: 'Nextcloud Calendar' }, { i18nKey: 'mobile.integrations.app_nextcloud_calendar_desc', en: 'CalDAV events' }),
    app('nextcloud-deck', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_deck', en: 'Nextcloud Deck' }, { i18nKey: 'mobile.integrations.app_nextcloud_deck_desc', en: 'Kanban boards, stacks and cards' }),
    app('nextcloud-tables', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_tables', en: 'Nextcloud Tables' }, { i18nKey: 'mobile.integrations.app_nextcloud_tables_desc', en: 'Structured tables, columns and rows' }),
    app('nextcloud-forms', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_forms', en: 'Nextcloud Forms' }, { i18nKey: 'mobile.integrations.app_nextcloud_forms_desc', en: 'Forms and their submissions' }),
    app('nextcloud-mail', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_mail', en: 'Nextcloud Mail' }, { i18nKey: 'mobile.integrations.app_nextcloud_mail_desc', en: 'Send and read mail' }),
    app('nextcloud-tasks', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_tasks', en: 'Nextcloud Tasks' }, { i18nKey: 'mobile.integrations.app_nextcloud_tasks_desc', en: 'VTODO tasks via CalDAV' }),
    app('nextcloud-notes', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_notes', en: 'Nextcloud Notes' }, { i18nKey: 'mobile.integrations.app_nextcloud_notes_desc', en: 'Plain-text and markdown notes' }),
    app('nextcloud-contacts', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_contacts', en: 'Nextcloud Contacts' }, { i18nKey: 'mobile.integrations.app_nextcloud_contacts_desc', en: 'CardDAV contacts' }),
    app('nextcloud-teams', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_teams', en: 'Nextcloud Teams' }, { i18nKey: 'mobile.integrations.app_nextcloud_teams_desc', en: 'Teams and circles' }),
    app('nextcloud-notifications', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_notifications', en: 'Nextcloud Notifications' }, { i18nKey: 'mobile.integrations.app_nextcloud_notifications_desc', en: 'List and dismiss notifications' }),
    app('nextcloud-activity', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_activity', en: 'Nextcloud Activity' }, { i18nKey: 'mobile.integrations.app_nextcloud_activity_desc', en: 'Recent file changes, shares and mentions' }),
    app('nextcloud-status', 'Nextcloud', { i18nKey: 'mobile.integrations.app_nextcloud_status', en: 'Nextcloud User Status' }, { i18nKey: 'mobile.integrations.app_nextcloud_status_desc', en: 'Availability and custom message' }),

    app('image-gen', 'AI & Media', { i18nKey: 'mobile.integrations.app_image_gen', en: 'Image generation' }, { i18nKey: 'mobile.integrations.app_image_gen_desc', en: 'Generate images with AI' }),
    app('music-gen', 'AI & Media', { i18nKey: 'mobile.integrations.app_music_gen', en: 'Music generation' }, { i18nKey: 'mobile.integrations.app_music_gen_desc', en: 'Generate music with AI' }),
    app('video-gen', 'AI & Media', { i18nKey: 'mobile.integrations.app_video_gen', en: 'Video generation' }, { i18nKey: 'mobile.integrations.app_video_gen_desc', en: 'Generate short videos with AI' }),
    app('elevenlabs', 'AI & Media', { i18nKey: 'mobile.integrations.app_elevenlabs', en: 'ElevenLabs' }, { i18nKey: 'mobile.integrations.app_elevenlabs_desc', en: 'Speech, music and sound effects' }),
    app('agent-search', 'AI & Media', { i18nKey: 'mobile.integrations.app_agent_search', en: 'Agent search' }, { i18nKey: 'mobile.integrations.app_agent_search_desc', en: 'Web search with reranking' }),
    app('browser-fetch', 'AI & Media', { i18nKey: 'mobile.integrations.app_browser_fetch', en: 'Browse the web' }, { i18nKey: 'mobile.integrations.app_browser_fetch_desc', en: 'Read and interact with live web pages' }),
    app('transcription', 'AI & Media', { i18nKey: 'mobile.integrations.app_transcription', en: 'Meeting transcription' }, { i18nKey: 'mobile.integrations.app_transcription_desc', en: 'Transcribe audio with speaker labels' }),
    app('kb-search', 'AI & Media', { i18nKey: 'mobile.integrations.app_kb_search', en: 'Knowledge base' }, { i18nKey: 'mobile.integrations.app_kb_search_desc', en: 'Search your organisation’s knowledge bases' }),

    app('github', 'Developer', GITHUB, { i18nKey: 'mobile.integrations.app_github_desc', en: 'Repository management and code' }),
    app('youtrack', 'Developer', { i18nKey: 'mobile.integrations.app_youtrack', en: 'YouTrack' }, { i18nKey: 'mobile.integrations.app_youtrack_desc', en: 'Issue tracking' }),

    app('n8n', 'Automation', { i18nKey: 'mobile.integrations.app_n8n', en: 'n8n' }, { i18nKey: 'mobile.integrations.app_n8n_desc', en: 'Workflow automation' }),
    app('webpages', 'Automation', { i18nKey: 'mobile.integrations.app_webpages', en: 'Webpages' }, { i18nKey: 'mobile.integrations.app_webpages_desc', en: 'Run your webpage automations' }),

    app('fireflies', 'Productivity', { i18nKey: 'mobile.integrations.app_fireflies', en: 'Fireflies' }, { i18nKey: 'mobile.integrations.app_fireflies_desc', en: 'Meeting transcripts' }),
    app('gamma', 'Productivity', { i18nKey: 'mobile.integrations.app_gamma', en: 'Gamma' }, DESC_PRESENTATIONS),
    app('signrequest', 'Productivity', { i18nKey: 'mobile.integrations.app_signrequest', en: 'SignRequest' }, { i18nKey: 'mobile.integrations.app_signrequest_desc', en: 'E-signature requests' }),
    app('afas-profit', 'Productivity', { i18nKey: 'mobile.integrations.app_afas_profit', en: 'AFAS Profit' }, { i18nKey: 'mobile.integrations.app_afas_profit_desc', en: 'Query AFAS Profit business data' }),
    app('nmbrs', 'Productivity', { i18nKey: 'mobile.integrations.app_nmbrs', en: 'NMBRS' }, { i18nKey: 'mobile.integrations.app_nmbrs_desc', en: 'Read NMBRS payroll and HR data' }),
    app('vplan', 'Productivity', { i18nKey: 'mobile.integrations.app_vplan', en: 'vPlan' }, { i18nKey: 'mobile.integrations.app_vplan_desc', en: 'Read vPlan planning and time tracking' }),

    app('withings', 'Health', WITHINGS, { i18nKey: 'mobile.integrations.app_withings_desc', en: 'Weight, blood pressure, sleep and activity' }),

    app('linkedin', 'Social', LINKEDIN, { i18nKey: 'mobile.integrations.app_linkedin_desc', en: 'Post to LinkedIn' }),
];

/**
 * Which catalogue entries this account may actually turn on.
 *
 * `orgEnabledIntegrations` is null for "no restriction" and a list otherwise —
 * NOT an empty list meaning "allow nothing". Reading it the wrong way round is
 * what once made the web app's whole app picker vanish, so it is handled here
 * once rather than at each call site.
 */
export function allowedByOrg(
    catalogue: CatalogEntry[],
    orgEnabledIntegrations: string[] | null | undefined,
): CatalogEntry[] {
    if (!orgEnabledIntegrations) return catalogue;
    const allowed = new Set(orgEnabledIntegrations);
    return catalogue.filter((entry) => allowed.has(entry.id));
}

/** Category order, with any unknown category appended rather than dropped. */
export function orderCategories(categories: string[]): string[] {
    const present = new Set(categories);
    const known = CATEGORY_ORDER.filter((c) => present.has(c));
    const extras = categories.filter((c) => !CATEGORY_ORDER.includes(c));
    return [...known, ...extras];
}
