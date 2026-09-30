/**
 * The member's groups — the web's user → group flow: a row that names the
 * groups they are in, opening a sheet of switches. Each switch sends the
 * member's whole list with the one group toggled. With no groups yet, the
 * sheet points at the Groups screen to make one.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { SettingRow, useToast } from '@/shared/ui';

import { ToggleListSheet, type ToggleItem } from './ToggleListSheet';
import { useUpdateMember } from '../hooks/memberMutations';
import { toggledGroups } from '../model/members';
import type { Member, OrgGroup } from '../model/types';

export function MemberGroupsRow({ member, groups }: { member: Member; groups: readonly OrgGroup[] }) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const update = useUpdateMember();
    const [open, setOpen] = useState(false);
    const onError = (error: unknown) => toast(describeError(error).message, 'error');
    const items: ToggleItem[] = groups.map((g) => ({
        id: g.id,
        label: g.name,
        description: g.description || undefined,
        on: member.groups.includes(g.id),
        disabled: update.isPending,
        toggle: () => update.mutate({ id: member.id, patch: { groups: toggledGroups(member.groups, g.id) } }, { onError }),
    }));
    const names = items.filter((i) => i.on).map((i) => i.label);
    return (
        <>
            <SettingRow
                testID="member-groups"
                label={t('admin.org_assign_groups', 'Assign groups')}
                value={names.length > 0 ? names.join(', ') : t('common.none', 'None')}
                onPress={() => setOpen(true)}
            />
            <ToggleListSheet
                visible={open}
                onClose={() => setOpen(false)}
                title={t('admin.org_assign_groups_title', 'Groups')}
                items={items}
                emptyTitle={t('admin.org_assign_groups_none', 'No groups in this organisation yet.')}
                emptyAction={{
                    label: t('admin.org_new_group', 'Create New Group'),
                    onPress: () => router.push('/org/groups'),
                }}
                searchPlaceholder={t('admin.org_assign_groups_search', 'Search groups…')}
                noMatchTitle={t('admin.org_assign_groups_no_match', 'No groups match your search.')}
            />
        </>
    );
}
