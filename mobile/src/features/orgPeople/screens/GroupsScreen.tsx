/**
 * Groups — the web's Groups tab: every group in the organisation with its
 * member count, and "Create New Group". A group opens its own screen
 * (groups/[id]) for its description, role, tiers and members.
 */

import React, { useState } from 'react';
import type { ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { Button, Screen, ScreenHeader } from '@/shared/ui';

import { CreateGroupSheet } from '../components/CreateGroupSheet';
import { GroupRow, type GroupItem } from '../components/GroupRow';
import { LockedScreen } from '../components/LockedScreen';
import { useGroups, useMembers } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';

const renderItem: ListRenderItem<GroupItem> = ({ item }) => <GroupRow item={item} />;
const keyOf = (item: GroupItem) => item.group.id;
const matchGroup = (item: GroupItem, needle: string) =>
    `${item.group.name} ${item.group.description ?? ''}`.toLowerCase().includes(needle);

export function GroupsScreen() {
    const t = useTranslation();
    const { orgId, isOrgAdmin } = usePeopleAccess();
    const groups = useGroups(isOrgAdmin);
    const members = useMembers(isOrgAdmin);
    const [creating, setCreating] = useState(false);

    const title = t('mobile.orgPeople.groups', 'Groups');
    if (!isOrgAdmin) return <LockedScreen title={title} />;

    const people = members.data ?? [];
    const items = groups.data
        ?.filter((g) => g.id !== '')
        .map((group) => ({ group, memberCount: people.filter((m) => m.groups.includes(group.id)).length }))
        .sort((a, b) => a.group.name.localeCompare(b.group.name));

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title={title}
                actions={
                    <Button
                        testID="open-create-group"
                        size="sm"
                        iconName="Plus"
                        label={t('mobile.orgPeople.new_group', 'New group')}
                        onPress={() => setCreating(true)}
                    />
                }
            />
            <QueryList
                query={{ ...groups, data: items }}
                renderItem={renderItem}
                keyExtractor={keyOf}
                search={{ placeholder: t('admin.org_assign_groups_search', 'Search groups…'), match: matchGroup }}
                empty={{
                    icon: 'Users',
                    title: t('admin.org_no_groups', 'No groups yet'),
                    message: t(
                        'mobile.orgPeople.no_groups_message',
                        'Groups give their members a role, the model tiers they may use and the features they are granted.',
                    ),
                    actionLabel: t('admin.org_new_group', 'Create New Group'),
                    onAction: () => setCreating(true),
                }}
                noMatch={{ title: t('admin.org_assign_groups_no_match', 'No groups match your search.') }}
            />
            <CreateGroupSheet visible={creating} onClose={() => setCreating(false)} orgId={orgId} />
        </Screen>
    );
}
