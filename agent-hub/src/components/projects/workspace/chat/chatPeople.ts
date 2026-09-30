// Who is in the project, by name, for a team chat: author names on messages,
// "is typing" lines and the @mention menu. Names come from the members
// endpoint's `people` map (owner and user members); a group's individual
// users are not in it, so a caller must be ready for an empty name.

import { useMemo } from 'react';
import { useProjectMembersQuery, type ProjectMembers } from '../../../../api/queries/projects';
import type { WorkspaceUser } from '../types';

export interface ChatPerson { id: string; name: string }

export interface ChatPeople {
    /** Owner and user members that have a display name, the caller included. */
    people: ChatPerson[];
    /** Display name for a user id; '' when the project does not know it. */
    nameOf: (userId: string | null | undefined) => string;
}

export function buildChatPeople(members: ProjectMembers | undefined, currentUser: WorkspaceUser | null): ChatPeople {
    const directory = members?.people || {};
    const ids = new Set<string>();
    if (members?.ownerId) ids.add(members.ownerId);
    for (const m of members?.members || []) {
        if (m.sharedWithType === 'user') ids.add(m.sharedWithId);
    }
    const nameOf = (userId: string | null | undefined): string => {
        if (!userId) return '';
        const person = directory[userId];
        if (person?.name) return person.name;
        if (currentUser && userId === currentUser.id) return currentUser.name || currentUser.email || '';
        return '';
    };
    return { people: [...ids].map(id => ({ id, name: nameOf(id) })).filter(p => p.name), nameOf };
}

export function useChatPeople(projectId: string, currentUser: WorkspaceUser | null): ChatPeople {
    const { data } = useProjectMembersQuery(projectId);
    return useMemo(() => buildChatPeople(data, currentUser), [data, currentUser]);
}
