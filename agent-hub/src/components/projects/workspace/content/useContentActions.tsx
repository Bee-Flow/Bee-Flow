// Hooks the content tabs share: member names for the "owner" column and the
// confirmed "take this out of the project" action.

import { useCallback, useState } from 'react';
import { useAttachResource, useProjectMembersQuery } from '../../../../api/queries/projects';
import useTranslation from '../../../../hooks/useTranslation';
import { projectErrorText } from '../projectErrorText';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';

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
    title: string;
    description: string;
    confirmLabel: string;
}

/**
 * Take one item out of the project after a confirmation. The item itself is
 * never deleted: it goes back to being its owner's alone. A refusal from the
 * server (not the owner, already gone) is shown as a toast.
 */
export function useRemoveFromProject(projectId: string, kind: string) {
    const { t } = useTranslation();
    const attach = useAttachResource(projectId);
    const { confirm, confirmDialog } = useConfirm();
    const [pendingId, setPendingId] = useState<string | null>(null);

    const remove = useCallback(async (id: string, copy: RemoveCopy): Promise<boolean> => {
        const ok = await confirm({ ...copy, cancelLabel: t('project_content.cancel', 'Cancel'), destructive: true });
        if (!ok) return false;
        setPendingId(id);
        try {
            await attach.mutateAsync({ kind, id, attach: false });
            return true;
        } catch (e) {
            toast.error(projectErrorText(t, e, t('project_content.remove_failed', 'Could not remove it from the project')));
            return false;
        } finally {
            setPendingId(null);
        }
    }, [attach, confirm, kind, t]);

    return { remove, pendingId, confirmDialog };
}
