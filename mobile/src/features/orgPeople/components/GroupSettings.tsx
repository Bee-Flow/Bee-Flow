/**
 * A group's "Group Settings" on the web: its description (edited in a sheet)
 * and the org role every member inherits ("User (default)" or a role), picked
 * in a sheet that says what each role is for. Each change is its own PUT with
 * the one key, as the web sends it; a role change that reaches members, or
 * grants an admin role, is confirmed first.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { FormSheet, maxLength, useConfirm, useForm } from '@/shared/patterns';
import { Group, SettingRow, TextField, useToast } from '@/shared/ui';

import { RolePickerSheet } from './RolePickerSheet';
import { useUpdateGroup } from '../hooks/groupMutations';
import { isAdminRole, memberCountLabel, roleChoice, roleCopy } from '../model/roles';
import type { OrgGroup } from '../model/types';

function DescriptionSheet({ group, visible, onClose }: { group: OrgGroup; visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const update = useUpdateGroup();
    const form = useForm({
        initial: { description: group.description ?? '' },
        validate: {
            description: [maxLength(2000, t('mobile.orgPeople.description_long', 'That description is too long.'))],
        },
        onSubmit: async ({ description }) => {
            await update.mutateAsync({ id: group.id, patch: { description } });
            form.reset({ description });
            onClose();
        },
    });
    const close = () => {
        form.reset({ description: group.description ?? '' });
        onClose();
    };
    return (
        <FormSheet
            visible={visible}
            onClose={close}
            title={t('mobile.orgPeople.description', 'Description')}
            submitLabel={t('common.save', 'Save')}
            onSubmit={() => void form.submit()}
            submitting={form.submitting}
            canSubmit={form.canSubmit && form.dirty}
            error={form.submitError}
        >
            <TextField
                testID="group-description-input"
                placeholder={t('mobile.orgPeople.description_placeholder', 'Add a description…')}
                multiline
                {...form.field('description')}
            />
        </FormSheet>
    );
}

function useGroupRole(group: OrgGroup, memberCount: number) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const update = useUpdateGroup();
    const current = group.orgRole ?? '';
    const nameOf = (id: string) => (id ? roleCopy(id, t).name : t('mobile.orgPeople.role_default', 'User (default)'));

    const setRole = async (orgRole: string) => {
        if (orgRole === current) return;
        // Everyone in the group inherits it, so a change there, or an admin
        // role at all, is said out loud first.
        if (memberCount > 0 || isAdminRole(orgRole)) {
            const ok = await confirm({
                title: t('mobile.orgPeople.group_role_confirm_title', 'Give {group} the {role} role?', {
                    group: group.name || group.id,
                    role: nameOf(orgRole),
                }),
                message:
                    memberCount > 0
                        ? t('mobile.orgPeople.group_role_confirm_message', 'This changes the role of everyone in the group ({members}).', {
                              members: memberCountLabel(memberCount, t),
                          })
                        : roleCopy(orgRole, t).description,
                confirmLabel: t('mobile.orgPeople.change_role', 'Change role'),
                tone: 'primary',
            });
            if (!ok) return;
        }
        update.mutate({ id: group.id, patch: { orgRole } }, { onError: (e) => toast(describeError(e).message, 'error') });
    };

    return { current, nameOf, setRole, saving: update.isPending };
}

export function GroupSettings({
    group,
    roleIds,
    memberCount,
}: {
    group: OrgGroup;
    roleIds: readonly string[];
    memberCount: number;
}) {
    const t = useTranslation();
    const role = useGroupRole(group, memberCount);
    const [editing, setEditing] = useState(false);
    const [picking, setPicking] = useState(false);
    const options = [
        { id: '', label: role.nameOf(''), description: '' },
        ...roleIds.map((id) => roleChoice(id, t)),
    ];
    return (
        <>
            <Group
                title={t('admin.org_group_settings', 'Group Settings')}
                footer={role.current ? t('mobile.orgPeople.group_role_inherit', 'All members inherit this role.') : undefined}
            >
                <SettingRow
                    testID="group-description-row"
                    label={t('mobile.orgPeople.description', 'Description')}
                    value={group.description || t('common.none', 'None')}
                    onPress={() => setEditing(true)}
                />
                <SettingRow
                    testID="group-role-row"
                    label={t('mobile.orgPeople.group_role', 'Group role')}
                    value={role.nameOf(role.current)}
                    disabled={role.saving}
                    onPress={() => setPicking(true)}
                />
            </Group>
            <RolePickerSheet
                visible={picking}
                onClose={() => setPicking(false)}
                title={t('mobile.orgPeople.group_role', 'Group role')}
                subtitle={group.name || undefined}
                options={options}
                current={role.current}
                onPick={(id) => void role.setRole(id)}
                testIDPrefix="group-role-"
            />
            <DescriptionSheet group={group} visible={editing} onClose={() => setEditing(false)} />
        </>
    );
}
