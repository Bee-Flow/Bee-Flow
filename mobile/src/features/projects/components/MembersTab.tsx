/**
 * Members — who can reach this project, and what they may do (the web's
 * Members tab). The owner adds people and groups, changes a member's role
 * and removes them; anyone on the project as a person can leave it.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useCurrentUser } from '@/core/auth/AuthProvider';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { cardRows, useConfirm, type Block } from '@/shared/patterns';
import { ActionMenu, Button, LoadingState, useToast } from '@/shared/ui';

import { AddMemberSheet } from './AddMemberSheet';
import { MemberRow, OwnerRow } from './MemberRows';
import { Strip } from './Strip';
import { block, TabBlocks } from './TabBlocks';
import { useChangeMemberRole, useRemoveMember } from '../hooks/mutations';
import { useDirectory, useProjectMembers } from '../hooks/queries';
import type { SolutionState } from '../hooks/useSolution';
import { memberTitle, nameResolver, type NameFor } from '../model/people';
import type { ProjectShare } from '../model/types';

type Person = { kind: 'owner'; id: string } | { kind: 'member'; id: string; share: ProjectShare };

/** The owner's actions on one member: a role, or out. */
function MemberMenu({ projectId, share, title, onClose }: { projectId: string; share: ProjectShare | null; title: string; onClose: () => void }) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const role = useChangeMemberRole(projectId);
    const remove = useRemoveMember(projectId);
    const onError = (err: Error) => toast(describeError(err).message, 'error');
    const setRole = (next: 'viewer' | 'editor') => share && role.mutate({ memberId: share.id, role: next }, { onError });
    const drop = async () => {
        if (!share) return;
        const ok = await confirm({
            title: t('solutions.install_access_remove', 'Remove'),
            message: t('mobile.projects.remove_member_message', '{name} loses access to this project.', { name: title }),
            confirmLabel: t('common.remove', 'Remove'),
        });
        if (ok) remove.mutate(share.id, { onError });
    };
    return (
        <ActionMenu
            visible={share !== null}
            onClose={onClose}
            title={title}
            items={[
                { id: 'viewer', label: t('solutions.install_role_viewer', 'Can view'), icon: 'Eye', selected: share?.permission === 'viewer', onPress: () => setRole('viewer') },
                { id: 'editor', label: t('solutions.install_role_editor', 'Can edit'), icon: 'Pencil', selected: share?.permission === 'editor', onPress: () => setRole('editor') },
                { id: 'remove', label: t('solutions.install_access_remove', 'Remove'), icon: 'Trash2', destructive: true, onPress: () => void drop() },
            ]}
        />
    );
}

function peopleBlocks(owner: string, members: ProjectShare[], page: { meId?: string; nameFor: NameFor; onPress?: (s: ProjectShare) => void }): Block[] {
    const people: Person[] = [{ kind: 'owner', id: 'owner' }, ...members.map((share): Person => ({ kind: 'member', id: share.id, share }))];
    return cardRows({
        key: 'people',
        rows: people,
        rowKey: (p) => p.id,
        gap: 'none',
        render: (p) =>
            p.kind === 'owner' ? (
                <OwnerRow ownerId={owner} meId={page.meId} nameFor={page.nameFor} />
            ) : (
                <MemberRow share={p.share} meId={page.meId} nameFor={page.nameFor} onPress={page.onPress} />
            ),
    });
}

/** Around the people: the owner's invite button, a failed read, and why names are missing. */
function frameBlocks(t: TranslateFn, flags: { isOwner: boolean; failed: boolean; namesHidden: boolean }, onAdd: () => void) {
    const top: Block[] = [];
    if (flags.isOwner) {
        top.push(block('add', () => <Button label={t('mobile.projects.add_member', 'Add people')} iconName="Plus" variant="secondary" size="sm" onPress={onAdd} testID="members-add" />, 'none'));
    }
    if (flags.failed) {
        top.push(block('error', () => <Strip tone="warning">{t('projects.section_unavailable', 'Could not load this section. Your items are safe — try again shortly.')}</Strip>));
    }
    const bottom: Block[] = flags.namesHidden
        ? [block('names', () => <Strip tone="quiet">{t('mobile.projects.names_hidden', 'Names are only shown to administrators — everyone else sees roles.')}</Strip>, 'inner')]
        : [];
    return { top, bottom };
}

export function MembersTab({ id, sol }: { id: string; sol: SolutionState }) {
    const t = useTranslation();
    const me = useCurrentUser();
    const members = useProjectMembers(id);
    const directory = useDirectory();
    const nameFor = nameResolver(directory.data);
    // A new key per opening starts the invite afresh.
    const [invite, setInvite] = useState({ open: false, key: 0 });
    const [acting, setActing] = useState<ProjectShare | null>(null);
    if (members.isLoading) return <LoadingState />;

    const list = members.data?.members ?? [];
    const owner = members.data?.ownerId ?? sol.project.data?.ownerId ?? '';
    const frame = frameBlocks(
        t,
        { isOwner: sol.isOwner, failed: members.isError, namesHidden: directory.data?.users.length === 0 },
        () => setInvite((s) => ({ open: true, key: s.key + 1 })),
    );
    const blocks: Block[] = [
        ...frame.top,
        ...peopleBlocks(owner, list, { meId: me?.id, nameFor, onPress: sol.isOwner ? setActing : undefined }),
        ...frame.bottom,
    ];
    return (
        <>
            <TabBlocks blocks={blocks} onRefresh={() => members.refetch()} />
            <AddMemberSheet
                key={invite.key}
                projectId={id}
                visible={invite.open}
                taken={new Set([owner, ...list.map((m) => m.sharedWithId)])}
                onClose={() => setInvite((s) => ({ ...s, open: false }))}
            />
            <MemberMenu projectId={id} share={acting} title={acting ? memberTitle(acting, me?.id, nameFor, t) : ''} onClose={() => setActing(null)} />
        </>
    );
}
