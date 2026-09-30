// The documents filed in a project, as a table: name (with a dot when
// somebody else changed it since the reader last looked), type, owner, and
// when and by whom it was last changed.

import { FileText, NotebookPen, Presentation } from 'lucide-react';
import React from 'react';
import type { ProjectDocument } from '../../../../api/queries/projectContent';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import { useDocTypeLabel } from '../../../../pages/documents/library/labels';
import { RemoveButton } from './contentUi';
import { DataTable, TableCell, TableRow, type TableColumn } from './typedShared';

/** The project's document card, with the last editor the server now adds. */
export type ProjectDocumentRow = ProjectDocument & { updatedBy?: string | null };

export interface DocumentsTableProps {
    documents: ProjectDocumentRow[];
    loading: boolean;
    empty: React.ReactNode;
    ownerName: (userId: string | null | undefined) => string;
    mayRemove: (doc: ProjectDocumentRow) => boolean;
    removingId: string | null;
    onOpen: (doc: ProjectDocumentRow) => void;
    onRemove: (doc: ProjectDocumentRow) => void;
    /** Somebody else changed it since the reader last saw it. */
    isUnread?: (doc: ProjectDocumentRow) => boolean;
}

function useColumns(): TableColumn[] {
    const { t } = useTranslation();
    return [
        { id: 'name', label: t('project_content.col_name', 'Name'), width: '1fr' },
        { id: 'type', label: t('project_content.col_type', 'Type'), width: '130px' },
        { id: 'owner', label: t('project_content.col_owner', 'Owner'), width: '160px', foldBelow: 1180 },
        { id: 'updated', label: t('documents.project.col_changed', 'Last changed'), width: '170px' },
        { id: 'actions', label: '', width: '32px' },
    ];
}

const iconOf = (docType: string | undefined) => (docType === 'presentation' ? Presentation : docType === 'page' ? NotebookPen : FileText);

export default function DocumentsTable({ documents, loading, empty, ownerName, mayRemove, removingId, onOpen, onRemove, isUnread }: DocumentsTableProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const typeLabel = useDocTypeLabel();
    const columns = useColumns();
    const [nameCol, typeCol, ownerCol, updatedCol, actionsCol] = columns;
    return (
        <DataTable
            columns={columns}
            rows={documents}
            loading={loading}
            skeletonRows={4}
            empty={empty}
            ariaLabel={t('project_content.documents_title', 'Documents')}
            testId="project-documents"
            renderRow={(doc: ProjectDocumentRow) => {
                const Icon = iconOf(doc.docType);
                const unread = !!isUnread?.(doc);
                const editor = doc.updatedBy ? ownerName(doc.updatedBy) : '';
                const when = rel(doc.updatedAt || doc.createdAt);
                return (
                    <TableRow columns={columns} onClick={() => onOpen(doc)} testId={`project-document-${doc.id}`}>
                        <TableCell column={nameCol} className="flex items-center gap-2">
                            <Icon className="w-4 h-4 shrink-0 text-[var(--kind-doc)]" aria-hidden="true" />
                            <span className={`truncate text-[13px] text-[var(--text-primary)] ${unread ? 'font-semibold' : 'font-medium'}`}>{doc.name}</span>
                            {unread && (
                                <span className="w-2 h-2 rounded-full shrink-0 bg-[var(--accent-primary)]" data-testid={`project-document-unread-${doc.id}`}>
                                    <span className="sr-only">{t('documents.project.unread', 'Changed since you last looked')}</span>
                                </span>
                            )}
                        </TableCell>
                        <TableCell column={typeCol} className="text-[var(--text-secondary)]">{typeLabel(doc.docType)}</TableCell>
                        <TableCell column={ownerCol} className="truncate text-[var(--text-secondary)]">{ownerName(doc.userId)}</TableCell>
                        <TableCell column={updatedCol} className="truncate text-[var(--text-tertiary)]">
                            {editor ? t('documents.project.changed_by', '{time} · {name}', { time: when, name: editor }) : when}
                        </TableCell>
                        <TableCell column={actionsCol} align="right">
                            {mayRemove(doc) && (
                                <RemoveButton
                                    label={t('project_content.remove_named', 'Remove {name} from the project', { name: doc.name })}
                                    disabled={removingId === doc.id}
                                    onClick={() => onRemove(doc)}
                                />
                            )}
                        </TableCell>
                    </TableRow>
                );
            }}
        />
    );
}
