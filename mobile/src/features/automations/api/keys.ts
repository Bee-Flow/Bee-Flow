/**
 * React Query keys for automations and their runs.
 *
 * Every key starts with 'automate', the prefix the tab has always used; the
 * tasks, projects, apps and approvals features keep the same prefix for their
 * own keys, so nothing that invalidates by prefix changes meaning.
 */

export const automationKeys = {
    automations: ['automate', 'automations'] as const,
    automation: (id: string) => ['automate', 'automation', id] as const,
    runs: (automationId: string) => ['automate', 'runs', automationId] as const,
    /** One page of a run list, filtered by a status CSV (or 'all'). */
    runsFiltered: (automationId: string, status: string | undefined) =>
        ['automate', 'runs', automationId, status ?? 'all'] as const,
    recentRuns: ['automate', 'runs', 'recent'] as const,
    activeRuns: ['automate', 'runs', 'active'] as const,
    run: (runId: string) => ['automate', 'run', runId] as const,
    runSteps: (runId: string) => ['automate', 'run', runId, 'steps'] as const,
    schedulePreview: (cron: string, tz: string) => ['automate', 'schedule-preview', cron, tz] as const,
    /**
     * Every approvals list (the inbox, the drawer badge, the Cowork hub's
     * pointer): approvalKeys.approvals(scope) sits under it. Here, not in
     * approvals, because a run step's decision is made from a run screen and
     * automations may not import approvals (approvals imports automations).
     */
    approvalLists: ['automate', 'approvals'] as const,
    /** Which app buttons start this routine (GET /:id/usage). */
    usage: (id: string) => ['automate', 'automation', id, 'usage'] as const,
};
