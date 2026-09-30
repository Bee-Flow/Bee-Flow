/**
 * Contract readers for projects (stores/projectStore.js, projects/membership.js)
 * and the user/group directory. A role the server did not list reads as the
 * narrowest one, `viewer`, never as a role the person does not hold.
 *
 * The Solution-side payloads (summary, graph, checks) are read in
 * ./solutionReaders.ts and the Blueprint ones in ./packageReaders.ts.
 */

import { field, shapeListOf, shapeOf } from '@/core/api/contract';

import { SECTIONS } from '../model/sections';
import type {
    ActivityPage,
    DirectoryGroup,
    DirectoryPerson,
    FiledItem,
    Project,
    ProjectDetail,
    ProjectMembers,
    ProjectResources,
    ProjectRole,
    ProjectShare,
    ProjectThread,
    SectionKey,
} from '../model/types';

export const PROJECT_ROLES: readonly ProjectRole[] = ['owner', 'editor', 'viewer'];

const projectSpec = {
    id: field.str(''),
    name: field.str('Untitled project'),
    description: field.strOrNull,
    customInstructions: field.strOrNull,
    knowledgeBaseIds: field.strArray,
    color: field.strOrNull,
    icon: field.strOrNull,
    ownerId: field.str(''),
    organizationId: field.strOrNull,
    extractMemories: field.optBool,
    version: field.num(0),
    permission: field.optOneOf(PROJECT_ROLES),
    installedFromBlueprintId: field.strOrNull,
    installedVersion: field.numOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
};
export const readProjectRows: (raw: unknown) => Project[] = shapeListOf(projectSpec);

/** POST /api/projects and PUT /api/projects/:id answer the project itself. */
export const readProject: (raw: unknown) => Project = shapeOf(projectSpec);

const readShare: (raw: unknown) => ProjectShare = shapeOf({
    id: field.str(''),
    projectId: field.str(''),
    sharedWithType: field.str('user'),
    sharedWithId: field.str(''),
    permission: field.oneOf(PROJECT_ROLES, 'viewer'),
    createdAt: field.strOrNull,
});

export const readShares = field.list(readShare);

export const readProjectDetail: (raw: unknown) => ProjectDetail = shapeOf({
    ...projectSpec,
    shares: readShares,
    role: field.oneOf(PROJECT_ROLES, 'viewer'),
});

export const readProjectMembers: (raw: unknown) => ProjectMembers = shapeOf({
    ownerId: field.str(''),
    members: readShares,
});

export const readThreadRows: (raw: unknown) => ProjectThread[] = shapeListOf({
    id: field.str(''),
    type: field.str('direct'),
    ownerId: field.str(''),
    projectId: field.str(''),
    title: field.strOrNull,
    updatedAt: field.strOrNull,
    createdAt: field.strOrNull,
});

/**
 * One filed item, whatever its kind. Every spelling of a label and an owner
 * the member listings use is kept; `description` is read too, because the
 * knowledge-base row shows it as its sub-line.
 */
export const readFiledItem: (raw: unknown) => FiledItem = shapeOf({
    id: field.str(''),
    name: field.optStr,
    title: field.optStr,
    prompt: field.optStr,
    description: field.optStr,
    userId: field.optStr,
    ownerId: field.optStr,
    ownerUserId: field.optStr,
    isActive: field.optBool,
    isDraft: field.optBool,
    isPublished: field.optBool,
    status: field.optStr,
});

const sectionReaders = Object.fromEntries(
    SECTIONS.map((s) => [s.key, field.listOrNull(readFiledItem)]),
) as Record<SectionKey, (raw: unknown) => FiledItem[] | null>;

/** Each section `null` when its store was unavailable — kept apart from `[]`. */
export const readProjectResources: (raw: unknown) => ProjectResources = shapeOf({
    role: field.oneOf(PROJECT_ROLES, 'viewer'),
    ...sectionReaders,
});

export const readActivityPage: (raw: unknown) => ActivityPage = shapeOf({
    items: field.list(
        shapeOf({
            id: field.str(''),
            actorId: field.strOrNull,
            action: field.str(''),
            targetType: field.strOrNull,
            targetId: field.strOrNull,
            details: field.record<Record<string, unknown>>({}),
            createdAt: field.strOrNull,
        }),
    ),
    hasMore: field.bool(false),
});

export const readPeople: (raw: unknown) => DirectoryPerson[] = shapeListOf({
    id: field.str(''),
    username: field.optStr,
    displayName: field.optStr,
    email: field.optStr,
});

export const readGroups: (raw: unknown) => DirectoryGroup[] = shapeListOf({
    id: field.str(''),
    name: field.optStr,
});

/** A row a resource picker offers: an id and its words, nothing else. */
export const readCandidates: (raw: unknown) => { id: string; label: string | null }[] = (raw) =>
    shapeListOf({ id: field.str(''), name: field.optStr, title: field.optStr })(raw).map((row) => ({
        id: row.id,
        label: row.name || row.title || null,
    }));
