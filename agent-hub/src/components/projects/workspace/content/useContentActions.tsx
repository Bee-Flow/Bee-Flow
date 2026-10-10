// Hooks the content tabs share: member names for the "owner" column and the
// "take this out of the project" action with Undo.

import { useCallback, useState } from 'react';
import { useAttachResource, useProjectMembersQuery } from '../../../../api/queries/projects';
import useTranslation from '../../../../hooks/useTranslation';
import { projectErrorText } from '../projectErrorText';
import { toast } from '../../../shared/Toast';

/**
 * A display name for a user id, from the project's member list. The caller
 * reads as "You"; an id the list does not know (a former member) reads as
 * nothing rather than as a raw id.
 */
export function useMemberNames(projectId: string, currentUserId: string | null | undefined) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(projectId);
    const people = members.data?.people;
    return useCallback((userId: string | null | undefined): string => {
        if (!userId) return '';
        if (userId === currentUserId) return t('project_content.you', 'You');
        const person = people?.[userId];
        return person?.name || '';
    }, [people, currentUserId, t]);
}

export interface RemoveCopy {
    /** The toast's line, e.g. "Budget 2027 removed from the project". */
    message: string;
}

/**
 * Take one item out of the project. The item itself is never deleted: it goes
 * back to being its owner's alone, so there is no confirmation, only Undo. The
 * item leaves the list at once; the real call runs when the toast expires and
 * never after Undo. A refusal from the server (not the owner, already gone)
 * brings the item back and is shown as a toast.
 */
export function useRemoveFromProject(projectId: string, kind: string) {
    const { t } = useTranslation();
    const attach = useAttachResource(projectId);
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
    const mark = useCallback((id: string, isGone: boolean) => setGone((prev) => {
        const next = new Set(prev);
        if (isGone) next.add(id); else next.delete(id);
        return next;
    }), []);
    const mutateAsync = attach.mutateAsync;

    const remove = useCallback(async (id: string, copy: RemoveCopy): Promise<boolean> => {
        mark(id, true);
        toast.undoable({
            message: copy.message,
            undoLabel: t('project_home.undo', 'Undo'),
            onUndo: () => mark(id, false),
            onExpire: () => {
                setPendingId(id);
                mutateAsync({ kind, id, attach: false })
                    .catch((e) => {
                        mark(id, false);
                        toast.error(projectErrorText(t, e, t('project_content.remove_failed', 'Could not remove it from the project')));
                    })
                    .finally(() => setPendingId((current) => (current === id ? null : current)));
            },
        });
        return true;
    }, [mutateAsync, kind, mark, t]);

    /** The list without the items taken out and not yet brought back. */
    function without<T extends { id: string }>(items: T[]): T[] {
        return gone.size ? items.filter(item => !gone.has(item.id)) : items;
    }

    return { remove, pendingId, without };
}
