// Members: who works in this project, what each role may do, and (for the
// owner) the invite form. The list itself is ProjectMembersPanel, which Studio
// reuses for a Solution's access.

import { UserPlus, Users } from 'lucide-react';
import React, { useState } from 'react';
import { useProjectMembersQuery, type ProjectMembers } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import ProjectMembersPanel from './ProjectMembersPanel';
import TransferOwnerDialog from './TransferOwnerDialog';
import { StudioSectionHeader } from './studioParts';
import type { WorkspaceTabProps } from './types';
import { PrimaryButton, SecondaryButton } from './workspaceUi';

function RolesExplainer() {
    const { t } = useTranslation();
    const rows = [
        { role: t('project_home.role.owner', 'Owner'), what: t('project_home.members.owner_can_v2', 'Everything an editor can, plus managing members and deleting the project.') },
        { role: t('project_home.role.editor', 'Editor'), what: t('project_home.members.editor_can_v2', 'Starts chats, manages tasks and content, and changes project and AI settings.') },
        { role: t('project_home.role.viewer', 'Viewer'), what: t('project_home.members.viewer_can', 'Reads everything in the project, changes nothing.') },
    ];
    return (
        <dl className="grid gap-x-4 gap-y-1.5 grid-cols-[max-content_1fr] text-[12.5px] m-0" data-testid="members-roles">
            {rows.map((r) => (
                <React.Fragment key={r.role}>
                    <dt className="font-medium text-[var(--text-primary)]">{r.role}</dt>
                    <dd className="m-0 text-[var(--text-tertiary)]">{r.what}</dd>
                </React.Fragment>
            ))}
        </dl>
    );
}

type TFn = ReturnType<typeof useTranslation>['t'];

/** "3 people · 1 groups", or null while the members load. */
function accessCountLabel(data: ProjectMembers | undefined, t: TFn): string | null {
    if (!data) return null;
    const peopleCount = new Set([data.ownerId, ...data.members.filter(m => m.sharedWithType === 'user').map(m => m.sharedWithId)]).size;
    const groupsCount = data.members.filter(m => m.sharedWithType === 'group').length;
    return String(t('project_home.members.access_count', '{people} people · {groups} groups', { people: peopleCount, groups: groupsCount }));
}

/** An organisation admin who is not the owner can name a new owner. */
function AdminTransfer({ projectId, ownerId, currentUserId }: { projectId: string; ownerId: string | undefined; currentUserId: string | null | undefined }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <div className="flex items-center justify-between gap-3 flex-wrap" data-testid="members-admin-transfer">
            <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">
                {t('project_home.members.admin_transfer', 'As an organisation admin you can name a new owner for this project.')}
            </p>
            <SecondaryButton onClick={() => setOpen(true)} data-testid="members-admin-transfer-open">
                {t('project_home.transfer.open', 'Transfer ownership…')}
            </SecondaryButton>
            <TransferOwnerDialog open={open} onClose={() => setOpen(false)} projectId={projectId} ownerId={ownerId} currentUserId={currentUserId} />
        </div>
    );
}

export default function MembersTab({ projectId, project, role, currentUser, intent, readOnly, onLeft }: WorkspaceTabProps & {
    /** The caller left the project from this tab. */
    onLeft?: () => void;
}) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(projectId);
    // A quick action ("Invite people") arrives as an intent: focus the form once.
    const [focusRequest, setFocusRequest] = useState(intent === 'invite' ? 1 : 0);
    const isOwner = role === 'owner';
    // Editors invite while the project allows it; nobody invites into an archived project.
    const canInvite = !readOnly && (isOwner || (role === 'editor' && project.editorsCanInvite === true));
    const adminRescue = !isOwner && !!currentUser?.isOrgAdmin;
    const count = accessCountLabel(members.data, t);

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="project-members-tab">
            <StudioSectionHeader
                icon={Users}
                title={t('project_home.tab.members', 'Members')}
                statusChip={count}
                primary={canInvite ? (
                    <PrimaryButton onClick={() => setFocusRequest((n) => n + 1)} data-testid="members-invite-open">
                        <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('project_home.members.invite_people', 'Invite people')}
                    </PrimaryButton>
                ) : undefined}
            />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
                    <ProjectMembersPanel
                        projectId={projectId}
                        role={role}
                        currentUserId={currentUser?.id}
                        inviteFocusRequest={focusRequest}
                        canInvite={canInvite}
                        readOnly={readOnly}
                        onLeft={onLeft}
                    />
                    {adminRescue && <AdminTransfer projectId={projectId} ownerId={project.ownerId ?? members.data?.ownerId} currentUserId={currentUser?.id} />}
                    <section className="space-y-2">
                        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)] m-0">
                            {t('project_home.members.roles_title', 'What each role can do')}
                        </h2>
                        <RolesExplainer />
                        <p className="text-xs text-[var(--text-secondary)]">{t('project_home.members.group_rights', 'Group membership also grants access. When several grants apply, the highest role applies; removing a direct grant does not remove group access.')}</p>
                    </section>
                </div>
            </div>
        </div>
    );
}
