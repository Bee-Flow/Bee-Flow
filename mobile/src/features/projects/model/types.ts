/**
 * Project shapes, from server/stores/projectStore.js listUserProjects() /
 * getProject() and server/projects/membership.js. They answer camelCase.
 *
 * The Studio calls a project a Solution; the shapes that only the builder's
 * view reads (the summary, the graph, the checks) are in ./solution.ts and
 * the Blueprint ones in ./package.ts.
 */

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface Project {
    id: string;
    name: string;
    description: string | null;
    customInstructions: string | null;
    knowledgeBaseIds: string[];
    color: string | null;
    icon: string | null;
    ownerId: string;
    organizationId: string | null;
    extractMemories?: boolean;
    version: number;
    /** Only on the LIST response; the detail response calls it `role`. */
    permission?: ProjectRole;
    /** Which Blueprint this Solution was installed from; null = built here. */
    installedFromBlueprintId: string | null;
    /** The Blueprint version it was installed at; null when none was recorded. */
    installedVersion: number | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface ProjectShare {
    id: string;
    projectId: string;
    sharedWithType: 'user' | 'group' | (string & {});
    sharedWithId: string;
    permission: ProjectRole;
    createdAt: string | null;
}

export interface ProjectDetail extends Project {
    shares: ProjectShare[];
    role: ProjectRole;
}

export interface ProjectMembers {
    ownerId: string;
    members: ProjectShare[];
}

export interface ProjectThread {
    id: string;
    /** 'direct' opens in the chat screen; 'agent' has no mobile screen yet. */
    type: 'direct' | 'agent' | (string & {});
    ownerId: string;
    projectId: string;
    title: string | null;
    updatedAt: string | null;
    createdAt: string | null;
}

/** The membership sections of server/projects/membership.js, in its order. */
export type SectionKey =
    | 'notebooks'
    | 'automations'
    | 'apps'
    | 'webpages'
    | 'datatables'
    | 'agents'
    | 'skills'
    | 'documentTemplates'
    | 'knowledgeBases'
    | 'approvals';

/**
 * One thing filed into a project, whatever its kind: the stores each spell
 * their label and their owner differently, so the row keeps every spelling
 * the listings use and `sections.ts` decides which one counts per kind.
 */
export interface FiledItem {
    id: string;
    name?: string;
    title?: string;
    /** An approval's identity is the question it asks. */
    prompt?: string;
    description?: string;
    userId?: string;
    ownerId?: string;
    ownerUserId?: string;
    isActive?: boolean;
    isDraft?: boolean;
    isPublished?: boolean;
    status?: string;
}

/**
 * GET /api/projects/:id/resources. Each section is `null` when its store was
 * unavailable — deliberately distinct from `[]` ("none filed"), so the screen
 * can say "could not load" instead of lying that a project is empty.
 */
export type ProjectResources = { role: ProjectRole } & Record<SectionKey, FiledItem[] | null>;

/** One row of GET /api/projects/:id/activity (projectStore.listActivity). */
export interface ActivityItem {
    id: string;
    actorId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    details: Record<string, unknown>;
    createdAt: string | null;
}

export interface ActivityPage {
    items: ActivityItem[];
    hasMore: boolean;
}

// ── Directory (best-effort name resolution) ─────────────────────────

export interface DirectoryPerson {
    id: string;
    username?: string;
    displayName?: string;
    email?: string;
}

export interface DirectoryGroup {
    id: string;
    name?: string;
}

export interface Directory {
    users: DirectoryPerson[];
    groups: DirectoryGroup[];
}
