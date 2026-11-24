/**
 * Who can be asked for a field of a document a project fills in together: the
 * project's owner and the people it is shared with as editors, by name. Used
 * by the team chat's template_fill_ask_colleague (projects/chatTemplateFillTools.mts)
 * to turn "ask Jan for the price" into a person.
 *
 * The same people the form offers (agent-hub components/documents/fill): a
 * share with a group is not opened up into its members here. Only a name is
 * given, never an e-mail address, and only for people of the project's own
 * organisation; a lookup that fails leaves that person out rather than failing
 * the answer.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Project = { id: string, ownerId?: string | null };
type Share = { sharedWithType?: string, sharedWithId?: string, permission?: string };
type User = { displayName?: unknown, username?: unknown } | null | undefined;
export type Colleague = { id: string, name: string };

export interface ColleagueDeps {
    getProjectShares: (projectId: string) => Promise<Share[] | null | undefined>,
    getUser: (id: string) => Promise<User>,
    /** Whether the person belongs to the project's organisation (projects/projectOrg.js). */
    inProjectOrg: (userId: string, project: Project) => Promise<boolean>,
    displayNameOf: (user: User) => string,
}

const MAX_COLLEAGUES = 200;

export function makeFillColleagues(deps: ColleagueDeps) {
    return async function fillColleagues(project: Project): Promise<Colleague[]> {
        const ids = new Set<string>(project.ownerId ? [project.ownerId] : []);
        for (const share of (await deps.getProjectShares(project.id)) || []) {
            if (share.sharedWithType === 'user' && share.permission === 'editor' && share.sharedWithId) ids.add(share.sharedWithId);
        }
        const people: Colleague[] = [];
        for (const id of [...ids].slice(0, MAX_COLLEAGUES)) {
            try {
                const user = await deps.getUser(id);
                if (user && await deps.inProjectOrg(id, project)) people.push({ id, name: deps.displayNameOf(user) });
            } catch {
                // Left out: one unreadable account does not hide the others.
            }
        }
        return people.sort((a, b) => a.name.localeCompare(b.name));
    };
}

function realDeps(): ColleagueDeps {
    const projectOrg = () => nodeRequire('./projectOrg') as {
        projectOrgOf: (p: Project) => Promise<string>, belongsToProjectOrg: (userId: string, org: string) => Promise<boolean> };
    return {
        getProjectShares: (projectId) => nodeRequire('../stores/projectStore').getProjectShares(projectId),
        getUser: (id) => nodeRequire('../stores/userStore').getUser(id),
        inProjectOrg: async (userId, project) => projectOrg().belongsToProjectOrg(userId, await projectOrg().projectOrgOf(project)),
        displayNameOf: (user) => nodeRequire('./chatPromptParts').displayNameOf(user),
    };
}

export const fillColleagues = (project: Project): Promise<Colleague[]> => makeFillColleagues(realDeps())(project);
