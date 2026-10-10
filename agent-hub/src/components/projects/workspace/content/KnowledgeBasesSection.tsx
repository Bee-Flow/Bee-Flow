// Knowledge bases linked to the project: chats in the project search them for
// every member. Linking needs read access to the base (the server checks);
// unlinking only takes it off the project's list and never touches the base.

import { AlertTriangle, BookOpen, Link2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useProjectSection, type ProjectKnowledgeBase } from '../../../../api/queries/projectContent';
import useTranslation from '../../../../hooks/useTranslation';
import { Card, GhostButton, Notice, RemoveButton, SecondaryButton } from '../workspaceUi';
import { KnowledgeBasePicker } from './pickers';
import { useRemoveFromProject } from './useContentActions';

function KbList({ status, bases, emptyText, onRetry, canEdit, removingId, onUnlink }: {
    status: 'loading' | 'error' | 'ok'; bases: ProjectKnowledgeBase[]; emptyText: string; onRetry: () => void;
    canEdit: boolean; removingId: string | null; onUnlink: (kb: ProjectKnowledgeBase) => void;
}) {
    const { t } = useTranslation();
    if (status === 'loading') return <p role="status" className="px-2 py-3 text-sm text-[var(--text-tertiary)]">{t('project_content.kbs_loading', 'Loading knowledge bases…')}</p>;
    if (status === 'error') return <Notice tone="error" role="alert" icon={AlertTriangle} action={onRetry && <GhostButton onClick={onRetry}>{t('project_content.retry', 'Try again')}</GhostButton>}>{t('project_content.kbs_error', 'The knowledge bases of this project could not be loaded.')}</Notice>;
    if (!bases.length) return <p className="px-2 py-4 text-center text-sm text-[var(--text-tertiary)]">{emptyText}</p>;
    return (
        <ul data-testid="project-kbs-list">
            {bases.map(kb => (
                <li key={kb.id} className="flex items-center gap-2.5 px-2 py-2 border-b border-[var(--border-subtle)] last:border-b-0" data-testid={`project-kb-${kb.id}`}>
                    <BookOpen className="w-4 h-4 shrink-0 text-[var(--kind-kb)]" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{kb.name}</div>
                        {kb.description && <div className="text-[11px] text-[var(--text-tertiary)] truncate">{kb.description}</div>}
                    </div>
                    {canEdit && (
                        <RemoveButton
                            label={t('project_content.kb_unlink_named', 'Unlink {name}', { name: kb.name })}
                            disabled={removingId === kb.id}
                            onClick={() => onUnlink(kb)}
                        />
                    )}
                </li>
            ))}
        </ul>
    );
}

export default function KnowledgeBasesSection({ projectId, canEdit, organizationId, filesKbIds, openPicker = false }: {
    projectId: string; canEdit: boolean; organizationId: string | null | undefined;
    /** The project's own files base: listed as its files, never as a linked base. */
    filesKbIds: ReadonlyArray<string | null | undefined>;
    openPicker?: boolean;
}) {
    const { t } = useTranslation();
    const [pickerOpen, setPickerOpen] = useState(() => canEdit && openPicker);
    const section = useProjectSection<ProjectKnowledgeBase>(projectId, 'knowledgeBases');
    const removal = useRemoveFromProject(projectId, 'knowledge_base');
    const hidden = useMemo(() => new Set(filesKbIds.filter(Boolean) as string[]), [filesKbIds]);
    const bases = removal.without(section.items).filter(kb => !hidden.has(kb.id));
    const linked = useMemo(() => new Set(section.items.map(kb => kb.id)), [section.items]);

    const onUnlink = (kb: ProjectKnowledgeBase) => removal.remove(kb.id, {
        message: t('project_home.kb_unlinked', '"{name}" unlinked from the project', { name: kb.name }),
    });

    return (
        <Card as="h3"
            title={t('project_content.kbs_title', 'Knowledge bases')}
            description={t('project_content.kbs_desc', 'Linked knowledge bases are searched by every chat in this project.')}
            action={canEdit ? <SecondaryButton icon={Link2} onClick={() => setPickerOpen(true)} testId="project-kb-link">{t('project_content.kb_link', 'Link knowledge base')}</SecondaryButton> : null}
            testId="project-kbs-section"
        >
            <KbList
                status={section.status} bases={bases} onRetry={section.refetch} canEdit={canEdit}
                removingId={removal.pendingId} onUnlink={onUnlink}
                emptyText={t('project_content.kbs_empty', 'No knowledge bases linked yet.')}
            />
            {pickerOpen && (
                <KnowledgeBasePicker projectId={projectId} open onClose={() => setPickerOpen(false)} inProject={linked} organizationId={organizationId} />
            )}
        </Card>
    );
}
