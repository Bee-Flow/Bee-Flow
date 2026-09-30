/**
 * Roles & permissions — the web's "Organisation Roles": each role, what it is
 * for, how many members hold it and how much it grants. A role opens its own
 * screen (roles/[id]) where the organisation's switches live. The list is the
 * server's mapping (GET /auth/org-roles), in the web's order; it is bounded
 * (six roles ship), so it is a plain group.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { QueryScreen } from '@/shared/patterns';
import { Group, ListRow, NoteRow, ScreenHeader } from '@/shared/ui';

import { LockedScreen } from '../components/LockedScreen';
import { useMembers, useOrgRoles } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { holdersOf, memberCountLabel, orderedRoleIds, permissionsForRole, roleCopy } from '../model/roles';

export function RolesScreen() {
    const t = useTranslation();
    const router = useRouter();
    const { isOrgAdmin } = usePeopleAccess();
    const roles = useOrgRoles(isOrgAdmin);
    const members = useMembers(isOrgAdmin);

    const title = t('mobile.orgPeople.roles', 'Roles & permissions');
    if (!isOrgAdmin) return <LockedScreen title={title} />;

    return (
        <QueryScreen query={roles} header={() => <ScreenHeader title={title} />}>
            {(data) => (
                <>
                    <Group>
                        <NoteRow>
                            {t(
                                'mobile.orgPeople.roles_how_to_assign',
                                'Give a member a role on their page, or give a whole group a role.',
                            )}
                        </NoteRow>
                    </Group>
                    <Group title={t('admin.org_roles_title', 'Organisation Roles')}>
                        {orderedRoleIds(data.roles).map((id) => {
                            const copy = roleCopy(id, t);
                            const holders = holdersOf(id, members.data ?? []);
                            const grants = permissionsForRole(id, data.roles).length;
                            return (
                                <ListRow
                                    key={id}
                                    testID={`role-${id}`}
                                    title={copy.name}
                                    subtitle={copy.description || undefined}
                                    meta={t('mobile.orgPeople.role_meta', '{members} · {permissions} permissions', {
                                        members: memberCountLabel(holders, t),
                                        permissions: grants,
                                    })}
                                    chevron
                                    onPress={() => router.push(`/org/roles/${encodeURIComponent(id)}`)}
                                />
                            );
                        })}
                    </Group>
                </>
            )}
        </QueryScreen>
    );
}
