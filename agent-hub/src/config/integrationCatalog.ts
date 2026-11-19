// Shared integration catalog — used by both the super-admin
// IntegrationsAdminPanel and the org-admin OrgFeatureTogglesPanel so the
// two stay in sync. IDs here mirror the runtime gates in
// server/core/integrationTools.js and server/core/ncIntegrationCatalog.js
// — never rename without updating those.
//
// `rank` (optional) orders an app within its category on the automations
// ribbon: lower first, ties and unranked apps alphabetical. It exists because
// Nextcloud contributes fourteen apps to one row of pills — more than fits on
// a laptop — so the ribbon folds the LAST of them into a "More" pill. Which
// ones get folded away is then a product decision (Files/Talk/Calendar before
// User Status), not an accident of the alphabet. Leave it off anywhere the
// plain A→Z is right.

export interface IntegrationEntry {
    id: string;
    label: string;
    description: string;
    category: string;
    rank?: number;
}

export const INTEGRATION_CATALOG: IntegrationEntry[] = [
    { id: 'gmail', label: 'Gmail', description: 'Send and read emails', category: 'Google Workspace' },
    { id: 'google-calendar', label: 'Calendar', description: 'Manage calendar events', category: 'Google Workspace' },
    { id: 'google-drive', label: 'Drive', description: 'Access and manage files', category: 'Google Workspace' },
    { id: 'google-slides', label: 'Slides', description: 'Create presentations', category: 'Google Workspace' },
    { id: 'google-sheets', label: 'Sheets', description: 'Work with spreadsheets', category: 'Google Workspace' },
    { id: 'google-docs', label: 'Docs', description: 'Create and edit documents', category: 'Google Workspace' },
    { id: 'google-contacts', label: 'Contacts', description: 'Search, create and update contacts', category: 'Google Workspace' },
    { id: 'google-keep', label: 'Keep', description: 'List, create and delete notes', category: 'Google Workspace' },
    { id: 'outlook', label: 'Outlook', description: 'Send and read emails', category: 'Microsoft 365' },
    { id: 'outlook-readonly', label: 'Outlook (Read-Only)', description: 'Search and read emails only', category: 'Microsoft 365' },
    { id: 'ms-calendar', label: 'Calendar', description: 'Manage calendar events', category: 'Microsoft 365' },
    { id: 'onedrive', label: 'OneDrive', description: 'Access and manage files', category: 'Microsoft 365' },
    { id: 'ms-contacts', label: 'Contacts', description: 'Search, create and update contacts', category: 'Microsoft 365' },
    { id: 'image-gen', label: 'Image Generation', description: 'Generate images with AI', category: 'AI & Media' },
    { id: 'music-gen', label: 'Music Generation', description: 'Generate music with AI', category: 'AI & Media' },
    { id: 'video-gen', label: 'Video Generation', description: 'Create short videos with AI', category: 'AI & Media' },
    { id: 'elevenlabs', label: 'ElevenLabs', description: 'Music with vocals, speech and sound effects', category: 'AI & Media' },
    { id: 'agent-search', label: 'Agent Search', description: 'Search the web with AI and rank what it finds', category: 'AI & Media' },
    { id: 'browser-fetch', label: 'Browse Web', description: 'Open live web pages, read them and work with them', category: 'AI & Media' },
    { id: 'transcription', label: 'Meeting Transcription', description: 'Turn recordings into text, with who said what', category: 'AI & Media' },
    { id: 'fireflies', label: 'Fireflies', description: 'Meeting transcripts', category: 'Productivity' },
    { id: 'youtrack', label: 'YouTrack', description: 'Issue tracking', category: 'Developer' },
    { id: 'gamma', label: 'Gamma', description: 'Create presentations', category: 'Productivity' },
    { id: 'afas-profit', label: 'AFAS Profit', description: 'Read AFAS Profit business data (read-only)', category: 'Productivity' },
    { id: 'nmbrs', label: 'NMBRS', description: 'Read NMBRS payroll and HR data (read-only)', category: 'Productivity' },
    { id: 'vplan', label: 'vPlan', description: 'Read vPlan planning, capacity and time tracking (read-only)', category: 'Productivity' },
    { id: 'firebird', label: 'Firebird database', description: 'Read a Firebird database (read-only)', category: 'Productivity' },
    { id: 'frappe-crm', label: 'Frappe CRM', description: 'Read and update leads, deals, contacts, tasks and notes', category: 'Productivity' },
    { id: 'twoba', label: '2BA', description: 'Article data and net purchase prices from your 2BA condition files', category: 'Productivity' },
    { id: 'sanctions-lists', label: 'Sanctions lists', description: 'Screen names against the EU, UN, Dutch, OFAC and UK sanctions lists and check PEP functions (on this server)', category: 'Productivity' },
    { id: 'scaleway-billing', label: 'Scaleway Billing', description: 'Fetch Scaleway invoices as PDF for automations (read-only)', category: 'Productivity' },
    { id: 'n8n', label: 'n8n', description: 'Workflow automation', category: 'Automation' },
    { id: 'linkedin', label: 'LinkedIn', description: 'Post to LinkedIn', category: 'Social' },
    { id: 'withings', label: 'Withings', description: 'Read weight, blood pressure, sleep and activity', category: 'Health' },
    { id: 'github', label: 'GitHub', description: 'Repositories and code', category: 'Developer' },
    { id: 'signrequest', label: 'SignRequest', description: 'E-signature requests', category: 'Productivity' },
    { id: 'maps', label: 'Google Maps', description: 'Search places, get directions and look up addresses', category: 'Google Workspace' },
    { id: 'google-groups', label: 'Google Groups', description: 'List and manage Google Workspace groups', category: 'Google Workspace' },
    { id: 'kb-search', label: 'Knowledge Base', description: "Search your organisation's knowledge bases", category: 'AI & Media' },
    { id: 'webpages', label: 'Webpages', description: 'Run automations from your webpages', category: 'Automation' },
    { id: 'nextcloud', label: 'Nextcloud', description: 'Files & WebDAV (list, search, read, upload, share)', rank: 1, category: 'Nextcloud' },
    { id: 'nextcloud-mail', label: 'Nextcloud Mail', description: 'Send & read mail via Nextcloud Mail app', rank: 7, category: 'Nextcloud' },
    { id: 'nextcloud-calendar', label: 'Nextcloud Calendar', description: 'CalDAV — list, search, create, update, delete events', rank: 3, category: 'Nextcloud' },
    { id: 'nextcloud-contacts', label: 'Nextcloud Contacts', description: 'CardDAV — list, search, create, update, delete contacts', rank: 10, category: 'Nextcloud' },
    { id: 'nextcloud-deck', label: 'Nextcloud Deck', description: 'Kanban — boards, stacks, cards, labels, comments', rank: 4, category: 'Nextcloud' },
    { id: 'nextcloud-notifications', label: 'Nextcloud Notifications', description: 'List and dismiss Nextcloud notifications', rank: 12, category: 'Nextcloud' },
    { id: 'nextcloud-talk', label: 'Nextcloud Talk', description: 'Chat rooms, messages, reactions', rank: 2, category: 'Nextcloud' },
    { id: 'nextcloud-tasks', label: 'Nextcloud Tasks', description: 'VTODO via CalDAV — list, create, update, complete, delete tasks', rank: 8, category: 'Nextcloud' },
    { id: 'nextcloud-notes', label: 'Nextcloud Notes', description: 'Plain-text / markdown notes — list, search, create, update, delete', rank: 9, category: 'Nextcloud' },
    { id: 'nextcloud-activity', label: 'Nextcloud Activity', description: 'Read-only feed of recent file changes, shares, mentions', rank: 13, category: 'Nextcloud' },
    { id: 'nextcloud-tables', label: 'Nextcloud Tables', description: 'Structured data — tables, columns, rows (the store behind form intake and reporting)', rank: 5, category: 'Nextcloud' },
    { id: 'nextcloud-forms', label: 'Nextcloud Forms', description: 'Forms and their submissions — the intake side of a workflow', rank: 6, category: 'Nextcloud' },
    { id: 'nextcloud-teams', label: 'Nextcloud Teams', description: 'Teams/Circles — list, create, manage members, share files with a whole team', rank: 11, category: 'Nextcloud' },
    { id: 'nextcloud-status', label: 'Nextcloud User Status', description: "Get / set / clear the user's availability and custom message", rank: 14, category: 'Nextcloud' },
];

// Stable set of Nextcloud IDs — the org-admin generic toggle UI excludes
// these because they're managed by the dedicated Nextcloud panel.
export const NEXTCLOUD_INTEGRATION_IDS = new Set<string>(
    INTEGRATION_CATALOG.filter((i: IntegrationEntry) => i.category === 'Nextcloud').map((i: IntegrationEntry) => i.id)
);

// Display order of category sections across the admin UIs. Categories not
// listed here (e.g. the dynamic 'MCP' group) are appended after these.
export const CATEGORY_ORDER: string[] = [
    'Google Workspace', 'Microsoft 365', 'Nextcloud', 'AI & Media',
    'Developer', 'Automation', 'Productivity', 'Health', 'Social',
];

export function orderCategories(cats: string[]): string[] {
    const present = new Set(cats);
    const ordered = CATEGORY_ORDER.filter((c: string) => present.has(c));
    const extras = cats.filter((c: string) => !CATEGORY_ORDER.includes(c)); // e.g. 'MCP'
    return [...ordered, ...extras];
}

export function getIntegrationById(id: string): IntegrationEntry | null {
    return INTEGRATION_CATALOG.find((i: IntegrationEntry) => i.id === id) || null;
}
