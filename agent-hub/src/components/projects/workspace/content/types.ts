// What the content tabs share: the props the shell hands every content tab
// (defined once, in the workspace contract ../types.ts) and who may do what.

import type { ProjectRole } from '../../../../api/queries/projects';

export type { ContentIntent, ContentTabProps } from '../types';

/** Editors and the owner add and remove content; viewers only read. */
export function canEditContent(role: ProjectRole | null | undefined): boolean {
    return role === 'owner' || role === 'editor';
}

/**
 * Whether the caller may take an item out of the project: its owner, or the
 * project owner (the server lets the project owner detach a colleague's
 * document, meeting or notebook). Every content card carries its owner's
 * `userId`, so an item whose owner is not known gets no button for anyone
 * but the project owner: offering it would promise what the server refuses.
 */
export function canRemoveItem(role: ProjectRole | null | undefined, itemOwnerId: string | null | undefined, currentUserId: string | null | undefined): boolean {
    if (!canEditContent(role)) return false;
    if (role === 'owner') return true;
    return !!itemOwnerId && !!currentUserId && itemOwnerId === currentUserId;
}
