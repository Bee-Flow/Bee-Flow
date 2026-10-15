// Buckets the plan templates draw their beta features, integrations and core
// features from.

// ── Beta feature buckets ────────────────────────────────────────────────────
export const BETA_FREE: string[]      = [];
export const BETA_PLUS: string[]      = [];
export const BETA_TEAM      = ['automations', 'agent_routines'];
export const BETA_BUSINESS  = [
    'automations', 'agent_routines',
    'meeting_notes', 'voice_chat',
    'webpages', 'skills',
];
export const BETA_ENTERPRISE = [
    ...BETA_BUSINESS,
    'swarm', 'advanced_analytics', 'custom_themes',
    // 'white_label' intentionally omitted — self-hosted only.
];

// ── Integration buckets ────────────────────────────────────────────────────
export const INT_NEXTCLOUD_CORE = ['nextcloud'];
export const INT_NEXTCLOUD_FULL = [
    'nextcloud', 'nextcloud-mail', 'nextcloud-calendar', 'nextcloud-contacts',
    'nextcloud-deck', 'nextcloud-notifications', 'nextcloud-talk',
    'nextcloud-tasks', 'nextcloud-notes', 'nextcloud-activity', 'nextcloud-status',
];
export const INT_GOOGLE_WORKSPACE = [
    'gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets',
    'google-slides', 'google-contacts', 'google-keep', 'google-groups', 'maps',
];
export const INT_MICROSOFT_365 = ['outlook', 'ms-calendar', 'onedrive', 'ms-contacts'];
export const INT_GOOGLE_PERSONAL = ['gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-contacts'];
export const INT_MS_PERSONAL = ['outlook', 'ms-calendar', 'onedrive', 'ms-contacts'];
export const INT_AI = ['image-gen', 'music-gen', 'video-gen', 'elevenlabs', 'agent-search', 'transcription', 'kb-search'];
export const INT_THIRD_PARTY = ['fireflies', 'youtrack', 'gamma', 'afas-profit', 'nmbrs', 'vplan', 'scaleway-billing', 'n8n', 'linkedin', 'github', 'signrequest', 'webpages'];

// ── Core feature buckets ───────────────────────────────────────────────────
export const FEAT_FREE  = ['chat', 'direct_chat'];
export const FEAT_PLUS  = ['chat', 'direct_chat', 'agents', 'knowledge_base'];
export const FEAT_TEAM  = ['chat', 'direct_chat', 'agents', 'knowledge_base', 'workspace'];
export const FEAT_FULL  = ['chat', 'direct_chat', 'agents', 'knowledge_base', 'workspace', 'embed_chat', 'encryption'];
