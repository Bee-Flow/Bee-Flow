// Meetings tab of the project workspace: the meeting notes filed in the
// project, "Record or upload" (the app's capture modal; the finished meeting
// is filed here), "Add existing" from the caller's own recordings, and one
// meeting opened in place (sub = meeting id).

import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Mic, Plus } from 'lucide-react';
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useProjectSection, type ProjectMeeting } from '../../../../api/queries/projectContent';
import { projectKeys } from '../../../../api/queries/projects';
import useTranslation from '../../../../hooks/useTranslation';
import { lazy } from '../../../../utils/lazyWithReload';
import EmptyState from '../../../shared/EmptyState';
import { toast } from '../../../shared/Toast';
import { ContentColumn, ContentToolbar, PaneLoading, PrimaryButton, ReadOnlyNote, SecondaryButton, SectionError } from './contentUi';
import MeetingsTable, { type MeetingsTableProps } from './MeetingsTable';
import { MeetingPicker } from './pickers';
import { canEditContent, canRemoveItem, type ContentTabProps } from './types';
import { useMemberNames, useRemoveFromProject } from './useContentActions';
import useProjectMeetingCapture, { type ProjectMeetingCapture } from './useProjectMeetingCapture';

const MeetingDetail = lazy(() => import('../../../../pages/meeting-notes/detail/MeetingDetail'));

function MeetingPane({ projectId, meetingId, currentUser, onOpenSub, onNavigate }: {
    projectId: string; meetingId: string; currentUser: ContentTabProps['currentUser'];
    onOpenSub: ContentTabProps['onOpenSub']; onNavigate: ContentTabProps['onNavigate'];
}) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const refresh = () => { qc.invalidateQueries({ queryKey: projectKeys.resources(projectId) }); };
    return (
        <div className="h-full min-h-0" data-testid="project-meeting-pane">
            <Suspense fallback={<PaneLoading label={t('project_content.meeting_loading', 'Opening the meeting…')} />}>
                <MeetingDetail
                    key={meetingId}
                    id={meetingId}
                    currentUserId={currentUser?.id || null}
                    currentUserName={currentUser?.name || ''}
                    onBack={() => onOpenSub(null)}
                    onChanged={refresh}
                    onDeleted={() => { refresh(); onOpenSub(null); }}
                    onOpenNote={(id: string) => onOpenSub(id)}
                    onNavigate={onNavigate}
                />
            </Suspense>
        </div>
    );
}

/** While an armed capture is transcribed or filed, and when filing failed. */
function CaptureNotice({ capture }: { capture: ProjectMeetingCapture }) {
    const { t } = useTranslation();
    if (capture.error) {
        return (
            <div role="alert" className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                <span className="flex-1">{capture.error}</span>
                <button type="button" onClick={capture.dismissError} className="text-xs font-medium text-[var(--accent-primary)] hover:underline">
                    {t('project_content.dismiss', 'Dismiss')}
                </button>
            </div>
        );
    }
    if (!capture.uploading && !capture.filing) return null;
    return (
        <div role="status" className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-secondary)]" data-testid="meeting-capture-status">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--kind-meet)]" aria-hidden="true" />
            {capture.filing
                ? t('project_content.meeting_filing', 'Adding the meeting to this project…')
                : t('project_content.meeting_transcribing', 'Transcribing your recording. It appears here when it is ready; you can keep working meanwhile.')}
        </div>
    );
}

type TableHandlers = Pick<MeetingsTableProps, 'ownerName' | 'mayRemove' | 'removingId' | 'onOpen' | 'onRemove'>;

function MeetingsBody({ status, meetings, onRetry, onCapture, table }: {
    status: 'loading' | 'error' | 'ok'; meetings: ProjectMeeting[]; onRetry: () => void; onCapture: (() => void) | null; table: TableHandlers;
}) {
    const { t } = useTranslation();
    if (status === 'error') return <SectionError message={t('project_content.meetings_error', 'The meetings of this project could not be loaded.')} onRetry={onRetry} />;
    if (status === 'ok' && meetings.length === 0) {
        return (
            <EmptyState
                icon={<Mic className="w-10 h-10" />}
                title={t('project_content.meetings_empty_title', 'No meetings yet')}
                description={t('project_content.meetings_empty_desc', 'Record or upload a meeting and its transcript, summary and action items land here. Every member can read them; only the person who recorded a meeting can change it.')}
                action={onCapture ? { label: t('project_content.meetings_capture', 'Record or upload'), onClick: onCapture } : undefined}
            />
        );
    }
    return <MeetingsTable meetings={meetings} loading={status === 'loading'} empty={null} {...table} />;
}

function MeetingsList({ projectId, role, currentUser, onOpenSub, intent, capture }: ContentTabProps & { capture: ProjectMeetingCapture }) {
    const { t } = useTranslation();
    const canEdit = canEditContent(role);
    const me = currentUser?.id || null;
    const [pickerOpen, setPickerOpen] = useState(() => canEdit && intent === 'add');
    const section = useProjectSection<ProjectMeeting>(projectId, 'meetings');
    const ownerName = useMemberNames(projectId, me);
    const removal = useRemoveFromProject(projectId, 'meeting');
    useStartFromIntent(canEdit && intent === 'capture', capture.start);
    const inProject = useMemo(() => new Set(section.items.map(m => m.id)), [section.items]);

    const onRemove = (m: ProjectMeeting) => removal.remove(m.id, {
        title: t('project_content.meeting_remove_title', 'Remove this meeting from the project?'),
        description: t('project_content.meeting_remove_desc', '"{name}" stays with the person who recorded it. Members of this project will no longer see it.', { name: m.title || t('project_content.meeting_untitled', 'Untitled meeting') }),
        confirmLabel: t('project_content.remove', 'Remove'),
    });

    const actions = canEdit ? (
        <>
            <SecondaryButton icon={Plus} onClick={() => setPickerOpen(true)} testId="meetings-add-existing">{t('project_content.meetings_add_existing', 'Add existing meeting')}</SecondaryButton>
            <PrimaryButton icon={Mic} onClick={capture.start} disabled={capture.uploading || capture.filing} testId="meetings-capture">{t('project_content.meetings_capture', 'Record or upload')}</PrimaryButton>
        </>
    ) : null;

    return (
        <ContentColumn testId="project-meetings-tab">
            <ContentToolbar
                title={t('project_content.meetings_title', 'Meetings')}
                count={section.status === 'ok' ? section.items.length : null}
                actions={actions}
            />
            {!canEdit && <ReadOnlyNote>{t('project_content.meetings_viewer_note', 'You can read the meeting notes in this project. Ask the owner for editor access to add meetings.')}</ReadOnlyNote>}
            <CaptureNotice capture={capture} />
            <MeetingsBody
                status={section.status} meetings={section.items} onRetry={section.refetch}
                onCapture={canEdit ? capture.start : null}
                table={{
                    ownerName, removingId: removal.pendingId, onRemove,
                    mayRemove: (m) => canRemoveItem(role, m.userId, me),
                    onOpen: (m) => onOpenSub(m.id),
                }}
            />
            {pickerOpen && <MeetingPicker projectId={projectId} open onClose={() => setPickerOpen(false)} inProject={inProject} />}
            {removal.confirmDialog}
        </ContentColumn>
    );
}

/** Open the recorder once, as the tab opens, when the shell asked for it. */
function useStartFromIntent(wanted: boolean, start: () => void) {
    const done = useRef(false);
    useEffect(() => {
        if (!wanted || done.current) return;
        done.current = true;
        start();
    }, [wanted, start]);
}

export default function MeetingsTab(props: ContentTabProps) {
    const { t } = useTranslation();
    const { sub, onOpenSub } = props;
    // The capture is claimed here, above both views, so a meeting that
    // finishes while another one is open is still filed at once. It only
    // takes the member to the new meeting when they are on the list.
    const subRef = useRef(sub);
    useEffect(() => { subRef.current = sub; }, [sub]);
    const capture = useProjectMeetingCapture(props.projectId, (id) => {
        if (subRef.current) toast.success(t('project_content.meeting_filed', 'Your meeting was added to this project.'));
        else onOpenSub(id);
    });
    if (sub) {
        return <MeetingPane projectId={props.projectId} meetingId={sub} currentUser={props.currentUser} onOpenSub={onOpenSub} onNavigate={props.onNavigate} />;
    }
    return <MeetingsList {...props} capture={capture} />;
}
