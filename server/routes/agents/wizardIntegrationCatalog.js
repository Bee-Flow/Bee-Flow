// @typecheck strict
'use strict';

// ─────────────────────────────────────────────────────────────────
// Integration catalog the LLM can pick from. Mirrors the catalog in
// agent-hub/src/components/admin/AgentDesigner/integrations.jsx so the
// model picks ids the front-end and runtime actually understand.
// ─────────────────────────────────────────────────────────────────
/** @type {Array<{ id: string, label: string, description: string, group?: string, requiresKey?: string }>} */
const INTEGRATION_CATALOG = [
    { id: 'gmail', label: 'Gmail', group: 'google', description: 'Read and send emails' },
    { id: 'google-calendar', label: 'Google Calendar', group: 'google', description: 'Create and manage events' },
    { id: 'google-drive', label: 'Google Drive', group: 'google', description: 'Search and access files' },
    { id: 'google-sheets', label: 'Google Sheets', group: 'google', description: 'Read and write spreadsheets' },
    { id: 'google-docs', label: 'Google Docs', group: 'google', description: 'Create and edit documents' },
    { id: 'google-slides', label: 'Google Slides', group: 'google', description: 'Create presentations' },
    { id: 'google-contacts', label: 'Google Contacts', group: 'google', description: 'Search and manage contacts' },
    { id: 'google-keep', label: 'Google Keep', group: 'google', description: 'List and create notes' },
    { id: 'google-groups', label: 'Google Groups', group: 'google', description: 'Read and reply to group conversations' },
    { id: 'outlook', label: 'Outlook', description: 'Read and send Outlook emails' },
    { id: 'ms-calendar', label: 'Microsoft Calendar', description: 'Manage Microsoft calendar events' },
    { id: 'onedrive', label: 'OneDrive', description: 'Access OneDrive files' },
    { id: 'ms-contacts', label: 'Microsoft Contacts', description: 'Search Microsoft contacts' },
    { id: 'fireflies', label: 'Fireflies.ai', description: 'Meeting transcripts', requiresKey: 'hasFirefliesKey' },
    { id: 'youtrack', label: 'YouTrack', description: 'Issues and projects', requiresKey: 'hasYouTrackConfig' },
    { id: 'gamma', label: 'Gamma', description: 'AI presentations', requiresKey: 'hasGammaKey' },
    { id: 'afas-profit', label: 'AFAS Profit', description: 'Query AFAS Profit business data (read-only)', requiresKey: 'hasAfasConfig' },
    { id: 'nmbrs', label: 'NMBRS', description: 'Read NMBRS payroll & HR data (read-only)', requiresKey: 'hasNmbrsConfig' },
    { id: 'vplan', label: 'vPlan', description: 'Read vPlan planning, capacity & time tracking (read-only)', requiresKey: 'hasVplanConfig' },
    { id: 'firebird', label: 'Firebird database', description: 'Read a Firebird database such as Syntess Atrium (read-only)', requiresKey: 'hasFirebirdConfig' },
    { id: 'scaleway-billing', label: 'Scaleway Billing', description: 'Fetch Scaleway invoices (PDF) for automations (read-only)', requiresKey: 'hasScalewayBillingConfig' },
    { id: 'linkedin', label: 'LinkedIn', description: 'Post and search on LinkedIn', requiresKey: 'hasLinkedInConfig' },
    { id: 'n8n', label: 'n8n', description: 'Run workflows', requiresKey: 'hasN8nConfig' },
    { id: 'web-search', label: 'Web Search', description: 'Search the web' },
    { id: 'image-gen', label: 'Image Generation', description: 'Generate images' },
];

module.exports = { INTEGRATION_CATALOG };
