// Who is in the project, by name, for a team chat: author names on messages,
// "is typing" lines and the @mention menu. Names come from the members
// endpoint's `people` map (owner and user members); a group's individual
// users are not in it, so a caller must be ready for an empty name.

import { useMemo } from 'react';
import { useProjectMembersQuery, type ProjectMembers } from '../../../../api/queries/projects';
import type { WorkspaceUser } from '../types';
import { personColor } from '../memberColors';

export interface ChatPerson { id: string; name: string; avatar?: ChatAvatar; color?: string }

/** A member's own picture: an emoji, or an image path or url. */
export interface ChatAvatar { type: 'emoji' | 'image' | 'url'; value: string }

export interface ChatPeople {
    /** Owner and user members that have a display name, the caller included. */
    people: ChatPerson[];
    /** Display name for a user id; '' when the project does not know it. */
    nameOf: (userId: string | null | undefined) => string;
    /** The colour to paint a person in: the one the project gave them, else one from their name. */
    colorOf: (userId: string | null | undefined) => string;
    /** The member's avatar, when they set one. */
    avatarOf: (userId: string | null | undefined) => ChatAvatar | undefined;
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
    // The reader's own avatar is the one the app shows them (also when it only lives in their session, as a
    // Nextcloud picture does); everybody else's comes with the member list.
    const own = currentUser?.avatar && (currentUser.avatarType === 'emoji' || currentUser.avatarType === 'image' || currentUser.avatarType === 'url')
        ? { type: currentUser.avatarType, value: currentUser.avatar } as ChatAvatar
        : undefined;
    const avatarOf = (userId: string | null | undefined): ChatAvatar | undefined => {
        if (own && userId && userId === currentUser?.id) return own;
        const person = userId ? directory[userId] : undefined;
        return person?.avatar && person.avatarType ? { type: person.avatarType, value: person.avatar } : undefined;
    };
    const colorOf = (userId: string | null | undefined): string => personColor(userId ? directory[userId]?.color : null, nameOf(userId));
    return { people: [...ids].map(id => ({ id, name: nameOf(id), avatar: avatarOf(id), color: colorOf(id) })).filter(p => p.name), nameOf, avatarOf, colorOf };
}

export function useChatPeople(projectId: string, currentUser: WorkspaceUser | null): ChatPeople {
    const { data } = useProjectMembersQuery(projectId);
    return useMemo(() => buildChatPeople(data, currentUser), [data, currentUser]);
}
