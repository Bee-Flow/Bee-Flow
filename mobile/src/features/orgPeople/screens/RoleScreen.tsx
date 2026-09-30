/**
 * One organisation role: what it is for, the permissions the organisation may
 * switch on or off for it, and what it grants that is fixed. Saving sends the
 * FULL editable choice (PUT /auth/org-roles/:roleId { permissions }) and shows
 * what the server stored, as the web's RolePermissionEditor does. The header
 * says how many members hold the role, and a row lists them. Leaving with an
 * unsaved choice (Back, a swipe) asks first.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { QueryScreen, useConfirmLeave } from '@/shared/patterns';
import { Group, GroupedScroll, NoteRow, SaveBar, ScreenHeader, SettingRow, useToast } from '@/shared/ui';

import { LockedScreen } from '../components/LockedScreen';
import { EditablePermissions, FixedPermissions } from '../components/RolePermissions';
import { useSaveRolePermissions } from '../hooks/policyMutations';
import { useMembers, useOrgRoles } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { editableRows, fixedPermissions, holdersOf, memberCountLabel, roleCopy, sameSet } from '../model/roles';
import type { OrgRoles } from '../model/types';

function RoleBody({ roleId, data, holders }: { roleId: string; data: OrgRoles; holders: number }) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const save = useSaveRolePermissions();
    const [draft, setDraft] = useState<string[] | null>(null);

    const rows = editableRows(roleId, data.roles, data.editablePermissions);
    const saved = rows.filter((r) => r.granted).map((r) => r.id);
    const current = draft ?? saved;
    const dirty = draft !== null && !sameSet(draft, saved);
    useConfirmLeave(dirty);
    const withEditor = rows.length > 0;
    const copy = roleCopy(roleId, t);

    const toggle = (id: string) =>
        setDraft(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
    const onSave = () =>
        save.mutate(
            { roleId, permissions: current },
            {
                onSuccess: () => setDraft(null),
                onError: (e) =>
                    toast(describeError(e).message || t('admin.org_roles_save_failed', 'Could not save this role.'), 'error'),
            },
        );

    return (
        <>
            <GroupedScroll>
                {copy.description ? (
                    <Group>
                        <NoteRow>{copy.description}</NoteRow>
                    </Group>
                ) : null}
                {holders > 0 ? (
                    <Group>
                        <SettingRow
                            testID="role-holders"
                            label={t('mobile.orgPeople.role_holders', 'Members with this role ({count})', { count: holders })}
                            onPress={() => router.push(`/org/members?role=${encodeURIComponent(roleId)}`)}
                        />
                    </Group>
                ) : null}
                <EditablePermissions rows={rows} granted={current} disabled={save.isPending} onToggle={toggle} />
                <FixedPermissions
                    ids={fixedPermissions(roleId, data.roles, data.editablePermissions, withEditor)}
                    withEditor={withEditor}
                />
            </GroupedScroll>
            <SaveBar dirty={dirty} saving={save.isPending} onSave={onSave} onDiscard={() => setDraft(null)} />
        </>
    );
}

export function RoleScreen({ id }: { id: string }) {
    const t = useTranslation();
    const { isOrgAdmin } = usePeopleAccess();
    const roles = useOrgRoles(isOrgAdmin);
    const members = useMembers(isOrgAdmin);
    if (!isOrgAdmin) return <LockedScreen title={t('mobile.orgPeople.roles', 'Roles & permissions')} />;
    const holders = holdersOf(id, members.data ?? []);
    return (
        <QueryScreen
            query={roles}
            scroll={false}
            header={() => (
                <ScreenHeader
                    title={roleCopy(id, t).name}
                    subtitle={members.data ? memberCountLabel(holders, t) : undefined}
                />
            )}
        >
            {(data) => <RoleBody roleId={id} data={data} holders={holders} />}
        </QueryScreen>
    );
}
