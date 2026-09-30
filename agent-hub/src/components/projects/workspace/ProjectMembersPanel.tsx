// Who is in a project, and — for the owner — who gets in.
//
// Reused outside the workspace (Studio → Solutions "Manage access"), so it
// depends on nothing but the project id, the caller's role and their id. The
// live presence dots come from useProjectLive, which is inert outside a
// workspace page.

import { useQueryClient } from '@tanstack/react-query';
import { Crown, LogOut, Trash2, Users } from 'lucide-react';
import React, { useState } from 'react';
import {
    useChangeMemberRole, useProjectMembersQuery, useRemoveMember, useSetMemberColor,
    type ProjectMembers, type ProjectRole, type ProjectShare,
} from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import useConfirm from '../../shared/useConfirm';
import MemberInviteForm from './MemberInviteForm';
import { useProjectLive } from './ProjectLiveContext';
import MemberColorPicker from './MemberColorPicker';
import { personColor } from './memberColors';
import { Avatar, ErrorText, GhostButton, LoadingRow, SecondaryButton, SELECT_CLASS } from './workspaceUi';

export interface ProjectMembersPanelProps {
    projectId: string;
    role: ProjectRole;
    currentUserId: string | null | undefined;
    /** Bump to focus the invite form. */
    inviteFocusRequest?: number;
    /** Called after the caller left the project. */
    onLeft?: () => void;
}

type TFn = ReturnType<typeof useTranslation>['t'];

interface Subject { name: string }

/** The display name of a share row: a person from `people`, a group from `groups`. */
export function subjectOf(share: ProjectShare, data: ProjectMembers | undefined, t: TFn): Subject {
    if (share.sharedWithType === 'group') {
        const g = data?.groups?.[share.sharedWithId];
        return { name: g?.name || t('project_home.members.unknown_group', 'A group you cannot see') };
    }
    const p = data?.people?.[share.sharedWithId];
    if (!p) return { name: t('project_home.members.unknown_user', 'A person you cannot see') };
    return { name: p.name || t('project_home.members.unnamed', 'Unnamed person') };
}

function RoleChip({ label }: { label: string }) {
    return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border border-[var(--border-default)] text-[var(--text-secondary)]">
            {label}
        </span>
    );
}

function Identity({ subject, isGroup, you, online, color }: { subject: Subject; isGroup: boolean; you: boolean; online: boolean; color?: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {isGroup ? (
                <span className="w-8 h-8 grid place-items-center rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] flex-shrink-0">
                    <Users className="w-4 h-4" aria-hidden="true" />
                </span>
            ) : (
                <Avatar name={subject.name} online={online} onlineLabel={t('project_home.online', 'Online')} color={color} />
            )}
            <div className="min-w-0">
                <p className="text-[13px] font-medium text-[var(--text-primary)] truncate m-0">
                    {subject.name}
                    {you && <span className="text-[var(--text-tertiary)] font-normal"> {t('project_home.members.you', '(you)')}</span>}
                </p>
                <p className="text-[11.5px] text-[var(--text-tertiary)] truncate m-0">
                    {isGroup ? t('project_home.members.group', 'Group') : ' '}
                </p>
            </div>
        </div>
    );
}

function roleLabel(role: ProjectRole, t: TFn): string {
    if (role === 'owner') return t('project_home.role.owner', 'Owner');
    if (role === 'editor') return t('project_home.role.editor', 'Editor');
    return t('project_home.role.viewer', 'Viewer');
}

interface RowActions {
    onRole: (share: ProjectShare, role: 'editor' | 'viewer') => void;
    onRemove: (share: ProjectShare, name: string) => void;
    onLeave: (share: ProjectShare) => void;
    onColor: (userId: string, color: string | null) => void;
}

function MemberRow({ share, data, isOwner, currentUserId, online, busy, actions }: {
    share: ProjectShare;
    data: ProjectMembers | undefined;
    isOwner: boolean;
    currentUserId: string | null | undefined;
    online: string[];
    busy: boolean;
    actions: RowActions;
}) {
    const { t } = useTranslation();
    const subject = subjectOf(share, data, t);
    const isGroup = share.sharedWithType === 'group';
    const isMe = !isGroup && !!currentUserId && share.sharedWithId === currentUserId;
    const chosen = isGroup ? undefined : data?.people?.[share.sharedWithId]?.color;
    const color = personColor(chosen, subject.name);
    return (
        <li className="flex items-center gap-3 px-3.5 py-2.5 border-b border-[var(--border-subtle)] last:border-b-0" data-testid={`member-row-${share.id}`}>
            <Identity subject={subject} isGroup={isGroup} you={isMe} online={isMe || online.includes(share.sharedWithId)} color={isGroup ? undefined : color} />
            {!isGroup && (
                <MemberColorPicker name={subject.name} color={color} chosen={chosen} canChange={isOwner || isMe} busy={busy}
                    onChange={(next) => actions.onColor(share.sharedWithId, next)} />
            )}
            {isOwner ? (
                <>
                    <select
                        value={share.permission}
                        onChange={(e) => actions.onRole(share, e.target.value as 'editor' | 'viewer')}
                        disabled={busy}
                        aria-label={t('project_home.members.role_for', 'Role for {name}', { name: subject.name })}
                        className={SELECT_CLASS}
                    >
                        <option value="editor">{t('project_home.role.editor', 'Editor')}</option>
                        <option value="viewer">{t('project_home.role.viewer', 'Viewer')}</option>
                    </select>
                    <GhostButton
                        onClick={() => actions.onRemove(share, subject.name)}
                        disabled={busy}
                        aria-label={t('project_home.members.remove', 'Remove {name}', { name: subject.name })}
                        title={t('project_home.members.remove', 'Remove {name}', { name: subject.name })}
                    >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </GhostButton>
                </>
            ) : (
                <RoleChip label={roleLabel(share.permission, t)} />
            )}
            {isMe && !isOwner && (
                <SecondaryButton onClick={() => actions.onLeave(share)} disabled={busy} data-testid="member-leave">
                    <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('project_home.members.leave', 'Leave')}
                </SecondaryButton>
            )}
        </li>
    );
}

function OwnerRow({ data, currentUserId, online, canColor, onColor }: {
    data: ProjectMembers; currentUserId: string | null | undefined; online: string[];
    /** The reader may change the owner's colour (the owner themself). */
    canColor: boolean; onColor: (userId: string, color: string | null) => void;
}) {
    const { t } = useTranslation();
    const person = data.people?.[data.ownerId];
    const you = !!currentUserId && data.ownerId === currentUserId;
    const subject: Subject = {
        name: person?.name || t('project_home.members.owner_unknown', 'The owner'),
    };
    return (
        <li className="flex items-center gap-3 px-3.5 py-2.5 border-b border-[var(--border-subtle)] last:border-b-0" data-testid="member-row-owner">
            <Identity subject={subject} isGroup={false} you={you} online={you || online.includes(data.ownerId)} color={personColor(person?.color, subject.name)} />
            <MemberColorPicker name={subject.name} color={personColor(person?.color, subject.name)} chosen={person?.color} canChange={canColor}
                onChange={(next) => onColor(data.ownerId, next)} />
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--item-active-bg)] text-[var(--text-primary)]">
                <Crown className="w-3 h-3" aria-hidden="true" />
                {t('project_home.role.owner', 'Owner')}
            </span>
        </li>
    );
}

/** Role change, removal and leaving, with a confirm before anything is taken away. */
function useMemberActions(projectId: string, onLeft: (() => void) | undefined, setError: (e: string | null) => void) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const { confirm, confirmDialog } = useConfirm();
    const changeRole = useChangeMemberRole(projectId);
    const remove = useRemoveMember(projectId);
    const setColor = useSetMemberColor(projectId);
    const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

    const actions: RowActions = {
        onColor: (userId, color) => {
            setError(null);
            setColor.mutate({ userId, color }, { onError: fail });
        },
        onRole: (share, role) => {
            setError(null);
            changeRole.mutate({ memberId: share.id, role }, { onError: fail });
        },
        onRemove: async (share, name) => {
            const ok = await confirm({
                title: t('project_home.members.remove_title', 'Remove {name}?', { name }),
                description: t('project_home.members.remove_body', 'They lose access to the chats, documents and knowledge in this project. What they created stays.'),
                confirmLabel: t('project_home.members.remove_confirm', 'Remove'),
                destructive: true,
            });
            if (!ok) return;
            setError(null);
            remove.mutate(share.id, { onError: fail });
        },
        onLeave: async (share) => {
            const ok = await confirm({
                title: t('project_home.members.leave_title', 'Leave this project?'),
                description: t('project_home.members.leave_body', 'You lose access to everything in it until the owner invites you again.'),
                confirmLabel: t('project_home.members.leave', 'Leave'),
                destructive: true,
            });
            if (!ok) return;
            setError(null);
            remove.mutate(share.id, {
                onError: fail,
                onSuccess: () => {
                    // The project is no longer in the caller's list.
                    qc.invalidateQueries({ queryKey: ['projects', 'list'] });
                    onLeft?.();
                },
            });
        },
    };
    return { actions, confirmDialog, busy: changeRole.isPending || remove.isPending };
}

export default function ProjectMembersPanel({ projectId, role, currentUserId, inviteFocusRequest = 0, onLeft }: ProjectMembersPanelProps) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(projectId);
    const { online } = useProjectLive();
    const [error, setError] = useState<string | null>(null);
    const { actions, confirmDialog, busy } = useMemberActions(projectId, onLeft, setError);
    const isOwner = role === 'owner';

    if (members.isPending) return <LoadingRow label={t('project_home.members.loading', 'Loading members…')} />;
    if (members.isError) {
        return (
            <div className="space-y-2" data-testid="members-error">
                <ErrorText>{t('project_home.members.load_failed', 'Could not load the members of this project.')}</ErrorText>
                <SecondaryButton onClick={() => members.refetch()}>{t('project_home.retry', 'Try again')}</SecondaryButton>
            </div>
        );
    }
    const data = members.data;
    return (
        <div className="space-y-4" data-testid="project-members-panel">
            {isOwner && <MemberInviteForm projectId={projectId} members={data} focusRequest={inviteFocusRequest} />}
            <ErrorText testId="members-action-error">{error}</ErrorText>
            <ul className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden m-0 p-0 list-none" aria-label={t('project_home.members.list', 'Members')}>
                <OwnerRow data={data} currentUserId={currentUserId} online={online} canColor={isOwner} onColor={actions.onColor} />
                {data.members.map((share) => (
                    <MemberRow
                        key={share.id}
                        share={share}
                        data={data}
                        isOwner={isOwner}
                        currentUserId={currentUserId}
                        online={online}
                        busy={busy}
                        actions={actions}
                    />
                ))}
            </ul>
            {data.members.length === 0 && (
                <p className="text-[12.5px] text-[var(--text-tertiary)] m-0" data-testid="members-empty">
                    {isOwner
                        ? t('project_home.members.empty_owner', 'Nobody else is in this project yet. Invite people to work on it together.')
                        : t('project_home.members.empty', 'Nobody else is in this project yet.')}
                </p>
            )}
            {confirmDialog}
        </div>
    );
}
