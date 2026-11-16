/**
 * The integration families of the admin dashboard and what each needs, as
 * data: which capability ids or licence feature put a family in an
 * organisation's ceiling, which platform module and server switch it needs,
 * and which server-wide setting makes an integration "configured on this
 * server". Read by usecases/integrations/orgIntegrationAvailability.mts.
 */

export const FAMILY_IDS = [
    'google', 'microsoft', 'nextcloud', 'github', 'n8n', 'maps', 'mcp',
    'meetingNotes', 'projects', 'learningCenter', 'automations', 'imageGen',
] as const;
export type FamilyId = typeof FAMILY_IDS[number];

/** The Google Workspace apps (the catalogue's Google category, Maps aside: Maps has its own key). */
export const GOOGLE_CAPABILITIES = Object.freeze([
    'gmail', 'google-calendar', 'google-drive', 'google-slides', 'google-sheets',
    'google-docs', 'google-contacts', 'google-keep', 'google-groups',
]);
export const MICROSOFT_CAPABILITIES = Object.freeze(['outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts']);

/** What this server has set up, read once per request. */
export interface ServerSignals {
    google: boolean;
    microsoft: boolean;
    mapsKey: boolean;
    linkedin: boolean;
    withings: boolean;
    imageGen: boolean;
    transcription: boolean;
    /** The instance Google API key (video generation, as the chat tool gate reads it). */
    googleApiKey: boolean;
    elevenlabs: boolean;
    webSearch: boolean;
}

export interface FamilySpec {
    /** The family is in the ceiling when ANY of these capability ids is. */
    capabilities: readonly string[];
    /**
     * A licence feature that is not a capability row (mcp_marketplace): the
     * family is in the ceiling when the organisation has it, by tier or plan
     * grant, the rule requireFeature applies to its routes.
     */
    licenseFeature?: string;
    /** The platform module that must be on (server/modules/catalog.js). */
    module?: string;
    /** A server-wide switch beyond the module (env or instance config). */
    switchedOn?: (s: SwitchFacts) => boolean;
    serverConfigured?: (s: ServerSignals) => boolean;
    /** Nextcloud: the organisation is bound or the family is unavailable. */
    needsBinding?: true;
}

export interface SwitchFacts { meetingNotesEnv: boolean; projectsConfig: boolean }

export const FAMILIES: Readonly<Record<FamilyId, FamilySpec>> = Object.freeze({
    google: { capabilities: GOOGLE_CAPABILITIES, serverConfigured: (s) => s.google },
    microsoft: { capabilities: MICROSOFT_CAPABILITIES, serverConfigured: (s) => s.microsoft },
    // Nextcloud is exempt from the plan ceiling (the resolver grants the NC family
    // to every org); what decides it is the organisation's binding.
    nextcloud: { capabilities: [], needsBinding: true },
    // Per-user token: nothing to set up on the server.
    github: { capabilities: ['github'] },
    // Configured per organisation (its own n8n address and key), not per server.
    n8n: { capabilities: ['n8n'] },
    maps: { capabilities: ['maps'], serverConfigured: (s) => s.mapsKey },
    // mcp_marketplace is a pure licence string, never a capability row
    // (core/entitlements/capabilityRegistry.js), so the snapshot cannot carry it.
    mcp: { capabilities: [], licenseFeature: 'mcp_marketplace' },
    meetingNotes: { capabilities: ['meeting_notes'], module: 'meetingNotes', switchedOn: (f) => f.meetingNotesEnv },
    projects: { capabilities: ['projects'], module: 'projects', switchedOn: (f) => f.projectsConfig },
    learningCenter: { capabilities: ['learning_center'], module: 'learning' },
    automations: { capabilities: ['automations'], module: 'automation' },
    imageGen: { capabilities: ['image-gen'], serverConfigured: (s) => s.imageGen },
});

/** Integration id → whether it needs something on the server, and what. Absent = nothing (per-user or per-org). */
export const SERVER_REQUIREMENT: Readonly<Record<string, (s: ServerSignals) => boolean>> = Object.freeze({
    ...Object.fromEntries(GOOGLE_CAPABILITIES.map(id => [id, (s: ServerSignals) => s.google])),
    ...Object.fromEntries(MICROSOFT_CAPABILITIES.map(id => [id, (s: ServerSignals) => s.microsoft])),
    maps: (s) => s.mapsKey,
    linkedin: (s) => s.linkedin,
    withings: (s) => s.withings,
    'image-gen': (s) => s.imageGen,
    transcription: (s) => s.transcription,
    'video-gen': (s) => s.googleApiKey,
    elevenlabs: (s) => s.elevenlabs,
    'agent-search': (s) => s.webSearch,
});
