// Fixtures shared by the content tab tests: one project, its members, the
// common tab props, and a GET router for the mocked apiClient.
//
// Imported by *.test.tsx files only.

import type { Project, ProjectMembers, ProjectRole } from '../../../../api/queries/projects';
import type { ContentTabProps } from './types';

export const OWNER_ID = 'u-owner';
export const EDITOR_ID = 'u-editor';
export const VIEWER_ID = 'u-viewer';

export const PROJECT: Project = {
    id: 'p1',
    name: 'Launch plan',
    ownerId: OWNER_ID,
    organizationId: 'org-1',
    kind: 'workspace',
    filesKbId: 'kb-files',
};

export const MEMBERS: ProjectMembers = {
    ownerId: OWNER_ID,
    members: [
        { id: 's1', sharedWithType: 'user', sharedWithId: EDITOR_ID, permission: 'editor' },
        { id: 's2', sharedWithType: 'user', sharedWithId: VIEWER_ID, permission: 'viewer' },
    ],
    people: {
        [OWNER_ID]: { name: 'Olivia Owner' },
        [EDITOR_ID]: { name: 'Eddie Editor' },
        [VIEWER_ID]: { name: 'Vera Viewer' },
    },
    groups: {},
};

const USER_OF: Record<ProjectRole, string> = { owner: OWNER_ID, editor: EDITOR_ID, viewer: VIEWER_ID };

export interface TabHandlers {
    onOpenSub: (sub: string | null) => void;
    onNavigate: (page: string) => void;
}

/** The props the shell hands every content tab, as `role` would see it. */
export function tabProps(role: ProjectRole, handlers: TabHandlers, extra: Partial<ContentTabProps> = {}): ContentTabProps {
    return {
        projectId: PROJECT.id,
        project: PROJECT,
        role,
        currentUser: { id: USER_OF[role], name: MEMBERS.people[USER_OF[role]]?.name },
        sub: null,
        intent: null,
        ...handlers,
        ...extra,
    };
}

export type RouteAnswer = unknown | Error | (() => unknown);

/**
 * A `get` implementation answering by path (query string ignored). An Error
 * value rejects; a function is called per request (for pending promises or
 * answers that change); an unknown path rejects loudly.
 */
export function getRouter(routes: Record<string, RouteAnswer>) {
    return (path: string) => {
        if (!(path in routes)) return Promise.reject(new Error(`unexpected GET ${path}`));
        const answer = routes[path];
        if (answer instanceof Error) return Promise.reject(answer);
        if (typeof answer === 'function') return Promise.resolve((answer as () => unknown)());
        return Promise.resolve(answer);
    };
}

/** A promise that never settles: a request still in flight. */
export function pending(): Promise<never> {
    return new Promise<never>(() => {});
}
