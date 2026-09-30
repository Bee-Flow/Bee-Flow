/**
 * The organisation's members — the web's Users tab (OrgUsersPanel): search,
 * role and status filters, pending sign-ups first with Approve / Reject, and
 * a row that opens the member's own screen (members/[id]) to be edited.
 * Invite opens the invite sheet right here; the Invitations screen keeps the
 * list of open invitations and their revoke.
 *
 * `GET /auth/users` scopes itself to the caller's organisations server-side,
 * and the list trusts that: only the system account is dropped, as on the
 * web. Someone holding `manage_users` sees the list; changing anyone in it is
 * the org administrator's (requireOrgAdminForUser).
 */

import React, { useState } from 'react';
import type { ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { Button, Screen, ScreenHeader } from '@/shared/ui';

import { InviteLinkBanner } from '../components/InviteLinkBanner';
import { InviteSheet } from '../components/InviteSheet';
import { LockedScreen } from '../components/LockedScreen';
import { MemberFilterBar } from '../components/MemberFilterBar';
import { MemberRow } from '../components/MemberRow';
import { useMembers, useOrgRoles } from '../hooks/queries';
import { useInviteFlow } from '../hooks/useInviteFlow';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { matchesFilters, NO_FILTERS, orgMembers, sortMembers, type MemberFilters } from '../model/members';
import { roleOptions } from '../model/roles';
import type { Member } from '../model/types';

const renderItem: ListRenderItem<Member> = ({ item }) => <MemberRow member={item} />;
const keyOf = (item: Member) => item.id;

export function OrgMembersScreen({ initialStatus, initialRole }: { initialStatus?: string; initialRole?: string }) {
    const t = useTranslation();
    const { isOrgAdmin, canSeePeople } = usePeopleAccess();
    const [filters, setFilters] = useState<MemberFilters>({
        ...NO_FILTERS,
        status: initialStatus === 'pending' || initialStatus === 'active' ? initialStatus : 'all',
        role: initialRole || 'all',
    });
    const members = useMembers(canSeePeople);
    const roles = useOrgRoles(canSeePeople);
    const invite = useInviteFlow(isOrgAdmin);

    const title = t('mobile.orgPeople.members', 'Members');
    if (!canSeePeople) return <LockedScreen title={title} manageUsers />;

    const people = members.data ? sortMembers(orgMembers(members.data)) : undefined;
    const shown = people?.filter((m) => matchesFilters(m, filters)).length ?? 0;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title={title}
                subtitle={t('admin.org_members_desc', 'Manage roles and group assignments for users in your organisation')}
                actions={
                    isOrgAdmin ? (
                        <Button
                            testID="members-invite"
                            size="sm"
                            iconName="Send"
                            label={t('mobile.orgPeople.invite', 'Invite')}
                            onPress={invite.open}
                        />
                    ) : undefined
                }
            />
            {invite.manualLink ? <InviteLinkBanner url={invite.manualLink} onDismiss={invite.dismissLink} /> : null}
            <MemberFilterBar
                filters={filters}
                onChange={setFilters}
                roleIds={roleOptions(roles.data?.roles ?? [])}
                shown={shown}
                total={people?.length ?? 0}
            />
            <QueryList
                query={{ ...members, data: people }}
                renderItem={renderItem}
                keyExtractor={keyOf}
                filter={(m) => matchesFilters(m, filters)}
                empty={{
                    icon: 'Users',
                    title: t('admin.org_no_users', 'No users yet'),
                    message: t(
                        'admin.org_no_users_desc',
                        'Users will appear here once they are assigned to your organisation. Add users via the admin panel or invite them by sharing a signup link.',
                    ),
                }}
                noMatch={{ title: t('admin.org_no_matches', 'No users match the current filters.') }}
            />
            {isOrgAdmin ? <InviteSheet {...invite.sheet} /> : null}
        </Screen>
    );
}
