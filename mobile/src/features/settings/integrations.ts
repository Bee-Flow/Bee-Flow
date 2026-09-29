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

import type { CatalogEntry } from './types';

export interface Connector {
    /** Path segment under /api/integrations — NOT the catalogue id. */
    provider: string;
    label: string;
    description: string;
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
        label: 'Google Workspace',
        description: 'Gmail, Calendar, Drive, Docs, Contacts and Keep',
        identityField: 'email',
        reportsConfigured: true,
        flow: 'oauth',
    },
    {
        provider: 'microsoft',
        label: 'Microsoft 365',
        description: 'Outlook, Calendar, OneDrive and Contacts',
        identityField: 'email',
        reportsConfigured: true,
        flow: 'oauth',
    },
    {
        provider: 'linkedin',
        label: 'LinkedIn',
        description: 'Post to your LinkedIn feed',
        identityField: 'name',
        reportsConfigured: false,
        flow: 'oauth',
    },
    {
        provider: 'withings',
        label: 'Withings',
        description: 'Weight, blood pressure, sleep and activity from Health Mate',
        identityField: null,
        reportsConfigured: false,
        flow: 'oauth',
    },
    {
        provider: 'github',
        label: 'GitHub',
        description: 'Repositories, issues and code',
        identityField: 'username',
        reportsConfigured: false,
        flow: 'token',
    },
];

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

export const INTEGRATION_CATALOG: CatalogEntry[] = [
    { id: 'gmail', label: 'Gmail', description: 'Send and read emails', category: 'Google Workspace' },
    { id: 'google-calendar', label: 'Calendar', description: 'Manage calendar events', category: 'Google Workspace' },
    { id: 'google-drive', label: 'Drive', description: 'Access and manage files', category: 'Google Workspace' },
    { id: 'google-slides', label: 'Slides', description: 'Create presentations', category: 'Google Workspace' },
    { id: 'google-sheets', label: 'Sheets', description: 'Work with spreadsheets', category: 'Google Workspace' },
    { id: 'google-docs', label: 'Docs', description: 'Create and edit documents', category: 'Google Workspace' },
    { id: 'google-contacts', label: 'Contacts', description: 'Search, create and update contacts', category: 'Google Workspace' },
    { id: 'google-keep', label: 'Keep', description: 'List, create and delete notes', category: 'Google Workspace' },
    { id: 'google-groups', label: 'Google Groups', description: 'List and manage Workspace groups', category: 'Google Workspace' },
    { id: 'maps', label: 'Google Maps', description: 'Places search, directions, geocoding', category: 'Google Workspace' },

    { id: 'outlook', label: 'Outlook', description: 'Send and read emails', category: 'Microsoft 365' },
    { id: 'outlook-readonly', label: 'Outlook (read-only)', description: 'Search and read emails only', category: 'Microsoft 365' },
    { id: 'ms-calendar', label: 'Calendar', description: 'Manage calendar events', category: 'Microsoft 365' },
    { id: 'onedrive', label: 'OneDrive', description: 'Access and manage files', category: 'Microsoft 365' },
    { id: 'ms-contacts', label: 'Contacts', description: 'Search, create and update contacts', category: 'Microsoft 365' },

    { id: 'nextcloud', label: 'Nextcloud Files', description: 'List, search, read, upload and share', category: 'Nextcloud' },
    { id: 'nextcloud-talk', label: 'Nextcloud Talk', description: 'Chat rooms, messages, reactions', category: 'Nextcloud' },
    { id: 'nextcloud-calendar', label: 'Nextcloud Calendar', description: 'CalDAV events', category: 'Nextcloud' },
    { id: 'nextcloud-deck', label: 'Nextcloud Deck', description: 'Kanban boards, stacks and cards', category: 'Nextcloud' },
    { id: 'nextcloud-tables', label: 'Nextcloud Tables', description: 'Structured tables, columns and rows', category: 'Nextcloud' },
    { id: 'nextcloud-forms', label: 'Nextcloud Forms', description: 'Forms and their submissions', category: 'Nextcloud' },
    { id: 'nextcloud-mail', label: 'Nextcloud Mail', description: 'Send and read mail', category: 'Nextcloud' },
    { id: 'nextcloud-tasks', label: 'Nextcloud Tasks', description: 'VTODO tasks via CalDAV', category: 'Nextcloud' },
    { id: 'nextcloud-notes', label: 'Nextcloud Notes', description: 'Plain-text and markdown notes', category: 'Nextcloud' },
    { id: 'nextcloud-contacts', label: 'Nextcloud Contacts', description: 'CardDAV contacts', category: 'Nextcloud' },
    { id: 'nextcloud-teams', label: 'Nextcloud Teams', description: 'Teams and circles', category: 'Nextcloud' },
    { id: 'nextcloud-notifications', label: 'Nextcloud Notifications', description: 'List and dismiss notifications', category: 'Nextcloud' },
    { id: 'nextcloud-activity', label: 'Nextcloud Activity', description: 'Recent file changes, shares and mentions', category: 'Nextcloud' },
    { id: 'nextcloud-status', label: 'Nextcloud User Status', description: 'Availability and custom message', category: 'Nextcloud' },

    { id: 'image-gen', label: 'Image generation', description: 'Generate images with AI', category: 'AI & Media' },
    { id: 'music-gen', label: 'Music generation', description: 'Generate music with AI', category: 'AI & Media' },
    { id: 'video-gen', label: 'Video generation', description: 'Generate short videos with AI', category: 'AI & Media' },
    { id: 'elevenlabs', label: 'ElevenLabs', description: 'Speech, music and sound effects', category: 'AI & Media' },
    { id: 'agent-search', label: 'Agent search', description: 'Web search with reranking', category: 'AI & Media' },
    { id: 'browser-fetch', label: 'Browse the web', description: 'Read and interact with live web pages', category: 'AI & Media' },
    { id: 'transcription', label: 'Meeting transcription', description: 'Transcribe audio with speaker labels', category: 'AI & Media' },
    { id: 'kb-search', label: 'Knowledge base', description: 'Search your organisation’s knowledge bases', category: 'AI & Media' },

    { id: 'github', label: 'GitHub', description: 'Repository management and code', category: 'Developer' },
    { id: 'youtrack', label: 'YouTrack', description: 'Issue tracking', category: 'Developer' },

    { id: 'n8n', label: 'n8n', description: 'Workflow automation', category: 'Automation' },
    { id: 'webpages', label: 'Webpages', description: 'Run your webpage automations', category: 'Automation' },

    { id: 'fireflies', label: 'Fireflies', description: 'Meeting transcripts', category: 'Productivity' },
    { id: 'gamma', label: 'Gamma', description: 'Create presentations', category: 'Productivity' },
    { id: 'signrequest', label: 'SignRequest', description: 'E-signature requests', category: 'Productivity' },
    { id: 'afas-profit', label: 'AFAS Profit', description: 'Query AFAS Profit business data', category: 'Productivity' },
    { id: 'nmbrs', label: 'NMBRS', description: 'Read NMBRS payroll and HR data', category: 'Productivity' },
    { id: 'vplan', label: 'vPlan', description: 'Read vPlan planning and time tracking', category: 'Productivity' },

    { id: 'withings', label: 'Withings', description: 'Weight, blood pressure, sleep and activity', category: 'Health' },

    { id: 'linkedin', label: 'LinkedIn', description: 'Post to LinkedIn', category: 'Social' },
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
