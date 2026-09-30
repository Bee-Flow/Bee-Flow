/**
 * A group's members — the web's reciprocal membership editor (BFSF-219) —
 * as one searchable sheet of the organisation's people: a switch per person,
 * on for a member. Switching adds through POST /auth/groups/:id/members and
 * removes through DELETE …/members/:userId, one person at a time.
 *
 * The group's members come first, in the order they had when the sheet
 * opened: a row that jumped away the moment you switched it would be lost.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { SettingRow, useToast } from '@/shared/ui';

import { ToggleListSheet, type ToggleItem } from './ToggleListSheet';
import { useSetGroupMember } from '../hooks/groupMutations';
import { displayName, sortMembers } from '../model/members';
import type { Member, OrgGroup } from '../model/types';

/** `ids` first, each half keeping its own order. */
function membersFirst(people: readonly Member[], ids: readonly string[]): Member[] {
    return [...people.filter((m) => ids.includes(m.id)), ...people.filter((m) => !ids.includes(m.id))];
}

export function GroupMembersRow({ group, people }: { group: OrgGroup; people: readonly Member[] }) {
    const t = useTranslation();
    const { toast } = useToast();
    const setMember = useSetGroupMember();
    const [open, setOpen] = useState(false);
    const [first, setFirst] = useState<readonly string[]>([]);
    const busyId = setMember.isPending ? setMember.variables?.userId : undefined;

    const inGroup = people.filter((m) => m.groups.includes(group.id));
    const openSheet = () => {
        setFirst(inGroup.map((m) => m.id));
        setOpen(true);
    };

    const items: ToggleItem[] = membersFirst(sortMembers(people), first).map((m) => {
        // A switch mid-save shows where it is going.
        const on = busyId === m.id ? Boolean(setMember.variables?.on) : m.groups.includes(group.id);
        return {
            id: m.id,
            label: displayName(m),
            description: m.email,
            on,
            disabled: setMember.isPending,
            toggle: (next: boolean) =>
                setMember.mutate(
                    { groupId: group.id, userId: m.id, on: next },
                    { onError: (e) => toast(describeError(e).message, 'error') },
                ),
        };
    });
    const count = inGroup.length;

    return (
        <>
            <SettingRow
                testID="group-members-row"
                label={t('admin.org_group_members', 'Members')}
                value={String(count)}
                onPress={openSheet}
            />
            <ToggleListSheet
                visible={open}
                onClose={() => setOpen(false)}
                title={t('mobile.orgPeople.members_count_title', 'Members ({count})', { count })}
                items={items}
                emptyTitle={t('admin.org_no_users', 'No users yet')}
                searchPlaceholder={t('admin.org_group_add_member_search', 'Search users to add…')}
                noMatchTitle={t('admin.org_no_matches', 'No users match the current filters.')}
            />
        </>
    );
}
