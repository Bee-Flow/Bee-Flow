// The bottom of Settings: delete the project (owner) or leave it (members).

import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import React from 'react';
import {
    useDeleteProject, useProjectMembersQuery, useRemoveMember, type Project, type ProjectRole,
} from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import useConfirm from '../../shared/useConfirm';
import { projectErrorText } from './projectErrorText';
import { DangerZone } from './studioParts';
import { ErrorText, SecondaryButton } from './workspaceUi';

function DeleteProject({ project, currentUserId, onDeleted }: {
    project: Project;
    currentUserId: string | null | undefined;
    onDeleted?: (id: string) => void;
}) {
    const { t } = useTranslation();
    const del = useDeleteProject();
    return (
        <DangerZone
            entityName={project.name}
            usage={[]}
            requireName
            kindLabel={t('project_home.settings.kind_project', 'project')}
            currentUserId={currentUserId}
            openLabel={t('project_home.settings.delete_open', 'Delete this project')}
            notice={(
                <p className="text-xs text-[var(--text-secondary)] m-0">
                    {t('project_home.settings.delete_notice', 'Team chats are deleted with it. Documents, notebooks, meetings and private chats stay with the people who made them. Chats shared with the project must be made private first.')}
                </p>
            )}
            onDelete={async () => {
                // A refusal (for example chats still shared) throws; DangerZone
                // shows its message, said here in the reader's language.
                try {
                    await del.mutateAsync(project.id);
                } catch (e) {
                    throw new Error(projectErrorText(t, e, t('project_home.settings.delete_failed', 'Could not delete the project.')));
                }
                onDeleted?.(project.id);
            }}
        />
    );
}

function LeaveProject({ projectId, currentUserId, onLeft }: {
    projectId: string;
    currentUserId: string | null | undefined;
    onLeft?: () => void;
}) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const members = useProjectMembersQuery(projectId);
    const remove = useRemoveMember(projectId);
    const { confirm, confirmDialog } = useConfirm();
    const myShare = members.data?.members.find((m) => m.sharedWithType === 'user' && m.sharedWithId === currentUserId);

    const leave = async () => {
        if (!myShare) return;
        const ok = await confirm({
            title: t('project_home.members.leave_title', 'Leave this project?'),
            description: t('project_home.members.leave_body', 'You lose access to everything in it until the owner invites you again.'),
            confirmLabel: t('project_home.members.leave', 'Leave'),
            destructive: true,
        });
        if (!ok) return;
        remove.mutate(myShare.id, {
            onSuccess: () => {
                qc.invalidateQueries({ queryKey: ['projects', 'list'] });
                onLeft?.();
            },
        });
    };

    return (
        <section className="mt-8 pt-5 border-t border-[var(--border-subtle)] space-y-2" data-testid="settings-leave">
            {members.isSuccess && !myShare ? (
                <p className="text-xs text-[var(--text-tertiary)] m-0">
                    {t('project_home.settings.leave_via_group', 'You are in this project through a group. To leave, ask the owner to remove the group or ask an admin to take you out of it.')}
                </p>
            ) : (
                <SecondaryButton onClick={leave} disabled={!myShare} busy={remove.isPending} data-testid="settings-leave-button">
                    <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('project_home.settings.leave', 'Leave this project')}
                </SecondaryButton>
            )}
            <ErrorText>{remove.error ? projectErrorText(t, remove.error) : null}</ErrorText>
            {confirmDialog}
        </section>
    );
}

export default function SettingsDanger({ project, role, currentUserId, onDeleted, onLeft }: {
    project: Project;
    role: ProjectRole;
    currentUserId: string | null | undefined;
    onDeleted?: (id: string) => void;
    onLeft?: () => void;
}) {
    if (role === 'owner') return <DeleteProject project={project} currentUserId={currentUserId} onDeleted={onDeleted} />;
    return <LeaveProject projectId={project.id} currentUserId={currentUserId} onLeft={onLeft} />;
}
