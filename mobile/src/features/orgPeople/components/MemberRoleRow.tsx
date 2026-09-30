/**
 * The member's org role — the web's role dropdown, as a "Role" row that opens
 * a picker. The options are "User" and the roles GET /auth/org-roles names.
 * Granting an admin role is confirmed first; stepping down yourself has its
 * own confirm (useChangeMemberRole); a refused change (the last
 * administrator, say) is said, not swallowed.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { SettingRow, useToast } from '@/shared/ui';

import { RolePickerSheet } from './RolePickerSheet';
import { useChangeMemberRole } from '../hooks/useChangeMemberRole';
import { displayName, memberRole } from '../model/members';
import { isAdminRole, roleChoice, roleCopy } from '../model/roles';
import type { Member } from '../model/types';

export function MemberRoleRow({ member, roleIds }: { member: Member; roleIds: readonly string[] }) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const { change, isPending } = useChangeMemberRole();
    const [open, setOpen] = useState(false);
    const current = memberRole(member);

    const pick = async (roleId: string) => {
        const copy = roleCopy(roleId, t);
        if (isAdminRole(roleId)) {
            const ok = await confirm({
                title: t('mobile.orgPeople.grant_role_title', 'Make {name} {role}?', {
                    name: displayName(member),
                    role: copy.name,
                }),
                message: copy.description,
                confirmLabel: t('mobile.orgPeople.change_role', 'Change role'),
                tone: 'primary',
            });
            if (!ok) return;
        }
        try {
            if (await change(member.id, roleId)) toast(t('mobile.orgPeople.role_changed', 'Role changed'), 'success');
        } catch (error) {
            toast(describeError(error).message || t('admin.role_change_failed', 'That role change could not be applied.'), 'error');
        }
    };

    return (
        <>
            <SettingRow
                testID="member-role"
                label={t('mobile.orgPeople.role', 'Role')}
                value={roleCopy(current, t).name}
                disabled={isPending}
                onPress={() => setOpen(true)}
            />
            <RolePickerSheet
                visible={open}
                onClose={() => setOpen(false)}
                title={t('mobile.orgPeople.role', 'Role')}
                subtitle={displayName(member)}
                options={roleIds.map((id) => roleChoice(id, t))}
                current={current}
                onPick={(id) => void pick(id)}
                testIDPrefix="role-option-"
            />
        </>
    );
}
