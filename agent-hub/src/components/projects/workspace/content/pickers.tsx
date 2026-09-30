// The four "add existing" pickers: the caller's own documents, notebooks and
// meetings, and the knowledge bases they may read. Each one only feeds
// ItemPickerDialog; filing goes through PUT /api/projects/:id/resources, whose
// refusal (not yours, not readable, other organisation) lands on the row.

import React, { useCallback, useMemo } from 'react';
import {
    useMyDocumentsQuery, useMyMeetingsQuery, useMyNotebooksQuery, useReadableKnowledgeBasesQuery,
} from '../../../../api/queries/projectContent';
import { useAttachResource } from '../../../../api/queries/projects';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import ItemPickerDialog, { type PickerItem } from './ItemPickerDialog';
import { docTypeLabel, formatMeetingDuration } from './labels';

export interface PickerProps {
    projectId: string;
    open: boolean;
    onClose: () => void;
    /** Ids already filed in this project. */
    inProject: ReadonlySet<string>;
}

/** "Moves it here" for an item another project holds: filing is one project at a time. */
function useElsewhere(projectId: string) {
    const { t } = useTranslation();
    return useCallback((otherProjectId: string | null | undefined) => (otherProjectId && otherProjectId !== projectId
        ? t('project_content.picker_in_other_project', 'In another project, adding moves it here')
        : ''), [projectId, t]);
}

const joinMeta = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' · ');

function usePick(projectId: string, kind: string) {
    const attach = useAttachResource(projectId);
    return (id: string) => attach.mutateAsync({ kind, id, attach: true });
}

export function DocumentPicker({ projectId, open, onClose, inProject, currentUserId }: PickerProps & { currentUserId: string | null | undefined }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const elsewhere = useElsewhere(projectId);
    const mine = useMyDocumentsQuery(open);
    const onPick = usePick(projectId, 'document');
    const items = useMemo<PickerItem[]>(() => (mine.data || [])
        .filter(d => !d.userId || !currentUserId || d.userId === currentUserId)
        .map(d => ({ id: d.id, label: d.name, meta: joinMeta(docTypeLabel(t, d.docType), rel(d.updatedAt), elsewhere(d.projectId)) })),
    [mine.data, currentUserId, t, rel, elsewhere]);
    return (
        <ItemPickerDialog
            open={open} onClose={onClose} items={items} alreadyIn={inProject} onPick={onPick}
            title={t('project_content.documents_picker_title', 'Add a document')}
            description={t('project_content.documents_picker_desc', 'Pick from your own documents. Once added, every member of this project can read it and editors can change it.')}
            loading={mine.isPending} error={mine.isError ? t('project_content.documents_picker_error', 'Your documents could not be loaded.') : null}
            onRetry={() => { mine.refetch(); }}
            emptyText={t('project_content.documents_picker_empty', 'You have no documents yet.')}
        />
    );
}

export function NotebookPicker({ projectId, open, onClose, inProject }: PickerProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const elsewhere = useElsewhere(projectId);
    const mine = useMyNotebooksQuery(open);
    const onPick = usePick(projectId, 'notebook');
    const items = useMemo<PickerItem[]>(() => (mine.data || [])
        .map(n => ({ id: n.id, label: n.name, meta: joinMeta(rel(n.lastActivityAt || n.updatedAt), elsewhere(n.projectId)) })),
    [mine.data, rel, elsewhere]);
    return (
        <ItemPickerDialog
            open={open} onClose={onClose} items={items} alreadyIn={inProject} onPick={onPick}
            title={t('project_content.notebooks_picker_title', 'Add a notebook')}
            description={t('project_content.notebooks_picker_desc', 'Pick from your own notebooks. Members can read them and editors can write in them.')}
            loading={mine.isPending} error={mine.isError ? t('project_content.notebooks_picker_error', 'Your notebooks could not be loaded.') : null}
            onRetry={() => { mine.refetch(); }}
            emptyText={t('project_content.notebooks_picker_empty', 'You have no notebooks yet.')}
        />
    );
}

export function MeetingPicker({ projectId, open, onClose, inProject }: PickerProps) {
    const { t, locale } = useTranslation();
    const elsewhere = useElsewhere(projectId);
    const mine = useMyMeetingsQuery(open);
    const onPick = usePick(projectId, 'meeting');
    const items = useMemo<PickerItem[]>(() => (mine.data || []).map(m => ({
        id: m.id,
        label: m.title || t('project_content.meeting_untitled', 'Untitled meeting'),
        meta: joinMeta(m.createdAt ? new Date(m.createdAt).toLocaleDateString(locale) : '', formatMeetingDuration(m.durationSeconds), elsewhere(m.projectId)),
    })), [mine.data, t, locale, elsewhere]);
    return (
        <ItemPickerDialog
            open={open} onClose={onClose} items={items} alreadyIn={inProject} onPick={onPick}
            title={t('project_content.meetings_picker_title', 'Add a meeting')}
            description={t('project_content.meetings_picker_desc', 'Pick from the meetings you recorded. Members can read the notes; only you can change them.')}
            loading={mine.isPending} error={mine.isError ? t('project_content.meetings_picker_error', 'Your meetings could not be loaded.') : null}
            onRetry={() => { mine.refetch(); }}
            emptyText={t('project_content.meetings_picker_empty', 'You have no recorded meetings yet.')}
        />
    );
}

/**
 * Knowledge bases the caller may read, in the project's organisation. The
 * server applies the same two rules; filtering here only spares the user an
 * Add button that is certain to be refused. A project's own files base is
 * left out: it is shown as the project's files.
 */
export function KnowledgeBasePicker({ projectId, open, onClose, inProject, organizationId }: PickerProps & { organizationId: string | null | undefined }) {
    const { t } = useTranslation();
    const readable = useReadableKnowledgeBasesQuery(open);
    const onPick = usePick(projectId, 'knowledge_base');
    const items = useMemo<PickerItem[]>(() => (readable.data || [])
        .filter(kb => kb.source_kind !== 'project_files' && (kb.organization_id || '') === (organizationId || ''))
        .map(kb => ({ id: kb.id, label: kb.name, meta: kb.description || '' })),
    [readable.data, organizationId]);
    return (
        <ItemPickerDialog
            open={open} onClose={onClose} items={items} alreadyIn={inProject} onPick={onPick}
            title={t('project_content.kb_picker_title', 'Link a knowledge base')}
            description={t('project_content.kb_picker_desc', 'Chats in this project will search the knowledge bases you link, for every member.')}
            loading={readable.isPending} error={readable.isError ? t('project_content.kb_picker_error', 'Your knowledge bases could not be loaded.') : null}
            onRetry={() => { readable.refetch(); }}
            emptyText={t('project_content.kb_picker_empty', 'There are no knowledge bases you can link.')}
        />
    );
}
