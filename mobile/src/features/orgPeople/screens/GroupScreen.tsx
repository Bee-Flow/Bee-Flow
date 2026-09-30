/**
 * One group — the web's expanded group card: description, the role its
 * members inherit, the model tiers they may use, its members, and delete.
 * A group synced from Nextcloud or Azure says so; its membership is the
 * sync's to change, but the web lets an admin edit it anyway, and so does
 * this (the next sync may overwrite it).
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';
import { QueryScreen, useConfirm } from '@/shared/patterns';
import { Group, ScreenHeader, SettingRow, useToast } from '@/shared/ui';

import { GroupMembersRow } from '../components/GroupMembersRow';
import { GroupSettings } from '../components/GroupSettings';
import { GroupTiers } from '../components/GroupTiers';
import { LockedScreen } from '../components/LockedScreen';
import { useDeleteGroup } from '../hooks/groupMutations';
import { useCustomTiersList, useGroups, useMembers, useOrgRoles } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { orgMembers } from '../model/members';
import { orderedRoleIds } from '../model/roles';
import type { OrgGroup } from '../model/types';

/** The server refuses to delete these two. */
const SYSTEM_GROUPS = ['admins', 'users'];

function DeleteGroupRow({ group }: { group: OrgGroup }) {
    const t = useTranslation();
    const router = useRouter();
    const confirm = useConfirm();
    const { toast } = useToast();
    const remove = useDeleteGroup();
    const onDelete = async () => {
        const ok = await confirm({
            title: t('mobile.orgPeople.delete_named_title', 'Delete {name}?', { name: group.name || group.id }),
            message: t('admin.sec_delete_group_desc', 'Members keep their accounts but lose whatever this group granted them.'),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (!ok) return;
        remove.mutate(group.id, {
            onSuccess: () => router.back(),
            onError: (e) => toast(describeError(e).message, 'error'),
        });
    };
    return (
        <Group>
            <SettingRow
                testID="group-delete"
                destructive
                label={t('mobile.orgPeople.delete_group', 'Delete group')}
                disabled={remove.isPending}
                onPress={() => void onDelete()}
            />
        </Group>
    );
}

export function GroupScreen({ id }: { id: string }) {
    const t = useTranslation();
    const { isOrgAdmin } = usePeopleAccess();
    const groups = useGroups(isOrgAdmin);
    const members = useMembers(isOrgAdmin);
    const roles = useOrgRoles(isOrgAdmin);
    const custom = useCustomTiersList(isOrgAdmin);

    if (!isOrgAdmin) return <LockedScreen title={t('mobile.orgPeople.group', 'Group')} />;

    const group = groups.data?.find((g) => g.id === id);
    const query = { ...groups, data: groups.data ? group : undefined };
    const people = orgMembers(members.data ?? []);
    const refresh = () => Promise.all([groups.refetch(), members.refetch()]);
    const synced = (g: OrgGroup | undefined) =>
        g?.source && g.source !== 'manual'
            ? t('mobile.orgPeople.synced_from', 'Synced from {source}', { source: humanise(g.source) })
            : undefined;

    return (
        <QueryScreen
            query={query}
            refresh={refresh}
            header={(g) => <ScreenHeader title={g?.name || t('mobile.orgPeople.group', 'Group')} subtitle={synced(g)} />}
        >
            {(g) => (
                <>
                    <Group>
                        <GroupMembersRow group={g} people={people} />
                    </Group>
                    <GroupSettings
                        group={g}
                        roleIds={orderedRoleIds(roles.data?.roles ?? [])}
                        memberCount={people.filter((m) => m.groups.includes(g.id)).length}
                    />
                    <GroupTiers group={g} custom={custom.data ?? []} />
                    {SYSTEM_GROUPS.includes(g.id) ? null : <DeleteGroupRow group={g} />}
                </>
            )}
        </QueryScreen>
    );
}
