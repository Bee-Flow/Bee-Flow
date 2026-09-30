/**
 * Users & Groups — the hub of the web's OrgUsersPanel (users | groups | roles
 * | customTiers | sync), one row per sub-section, with the two things the web
 * puts above its member list: the pending-approval banner (OrgHealthBanner's
 * pending half, counted from the roster) and the SSO auto-approve toggle.
 *
 * Someone holding only `manage_users` may read the roster; everything else
 * here is the org administrator's (see usePeopleAccess).
 */

import { useRouter, type Href } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import {
    Banner,
    Button,
    Group,
    GroupedScroll,
    Icon,
    Screen,
    ScreenHeader,
    ListRow,
    Text,
    type IconName,
} from '@/shared/ui';

import { AutoApproveGroup } from '../components/AutoApproveGroup';
import { LockedScreen } from '../components/LockedScreen';
import { useGroups, useInvitations, useMembers, useOrgRoles } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { orgMembers, pendingCount } from '../model/members';
import { orderedRoleIds } from '../model/roles';

/** One hub row: what the screen is, a line on what it is for, and a count. */
function HubRow({
    testID,
    label,
    hint,
    icon,
    count,
    href,
}: {
    testID: string;
    label: string;
    hint: string;
    icon: IconName;
    count?: number;
    href: Href;
}) {
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            testID={testID}
            title={label}
            subtitle={hint}
            meta={count === undefined ? undefined : String(count)}
            leading={<Icon name={icon} size={18} color={theme.colors.textSecondary} />}
            chevron
            onPress={() => router.push(href)}
        />
    );
}

export function PeopleScreen() {
    const t = useTranslation();
    const router = useRouter();
    const { orgId, isOrgAdmin, isNcOrg, canSeePeople } = usePeopleAccess();
    const members = useMembers(canSeePeople);
    const groups = useGroups(isOrgAdmin);
    const invitations = useInvitations(isOrgAdmin);
    const roles = useOrgRoles(isOrgAdmin);
    const refresh = useUserRefresh(() => Promise.all([members.refetch(), groups.refetch(), invitations.refetch()]));

    const title = t('settings.users_groups', 'Users & Groups');
    if (!canSeePeople || !orgId) return <LockedScreen title={title} manageUsers />;

    const people = members.data ? orgMembers(members.data) : undefined;
    const pending = people ? pendingCount(people) : 0;
    const openInvites = invitations.data?.filter((i) => (i.status ?? 'pending') === 'pending').length;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={title} />
            <GroupedScroll refresh={refresh}>
                {pending > 0 ? (
                    <Banner
                        tone="warning"
                        icon="UserCheck"
                        action={
                            <Button
                                size="sm"
                                variant="warning"
                                label={t('admin.org_health_show_pending', 'Show pending')}
                                onPress={() => router.push('/org/members?status=pending')}
                            />
                        }
                    >
                        <View>
                            <Text variant="caption" weight="semibold">
                                {t('admin.org_health_pending', '{count} user(s) are waiting for approval and cannot use AI yet.', {
                                    count: pending,
                                })}
                            </Text>
                            <Text variant="caption" tone="tertiary">
                                {t('mobile.orgPeople.pending_hint', 'Approve them in the member list to unlock access.')}
                            </Text>
                        </View>
                    </Banner>
                ) : null}

                <Group title={t('mobile.orgPeople.people', 'People')}>
                    <HubRow
                        testID="people-members"
                        label={t('mobile.orgPeople.members', 'Members')}
                        hint={t('mobile.orgPeople.hint_members', 'Who is in your organisation and what they may do')}
                        icon="Users"
                        count={people?.length}
                        href="/org/members"
                    />
                    {isOrgAdmin ? (
                        <HubRow
                            testID="people-invitations"
                            label={t('mobile.orgPeople.invitations', 'Invitations')}
                            hint={t('mobile.orgPeople.hint_invitations', 'Invite people and revoke open invitations')}
                            icon="Send"
                            count={openInvites}
                            href="/org/invitations"
                        />
                    ) : null}
                </Group>

                {isOrgAdmin ? (
                    <Group title={t('mobile.orgPeople.structure', 'Groups and permissions')}>
                        <HubRow
                            testID="people-groups"
                            label={t('mobile.orgPeople.groups', 'Groups')}
                            hint={t('mobile.orgPeople.hint_groups', 'Groups, their members, roles and model tiers')}
                            icon="Users"
                            count={groups.data?.length}
                            href="/org/groups"
                        />
                        <HubRow
                            testID="people-roles"
                            label={t('mobile.orgPeople.roles', 'Roles & permissions')}
                            hint={t('mobile.orgPeople.hint_roles', 'What each organisation role may do')}
                            icon="Shield"
                            count={roles.data ? orderedRoleIds(roles.data.roles).length : undefined}
                            href="/org/roles"
                        />
                        <HubRow
                            testID="people-model-tiers"
                            label={t('mobile.orgPeople.model_tiers', 'Model tiers')}
                            hint={t('mobile.orgPeople.hint_model_tiers', 'The organisation’s own model tiers')}
                            icon="Sparkles"
                            href="/org/model-tiers"
                        />
                        <HubRow
                            testID="people-access"
                            label={t('mobile.org.section_access', 'Access & features')}
                            hint={t('mobile.orgPeople.hint_access', 'Which features and integrations each group may use')}
                            icon="KeySquare"
                            href="/org/access"
                        />
                        {isNcOrg ? (
                            <HubRow
                                testID="people-nextcloud"
                                label={t('settings.nextcloud_sync', 'Nextcloud Sync')}
                                hint={t('mobile.orgPeople.hint_nextcloud', 'Users and groups from Nextcloud, pairing and meeting notes')}
                                icon="Cloud"
                                href="/org/nextcloud"
                            />
                        ) : null}
                    </Group>
                ) : null}

                {isOrgAdmin ? <AutoApproveGroup orgId={orgId} /> : null}
            </GroupedScroll>
        </Screen>
    );
}
