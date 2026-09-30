/**
 * What an org administrator can change on one member: their role, their
 * groups, their two-factor authentication (the web's UserManagement offers
 * the reset to org admins, BFSF-274), and — for someone already in — deleting
 * the account. That is what DELETE /auth/users/:id does: it removes the user,
 * not just their place in this organisation, so the row says "Delete user"
 * and the confirm names who. A pending sign-up's Approve / Reject sit at the
 * top of the page instead (PendingMemberActions).
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { Group, SettingRow, useToast } from '@/shared/ui';

import { MemberGroupsRow } from './MemberGroupsRow';
import { MemberRoleRow } from './MemberRoleRow';
import { useDeleteMember, useResetMemberMfa } from '../hooks/memberMutations';
import { displayName, isPending } from '../model/members';
import type { Member, OrgGroup } from '../model/types';

function useMemberDangerActions(member: Member) {
    const t = useTranslation();
    const router = useRouter();
    const confirm = useConfirm();
    const { toast } = useToast();
    const remove = useDeleteMember();
    const resetMfa = useResetMemberMfa();
    const onError = (error: unknown) => toast(describeError(error).message, 'error');
    const name = displayName(member);

    const onDelete = async () => {
        const ok = await confirm({
            title: t('mobile.orgPeople.delete_named_title', 'Delete {name}?', { name }),
            message: t('admin.sec_delete_user_desc', 'The account is removed and cannot be restored.'),
            confirmLabel: t('admin.sec_delete', 'Delete'),
        });
        if (ok) remove.mutate(member.id, { onError, onSuccess: () => router.back() });
    };

    const onResetMfa = async () => {
        const ok = await confirm({
            title: t('admin.sec_reset_mfa_title', 'Reset two-factor authentication?'),
            message: t(
                'admin.reset_mfa_confirm',
                'Reset two-factor authentication for {name}? Their authenticator and recovery codes stop working immediately; they will be asked to enroll again at their next sign-in.',
                { name },
            ),
            confirmLabel: t('admin.reset_mfa', 'Reset 2FA'),
        });
        if (!ok) return;
        resetMfa.mutate(member.id, {
            onError,
            onSuccess: ({ wasEnabled }) =>
                toast(
                    wasEnabled
                        ? t('admin.reset_mfa_done', 'Two-factor authentication was reset.')
                        : t('admin.reset_mfa_not_enabled', 'This user has no two-factor authentication enabled.'),
                    'success',
                ),
        });
    };

    return { onDelete, onResetMfa, deleting: remove.isPending, resetting: resetMfa.isPending };
}

export function MemberActions({
    member,
    groups,
    roleIds,
}: {
    member: Member;
    groups: readonly OrgGroup[];
    /** 'user' plus the org roles, in picker order. */
    roleIds: readonly string[];
}) {
    const t = useTranslation();
    const danger = useMemberDangerActions(member);

    return (
        <Group title={t('mobile.orgPeople.manage', 'Manage')}>
            <MemberRoleRow member={member} roleIds={roleIds} />
            <MemberGroupsRow member={member} groups={groups} />
            {member.mfaEnabled ? (
                <SettingRow
                    testID="member-reset-mfa"
                    label={t('admin.reset_mfa', 'Reset 2FA')}
                    disabled={danger.resetting}
                    onPress={() => void danger.onResetMfa()}
                />
            ) : null}
            {isPending(member) ? null : (
                <SettingRow
                    testID="member-remove"
                    destructive
                    label={t('mobile.orgPeople.delete_user', 'Delete user')}
                    disabled={danger.deleting}
                    onPress={() => void danger.onDelete()}
                />
            )}
        </Group>
    );
}
