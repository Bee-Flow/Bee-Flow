// The owner's cards at the bottom of Settings: who may invite, who owns the
// project, and archiving it (the reversible alternative to deleting).

import { Archive, ArchiveRestore, ArrowRightLeft } from 'lucide-react';
import React, { useState } from 'react';
import { useSetProjectMute } from '../../../api/queries/notificationPrefs';
import { useArchiveProject, useRestoreProject, type Project } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import Toggle from '../../shared/Toggle';
import toast from '../../shared/Toast';
import useConfirm from '../../shared/useConfirm';
import { projectErrorText } from './projectErrorText';
import TransferOwnerDialog from './TransferOwnerDialog';
import { Card, ErrorText, SecondaryButton } from './workspaceUi';

export function EditorsInviteToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)] m-0">{t('project_home.settings.editors_can_invite', 'Editors may invite people')}</p>
                <p className="text-xs text-[var(--text-tertiary)] m-0 mt-0.5">
                    {t('project_home.settings.editors_can_invite_help', 'Editors can add people and groups as viewer or editor. Changing roles and removing people stays with the owner.')}
                </p>
            </div>
            <Toggle checked={checked} onChange={onChange} disabled={disabled} ariaLabel={t('project_home.settings.editors_can_invite', 'Editors may invite people')} />
        </div>
    );
}

/** Mute or unmute this project's bell and e-mail, for me only. Any member may, archived or not. */
export function MuteCard({ project }: { project: Project }) {
    const { t } = useTranslation();
    const setMute = useSetProjectMute(project.id);
    const label = t('project_collab.mute.label', 'Mute this project for me');
    const onChange = (next: boolean) => setMute.mutate(next, {
        onSuccess: () => toast.success(next
            ? t('project_collab.mute.done_muted', 'Project muted. You get no bell or e-mail for it.')
            : t('project_collab.mute.done_unmuted', 'Project unmuted.')),
    });
    return (
        <Card title={t('project_collab.mute.title', 'Notifications')} testId="settings-mute">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] m-0">{label}</p>
                    <p className="text-xs text-[var(--text-tertiary)] m-0 mt-0.5">
                        {t('project_collab.mute.help', 'No bell and no e-mail for this project. Only you are affected, and you can unmute at any time.')}
                    </p>
                </div>
                <Toggle checked={project.muted === true} onChange={onChange} disabled={setMute.isPending} ariaLabel={label} />
            </div>
            <ErrorText testId="settings-mute-error">{setMute.error ? projectErrorText(t, setMute.error, t('project_collab.mute.failed', 'Could not change the mute setting.')) : null}</ErrorText>
        </Card>
    );
}

export function OwnershipCard({ project, currentUserId }: { project: Project; currentUserId: string | null | undefined }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <Card title={t('project_home.settings.ownership', 'Ownership')} testId="settings-ownership">
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <p className="text-xs text-[var(--text-tertiary)] m-0 min-w-0 flex-1">
                    {t('project_home.settings.ownership_help', 'Hand the project to another member. You choose what you stay as.')}
                </p>
                <SecondaryButton onClick={() => setOpen(true)} data-testid="settings-transfer-open">
                    <ArrowRightLeft className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('project_home.transfer.open', 'Transfer ownership…')}
                </SecondaryButton>
            </div>
            <TransferOwnerDialog open={open} onClose={() => setOpen(false)} projectId={project.id} ownerId={project.ownerId} currentUserId={currentUserId} />
        </Card>
    );
}

export function ArchiveCard({ project }: { project: Project }) {
    const { t } = useTranslation();
    const archive = useArchiveProject(project.id);
    const restore = useRestoreProject(project.id);
    const { confirm, confirmDialog } = useConfirm();
    const archived = !!project.archivedAt;
    const error = archive.error || restore.error;

    const onArchive = async () => {
        const ok = await confirm({
            title: t('project_home.archive.confirm_title', 'Archive this project?'),
            description: t('project_home.archive.confirm_body', 'Everybody keeps read access, but nothing can be added or changed until you restore it. It disappears from the sidebar.'),
            confirmLabel: t('project_home.archive.confirm', 'Archive'),
        });
        if (!ok) return;
        archive.mutate(undefined, { onSuccess: () => toast.success(t('project_home.archive.done', 'Project archived.')) });
    };
    const onRestore = () => restore.mutate(undefined, { onSuccess: () => toast.success(t('project_home.archive.restored', 'Project restored.')) });

    return (
        <Card title={t('project_home.settings.archive', 'Archive')} testId="settings-archive">
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <p className="text-xs text-[var(--text-tertiary)] m-0 min-w-0 flex-1">
                    {archived
                        ? t('project_home.archive.is_archived', 'This project is archived. Restore it to work in it again.')
                        : t('project_home.archive.help', 'Close the project without deleting it. You can restore it at any time.')}
                </p>
                {archived ? (
                    <SecondaryButton onClick={onRestore} busy={restore.isPending} data-testid="settings-restore">
                        <ArchiveRestore className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('project_home.archive.restore', 'Restore')}
                    </SecondaryButton>
                ) : (
                    <SecondaryButton onClick={onArchive} busy={archive.isPending} data-testid="settings-archive-open">
                        <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('project_home.archive.open', 'Archive this project')}
                    </SecondaryButton>
                )}
            </div>
            <ErrorText>{error ? projectErrorText(t, error) : null}</ErrorText>
            {confirmDialog}
        </Card>
    );
}
