/**
 * React Query keys for projects, under the 'automate' prefix they have always
 * had. Everything about ONE project nests under `project(id)`, so a write can
 * refresh the whole object screen with a single invalidation.
 */

export const projectKeys = {
    projects: ['automate', 'projects'] as const,
    /** The Solutions overview (GET /api/projects/summary). */
    summary: ['automate', 'projects', 'summary'] as const,
    project: (id: string) => ['automate', 'project', id] as const,
    members: (id: string) => ['automate', 'project', id, 'members'] as const,
    resources: (id: string) => ['automate', 'project', id, 'resources'] as const,
    threads: (id: string) => ['automate', 'project', id, 'threads'] as const,
    graph: (id: string) => ['automate', 'project', id, 'graph'] as const,
    completeness: (id: string) => ['automate', 'project', id, 'completeness'] as const,
    activity: (id: string) => ['automate', 'project', id, 'activity'] as const,
    releases: (id: string) => ['automate', 'project', id, 'releases'] as const,
    installs: (id: string) => ['automate', 'project', id, 'installs'] as const,
    upgradePlan: (id: string, blueprintId: string) => ['automate', 'project', id, 'upgrade', blueprintId] as const,
    /** The org-scoped Blueprint gallery (meta only). */
    blueprints: ['automate', 'blueprints'] as const,
    /** What the caller could file into a project, per kind. */
    candidates: (kind: string) => ['automate', 'candidates', kind] as const,
    /** Names for member ids — one best-effort read, shared by every project. */
    directory: ['automate', 'directory'] as const,
};
