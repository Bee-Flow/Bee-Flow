import { FileContent } from '../ProjectDiscovery';
import { InstructionsCard } from '../OverviewCards';
// Knowledge tab of the project workspace: everything the AI in this
// project's chats can draw on. Three parts: files uploaded into the project,
// knowledge bases linked to it, and the project memory.

import React, { useMemo } from 'react';
import { useProjectFilesQuery } from '../../../../api/queries/projectContent';
import useTranslation from '../../../../hooks/useTranslation';
import { ContentColumn, ContentToolbar, ReadOnlyNote, SectionCard } from './contentUi';
import FilesSection from './FilesSection';
import KnowledgeBasesSection from './KnowledgeBasesSection';
import { MemoryPanel } from './typedShared';
import { canEditContent, type ContentTabProps } from './types';
import { useMemberNames } from './useContentActions';

function MemorySection({ projectId, canEdit, extractMemories }: { projectId: string; canEdit: boolean; extractMemories: boolean }) {
    const { t } = useTranslation();
    return (
        <SectionCard
            title={t('project_content.memory_title', 'Project memory')}
            description={t('project_content.memory_desc', 'What the assistant remembers for this project, shared by every member. Editors can add, change and remove entries.')}
            testId="project-memory-section"
        >
            <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
                <MemoryPanel projectId={projectId} canEdit={canEdit} embedded extractMemories={extractMemories} />
            </div>
        </SectionCard>
    );
}

export default function KnowledgeTab({ projectId, project, role, currentUser, intent, sub, onOpenSub, onOpenTab }: ContentTabProps) {
    const { t } = useTranslation();
    const canEdit = canEditContent(role);
    const nameOf = useMemberNames(projectId, currentUser?.id);
    // The files base can be created by the first upload after the project
    // was loaded, so the files listing's own answer counts too.
    const files = useProjectFilesQuery(projectId);
    const filesKbIds = useMemo(() => [project?.filesKbId, files.data?.kbId], [project?.filesKbId, files.data?.kbId]);
    return (
        <ContentColumn testId="project-knowledge-tab">
            <ContentToolbar title={t('project_content.knowledge_title', 'Knowledge')} />
            <p className="-mt-2 text-[12px] text-[var(--text-tertiary)]">
                {t('project_content.knowledge_desc', 'Everything the AI in this project\'s chats can draw on, for every member.')}
            </p>
            {!canEdit && <ReadOnlyNote>{t('project_content.knowledge_viewer_note', 'You can see what this project knows. Ask the owner for editor access to add files or knowledge bases.')}</ReadOnlyNote>}
            {sub && <FileContent projectId={projectId} fileId={sub} onClose={() => onOpenSub(null)} />}
            <InstructionsCard project={project} role={role} onOpenTab={onOpenTab || (() => {})} />
            <FilesSection onOpen={onOpenSub} projectId={projectId} canEdit={canEdit} uploaderName={nameOf} openPicker={intent === 'upload'} />
            <KnowledgeBasesSection
                projectId={projectId} canEdit={canEdit} organizationId={project?.organizationId}
                filesKbIds={filesKbIds} openPicker={intent === 'add'}
            />
            <MemorySection projectId={projectId} canEdit={canEdit} extractMemories={project.extractMemories !== false} />
        </ContentColumn>
    );
}
