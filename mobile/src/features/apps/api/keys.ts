/** React Query keys for Studio apps, under the Automate tab's 'automate' prefix. */

export const appKeys = {
    apps: ['automate', 'apps'] as const,
    appRuntime: (id: string, draft = false) => ['automate', 'app', id, 'runtime', draft ? 'draft' : 'published'] as const,
    /** The poll of one 202'd action run. */
    actionRun: (appId: string, runId: string | null) => ['automate', 'app-run', appId, runId] as const,
};
