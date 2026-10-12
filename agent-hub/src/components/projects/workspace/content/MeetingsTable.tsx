import { useViewport } from '../../../../hooks/useViewport';
// The meetings filed in a project, as a table: title, date, length, action
// items, owner. No transcript text travels in this list.

import { Mic } from 'lucide-react';
import React from 'react';
import type { ProjectMeeting } from '../../../../api/queries/projectContent';
import useTranslation from '../../../../hooks/useTranslation';
import { RemoveButton } from '../workspaceUi';
import { formatMeetingDuration, meetingStatusLabel } from './labels';
import { DataTable, TableCell, TableRow, type TableColumn } from './typedShared';

export interface MeetingsTableProps {
    meetings: ProjectMeeting[];
    loading: boolean;
    empty: React.ReactNode;
    ownerName: (userId: string | null | undefined) => string;
    mayRemove: (meeting: ProjectMeeting) => boolean;
    removingId: string | null;
    onOpen: (meeting: ProjectMeeting) => void;
    onRemove: (meeting: ProjectMeeting) => void;
}

function useColumns(): TableColumn[] {
    const { t } = useTranslation();
    return [
        { id: 'title', label: t('project_content.col_title', 'Title'), width: '1fr' },
        { id: 'date', label: t('project_content.col_date', 'Date'), width: '110px' },
        { id: 'duration', label: t('project_content.col_duration', 'Length'), width: '80px', align: 'right' },
        { id: 'actions_count', label: t('project_content.col_action_items', 'Action items'), width: '100px', align: 'right', foldBelow: 1180 },
        { id: 'owner', label: t('project_content.col_owner', 'Owner'), width: '150px', foldBelow: 1180 },
        { id: 'remove', label: '', width: '32px' },
    ];
}

export default function MeetingsTable({ meetings, loading, empty, ownerName, mayRemove, removingId, onOpen, onRemove }: MeetingsTableProps) {
    const { t, locale } = useTranslation();
    const columns = useColumns();
    const { isMobile } = useViewport();
    const [titleCol, dateCol, durationCol, actionsCol, ownerCol, removeCol] = columns;
    return (
        <DataTable
            columns={columns}
            rows={meetings}
            isMobile={isMobile}
            renderCard={(doc: ProjectMeeting) => <div className="flex items-start gap-2 w-full min-w-0">
                <button type="button" onClick={() => onOpen(doc)} className="min-w-0 flex-1 text-left py-1">
                    <span className="block text-sm font-medium text-[var(--text-primary)] break-words">{doc.title || t('project_content.meeting_untitled', 'Untitled meeting')}</span>
                    <span className="block text-xs text-[var(--text-secondary)]">{ownerName(doc.userId)}</span>
                </button>
                {mayRemove(doc) && <RemoveButton label={t('project_content.remove_from_project', 'Remove from project')} disabled={removingId === doc.id} onClick={() => onRemove(doc)} />}
            </div>}
            loading={loading}
            skeletonRows={4}
            empty={empty}
            ariaLabel={t('project_content.meetings_title', 'Meetings')}
            testId="project-meetings"
            renderRow={(m: ProjectMeeting) => {
                const title = m.title || t('project_content.meeting_untitled', 'Untitled meeting');
                const status = meetingStatusLabel(t, m.status);
                return (
                    <TableRow columns={columns} onClick={() => onOpen(m)} testId={`project-meeting-${m.id}`}>
                        <TableCell column={titleCol} className="flex items-center gap-2">
                            <Mic className="w-4 h-4 shrink-0 text-[var(--kind-meet)]" aria-hidden="true" />
                            <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
                            {status && <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] border border-[var(--border-default)] text-[var(--text-tertiary)]">{status}</span>}
                        </TableCell>
                        <TableCell column={dateCol} className="text-[var(--text-secondary)]">{m.createdAt ? new Date(m.createdAt).toLocaleDateString(locale) : ''}</TableCell>
                        <TableCell column={durationCol} className="tabular-nums text-[var(--text-secondary)]">{formatMeetingDuration(m.durationSeconds)}</TableCell>
                        <TableCell column={actionsCol} className="tabular-nums text-[var(--text-secondary)]">{typeof m.actionItemCount === 'number' ? m.actionItemCount : ''}</TableCell>
                        <TableCell column={ownerCol} className="truncate text-[var(--text-secondary)]">{ownerName(m.userId)}</TableCell>
                        <TableCell column={removeCol} align="right">
                            {mayRemove(m) && (
                                <RemoveButton
                                    label={t('project_content.remove_named', 'Remove {name} from the project', { name: title })}
                                    disabled={removingId === m.id}
                                    onClick={() => onRemove(m)}
                                />
                            )}
                        </TableCell>
                    </TableRow>
                );
            }}
        />
    );
}
