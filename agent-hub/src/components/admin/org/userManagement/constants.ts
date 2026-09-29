// BFSF-286: registration provenance labels. Literal keys (no template
// interpolation) so the i18nGuard static scan sees them.
export const ORG_SOURCE_KEY: Record<string, string> = {
    direct: 'admin.org_source_direct',
    admin: 'admin.org_source_admin',
    nextcloud_connector: 'admin.org_source_nextcloud_connector',
};

export interface IntegrationOption {
    id: string;
    label: string;
}

// NOT a duplicate of config/integrationCatalog.js — a STALE SUBSET of it.
// The catalog has 44 entries; this has 22. Nothing here is missing from the
// catalog, but the catalog additionally carries outlook-readonly,
// agent-search, browser-fetch, transcription, linkedin, github, signrequest,
// maps, google-groups, kb-search, webpages and all 11 nextcloud-* ids —
// none of which an org admin can toggle from this modal today.
//
// Deliberately NOT swapped for the catalog during the P2 coherence pass:
// that would double the org's configurable integration surface, which is a
// product decision, not a tidy-up. The catalog's header says it exists so
// IntegrationsAdminPanel and OrgFeatureTogglesPanel "stay in sync" — this
// modal is a third consumer that drifted. Needs an owner decision: adopt the
// catalog wholesale, or declare this list intentionally curated and say so.
export const ALL_INTEGRATIONS: IntegrationOption[] = [
    { id: 'gmail', label: 'Gmail' },
    { id: 'google-calendar', label: 'Calendar (Google)' },
    { id: 'google-drive', label: 'Drive' },
    { id: 'google-slides', label: 'Slides' },
    { id: 'google-sheets', label: 'Sheets' },
    { id: 'google-docs', label: 'Docs' },
    { id: 'google-contacts', label: 'Contacts (Google)' },
    { id: 'google-keep', label: 'Keep' },
    { id: 'outlook', label: 'Outlook' },
    { id: 'ms-calendar', label: 'Calendar (Microsoft)' },
    { id: 'onedrive', label: 'OneDrive' },
    { id: 'ms-contacts', label: 'Contacts (Microsoft)' },
    { id: 'image-gen', label: 'Image Gen' },
    { id: 'music-gen', label: 'Music Gen' },
    { id: 'video-gen', label: 'Video Gen' },
    { id: 'elevenlabs', label: 'ElevenLabs' },
    { id: 'fireflies', label: 'Fireflies' },
    { id: 'youtrack', label: 'YouTrack' },
    { id: 'gamma', label: 'Gamma' },
    { id: 'afas-profit', label: 'AFAS Profit' },
    { id: 'nmbrs', label: 'NMBRS' },
    { id: 'n8n', label: 'n8n' },
];
