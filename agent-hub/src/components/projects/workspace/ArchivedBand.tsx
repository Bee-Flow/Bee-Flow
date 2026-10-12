// The strip above an archived project's tabs: when and by whom it was closed,
// and for the owner the way back. Everybody else just learns it is read-only.

import { Archive } from 'lucide-react';
import React from 'react';
import { useProjectMembersQuery, useRestoreProject, type Project } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import toast from '../../shared/Toast';
import { projectErrorText } from './projectErrorText';
import { ErrorText, Notice, PrimaryButton } from './workspaceUi';

export default function ArchivedBand({ project, isOwner }: { project: Project; isOwner: boolean }) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(project.id);
    const restore = useRestoreProject(project.id);
    if (!project.archivedAt) return null;
    const date = new Date(project.archivedAt).toLocaleDateString();
    const by = project.archivedBy ? members.data?.people?.[project.archivedBy]?.name : undefined;
    const text = by
        ? t('project_home.archived.band', 'Archived on {date} by {name}', { date, name: by })
        : t('project_home.archived.band_no_name', 'Archived on {date}', { date });
    return (
        <Notice
            icon={Archive}
            testId="project-archived-band"
            action={isOwner ? (
                <PrimaryButton
                    busy={restore.isPending}
                    data-testid="project-restore"
                    onClick={() => restore.mutate(undefined, { onSuccess: () => toast.success(t('project_home.archive.restored', 'Project restored.')) })}
                >
                    {t('project_home.archive.restore', 'Restore')}
                </PrimaryButton>
            ) : undefined}
        >
            <span>
                {text}. {t('project_home.archived.read_only', 'This project is archived and read-only. Restore it to change anything.')}
            </span>
            <ErrorText>{restore.error ? projectErrorText(t, restore.error) : null}</ErrorText>
        </Notice>
    );
}
