// Old admin dashboard addresses and where each one lands now, in one table.
// A bookmark, a link in a sent e-mail, a Learning Center lesson, a compliance
// remediation link or a server-written notification path does not expire, so
// an address that moved keeps working here instead of being rewritten at every
// writer. resolveAdminTab (adminTabs) applies the table before it picks a tab;
// the Organisation tab's own renamed sections are ORG_SECTION_ALIASES, applied
// where its open section is chosen (organisation/orgSections openOrgSection).
//
// Pure data and functions with no imports, so every module of the dashboard can
// read it without closing an import cycle. adminPathAliases.test.ts holds every
// target to a registered tab or rail row, and every admin address the server
// and the Settings redirects write to one that resolves.

/**
 * The old section ids and tab names of the AI configuration page (inner "go
 * to ..." buttons, old links) to its section ids: the chat models are Models,
 * the embeddings and both web-search pages are Search & retrieval.
 */
export const AI_CONFIG_LEGACY_SECTIONS: Readonly<Record<string, string>> = {
    chatModels: 'models',
    'chat-models': 'models',
    directChat: 'direct-chat',
    embeddings: 'retrieval',
    'web-search': 'retrieval',
    webSearchInference: 'retrieval',
};

/** The Agents hub's sections, once addressable on their own as admin/<section> (/admin/chat). */
const AGENT_SECTION_IDS: readonly string[] = ['chat', 'system'];

/** The Guardrail library's sections, once tabs of Security > Guardrails. */
const GUARDRAIL_LIBRARY_SECTIONS: readonly string[] = ['presets', 'patterns', 'terms', 'pii', 'dlp', 'directchat'];

/**
 * The tabs of the old Security > Users screen (admin/security/users/<tab>) to
 * the row each one is now: the organisation's own people under People, the
 * server-wide lists under their whole-server rows, the organisation's model
 * tiers and Nextcloud sync and its own details under the Organisation tab.
 */
const SECURITY_USERS_TABS: Readonly<Record<string, string>> = {
    organizations: 'organisations',
    nextcloud: 'nextcloud-instances',
    roles: 'roles',
    permissions: 'roles/permissions',
    'custom-tiers': 'organisation/models',
    sync: 'organisation/nextcloud-sync',
    'my-organization': 'organisation/info',
};

/**
 * Old ids of the Organisation tab's sections to the current ones: the Settings
 * tab ids (underscored, as OrganisationSection still names them) of the
 * sections whose address uses dashes, and the sections that were renamed or
 * split (AI context is Conversations, Memory and Projects now; Conversations
 * holds what the old page opened with).
 */
export const ORG_SECTION_ALIASES: Readonly<Record<string, string>> = {
    ai_context: 'conversations',
    'ai-context': 'conversations',
    integration_cache: 'integration-cache',
    meeting_templates: 'meeting-notes',
    'meeting-templates': 'meeting-notes',
    mcp_access: 'mcp-access',
    github_sync: 'github-sync',
    nextcloud_sync: 'nextcloud-sync',
};

/**
 * Old `seg1[/seg2[/seg3]]` under admin/ to the path it opens now. The most
 * specific key wins; the segments after the matched key follow the target.
 * A target is never itself a key (no chains).
 */
export const ADMIN_PATH_ALIASES: Readonly<Record<string, string>> = {
    ...Object.fromEntries(AGENT_SECTION_IDS.map(id => [id, `agents/${id}`])),
    ...Object.fromEntries(Object.entries(AI_CONFIG_LEGACY_SECTIONS).map(([old, id]) => [`ai-config/${old}`, `ai-config/${id}`])),
    // The reranker had a pane in the provider list; it is part of Search & retrieval now.
    'ai-config/providers/reranker': 'ai-config/retrieval',
    // The Usage explorer's tables are Spend's views now.
    'monitoring/usage': 'monitoring/spend',
    // Security > Users became People; the rest of its tabs moved out.
    'security/users': 'people',
    ...Object.fromEntries(Object.entries(SECURITY_USERS_TABS).map(([tab, to]) => [`security/users/${tab}`, to])),
    'security/email-domains': 'security/sso/email-domains',
    'security/connector-health': 'nextcloud-instances/health',
    // Guardrails: the per-organisation shield is the Privacy Shield row, the server console the Guardrail library.
    'security/guardrails/organisations': 'security/guardrails',
    ...Object.fromEntries(GUARDRAIL_LIBRARY_SECTIONS.map(id => [`security/guardrails/${id}`, `security/guardrail-library/${id}`])),
    // Integrations became Platform services; its features, search and MCP pages moved out.
    'integrations/integrations': 'integrations/defaults',
    'integrations/services': 'integrations/connected-apps',
    'integrations/features': 'licenses/features',
    'integrations/search': 'ai-config/retrieval',
    'integrations/mcp': 'mcp-servers',
    'organisation/mcp/server': 'mcp-servers',
    ...Object.fromEntries(Object.entries(ORG_SECTION_ALIASES).map(([old, id]) => [`organisation/${old}`, `organisation/${id}`])),
};

/**
 * A tab named without a section, to the one the same address opens instead
 * when the viewer may open that one: the old Security tab without a section was
 * the people list, which People now holds (Security itself gave way to its
 * rows and has no page of its own).
 */
export const BARE_TAB_FALLBACKS: Readonly<Record<string, string>> = {
    security: 'people',
};

/** The current id of an Organisation section an address names. */
export function orgSectionAlias(id: string | undefined): string | undefined {
    return id && Object.hasOwn(ORG_SECTION_ALIASES, id) ? ORG_SECTION_ALIASES[id] : id;
}

/** An admin address as its three segments (admin/<seg1>/<seg2>/<seg3>). */
export interface AdminPath {
    seg1?: string;
    seg2?: string;
    seg3?: string;
}

export type ResolvedAdminPath = Required<AdminPath>;

/** The path an old address opens now: the longest alias that matches, the rest of the segments after its target. */
export function resolveAdminPath({ seg1 = '', seg2 = '', seg3 = '' }: AdminPath): ResolvedAdminPath {
    const segs = [seg1, seg2, seg3];
    for (let n = 3; n >= 1; n--) {
        const head = segs.slice(0, n);
        if (head.some(s => !s)) continue;
        const key = head.join('/');
        if (!Object.hasOwn(ADMIN_PATH_ALIASES, key)) continue;
        const [a = '', b = '', c = ''] = [...ADMIN_PATH_ALIASES[key].split('/'), ...segs.slice(n)];
        return { seg1: a, seg2: b, seg3: c };
    }
    return { seg1, seg2, seg3 };
}
