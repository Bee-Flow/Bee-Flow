/**
 * The overflow menu of a Solution: edit its details, export its Blueprint
 * file, update it to a newer Blueprint, leave it, or delete it — each offered
 * only to someone the server would let do it.
 *
 * Deleting hands everything filed in it back to its owners (the server
 * detaches them first); the confirmation says so, because "delete this
 * Solution" otherwise reads as "delete everything in it".
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { describeError } from '@/core/api/errors';
import { useCurrentUser } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { ActionMenu, useToast, type ActionMenuItem } from '@/shared/ui';

import { useDeleteProject, useRemoveMember } from '../hooks/mutations';
import { useExportSolution } from '../hooks/packageMutations';
import { useProjectMembers } from '../hooks/queries';
import type { SolutionState } from '../hooks/useSolution';
import { ownShare } from '../model/people';

export type SolutionSheet = 'edit' | 'publish' | 'upgrade';

/** Delete, leave and export: the three menu actions that finish without a sheet. */
function useFinishers(id: string, name: string) {
    const t = useTranslation();
    const router = useRouter();
    const confirm = useConfirm();
    const { toast } = useToast();
    const onError = (err: Error) => toast(describeError(err).message, 'error');
    const del = useDeleteProject({ onSuccess: () => router.back() });
    const leave = useRemoveMember(id, { onSuccess: () => router.back() });
    const exported = useExportSolution(id);
    return {
        remove: async () => {
            const ok = await confirm({
                title: t('mobile.projects.delete_title', 'Delete this Solution?'),
                message: t('mobile.projects.delete_message', 'Its chats, automations, apps and pages are not deleted — they go back to whoever made them.'),
                confirmLabel: t('common.delete', 'Delete'),
            });
            if (ok) del.mutate(id, { onError });
        },
        leave: async (shareId: string) => {
            const ok = await confirm({
                title: t('mobile.projects.leave_title', 'Leave this project?'),
                message: t('mobile.projects.leave_message', 'You lose access to what is in it until someone adds you again.'),
                confirmLabel: t('mobile.projects.leave', 'Leave'),
            });
            if (ok) leave.mutate(shareId, { onError });
        },
        exportFile: () => exported.mutate(name, { onError }),
    };
}

export function SolutionMenu({
    id,
    name,
    sol,
    visible,
    onClose,
    onSheet,
}: {
    id: string;
    name: string;
    sol: SolutionState;
    visible: boolean;
    onClose: () => void;
    onSheet: (sheet: SolutionSheet) => void;
}) {
    const t = useTranslation();
    const me = useCurrentUser();
    const members = useProjectMembers(id);
    const mine = sol.isOwner ? null : ownShare(members.data?.members ?? [], me?.id);
    const act = useFinishers(id, name);
    const items: ActionMenuItem[] = [];
    if (sol.canEdit) items.push({ id: 'edit', label: t('mobile.projects.edit_title', 'Edit details'), icon: 'Pencil', onPress: () => onSheet('edit') });
    if (sol.isOwner && sol.packaging) {
        items.push({ id: 'export', label: t('solutions.export', 'Export'), icon: 'Download', onPress: act.exportFile });
    }
    if (sol.isOwner && sol.availability?.state === 'available') {
        items.push({ id: 'upgrade', label: t('solutions.upgrade_title', 'Update this Solution'), icon: 'ArrowUp', onPress: () => onSheet('upgrade') });
    }
    if (mine) {
        items.push({ id: 'leave', label: t('mobile.projects.leave', 'Leave'), icon: 'LogOut', destructive: true, onPress: () => void act.leave(mine.id) });
    }
    if (sol.isOwner) {
        items.push({ id: 'delete', label: t('common.delete', 'Delete'), icon: 'Trash2', destructive: true, onPress: () => void act.remove() });
    }
    return <ActionMenu visible={visible} onClose={onClose} title={name} items={items} testID="solution-actions" />;
}
