/**
 * React Query keys for the flow editor.
 *
 * Under the 'automate' prefix the tab has always used, so an invalidation of
 * everything automations still reaches the editor. One routine's editor data
 * sits under `['automate', 'flow', id]`, so leaving or deleting a routine can
 * drop all of it with one prefix. The catalog and the templates belong to the
 * caller, not to a routine.
 */

export const flowKeys = {
    /** Everything the editor caches about one routine. */
    all: (id: string) => ['automate', 'flow', id] as const,
    definition: (id: string) => ['automate', 'flow', id, 'definition'] as const,
    versions: (id: string) => ['automate', 'flow', id, 'versions'] as const,
    version: (id: string, versionId: string) => ['automate', 'flow', id, 'versions', versionId] as const,
    versionDiff: (id: string, a: string, b: string) => ['automate', 'flow', id, 'versions', a, 'diff', b] as const,
    webhooks: (id: string) => ['automate', 'flow', id, 'webhooks'] as const,
    formLinks: (id: string) => ['automate', 'flow', id, 'forms'] as const,
    builderSession: (id: string) => ['automate', 'flow', id, 'builder-session'] as const,
    aiAct: (id: string) => ['automate', 'flow', id, 'ai-act'] as const,
    /** The pending count a save's answer leaves out (GET /:id/counts). */
    counts: (id: string) => ['automate', 'flow', id, 'counts'] as const,

    catalog: ['automate', 'flow-catalog'] as const,
    formPickSources: ['automate', 'flow-catalog', 'form-pick-sources'] as const,
    tableColumns: (tableId: string) => ['automate', 'flow-catalog', 'table-columns', tableId] as const,
    agentPreview: (agentId: string, query: string) => ['automate', 'flow-catalog', 'agent', agentId, query] as const,

    templates: ['automate', 'flow-templates'] as const,
    template: (templateId: string) => ['automate', 'flow-templates', templateId] as const,
    folders: ['automate', 'flow-folders'] as const,
};
