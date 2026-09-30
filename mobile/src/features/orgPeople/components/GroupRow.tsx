/** One group on the list: name, description, how many are in it, its role. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Badge, ListRow } from '@/shared/ui';

import { memberCountLabel, roleCopy } from '../model/roles';
import type { OrgGroup } from '../model/types';

export interface GroupItem {
    group: OrgGroup;
    memberCount: number;
}

export function GroupRow({ item }: { item: GroupItem }) {
    const t = useTranslation();
    const router = useRouter();
    const { group, memberCount } = item;
    const members = memberCountLabel(memberCount, t);
    return (
        <ListRow
            testID={`group-${group.id}`}
            title={group.name || group.id}
            subtitle={group.description || members}
            meta={group.description ? members : undefined}
            trailing={
                group.source && group.source !== 'manual' ? (
                    <Badge label={t('mobile.orgPeople.synced', 'Synced')} icon="Cloud" />
                ) : group.orgRole && group.orgRole !== 'member' ? (
                    <Badge label={roleCopy(group.orgRole, t).name} tone="accent" />
                ) : undefined
            }
            chevron
            onPress={() => router.push(`/org/groups/${encodeURIComponent(group.id)}`)}
        />
    );
}
