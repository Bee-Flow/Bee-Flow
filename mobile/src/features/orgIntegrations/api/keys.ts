/** Query keys for the organisation's integration settings. */

export const integrationKeys = {
    all: ['org-integrations'] as const,
    mapsKey: ['org-integrations', 'maps-key'] as const,
    ncIntegrations: (orgId: string) => ['org-integrations', 'nc', orgId] as const,
    ncIntegrationGroups: (orgId: string) => ['org-integrations', 'nc-groups', orgId] as const,
    activeFeatures: ['org-integrations', 'active-features'] as const,
    n8n: {
        all: ['org-integrations', 'n8n'] as const,
        config: ['org-integrations', 'n8n', 'config'] as const,
        diagnostics: ['org-integrations', 'n8n', 'diagnostics'] as const,
        permissions: ['org-integrations', 'n8n', 'permissions'] as const,
    },
    nextcloud: {
        sync: (orgId: string) => ['org-integrations', 'nc-sync', orgId] as const,
        groups: (orgId: string) => ['org-integrations', 'nc-sync', orgId, 'groups'] as const,
        users: (orgId: string) => ['org-integrations', 'nc-sync', orgId, 'users'] as const,
        pairing: ['org-integrations', 'nc-pairing'] as const,
        talk: (orgId: string) => ['org-integrations', 'talk-notes', orgId] as const,
        meet: (orgId: string) => ['org-integrations', 'meet-notes', orgId] as const,
    },
    github: {
        all: ['org-integrations', 'github'] as const,
        status: ['org-integrations', 'github', 'status'] as const,
        details: ['org-integrations', 'github', 'details'] as const,
    },
    azure: (orgId: string) => ['org-integrations', 'azure', orgId] as const,
};
