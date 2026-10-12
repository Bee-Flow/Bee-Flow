import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectCaptureContext, resetCaptureArm, useCaptureWorker } from './useProjectMeetingCapture';
import useTranslation from '../../../../hooks/useTranslation';
import { SecondaryButton } from '../workspaceUi';
import { toast } from '../../../shared/Toast';

export default function ProjectCaptureProvider({ children, onNavigate }: { children: React.ReactNode; onNavigate: (page: string) => void }) {
    const { t } = useTranslation();
    useEffect(() => () => resetCaptureArm(), []);
    const [request, setRequest] = useState({ projectId: '', serial: 0 });
    const callbacks = useRef(new Map<string, Set<(id: string) => void>>());
    const capture = useCaptureWorker(request.projectId, id => {
        const listeners = callbacks.current.get(request.projectId);
        if (listeners?.size) listeners.forEach(fn => fn(id));
        else toast.success(t('project_content.meeting_filed', 'Your meeting was added to this project.'));
    });
    const started = useRef(0);
    useEffect(() => {
        if (request.serial === started.current) return;
        started.current = request.serial;
        capture.start();
    }, [request.serial, capture]);
    const subscribe = useCallback((projectId: string, fn: (id: string) => void) => {
        const set = callbacks.current.get(projectId) || new Set();
        set.add(fn); callbacks.current.set(projectId, set);
        return () => { set.delete(fn); if (!set.size) callbacks.current.delete(projectId); };
    }, []);
    return <ProjectCaptureContext.Provider value={{ projectId: request.projectId, capture, subscribe,
        start: projectId => {
            // One app recorder: keep a failed filing recoverable before starting another capture.
            if (capture.filing || capture.uploading || capture.savedId || capture.pending) {
                toast.error(t('project_content.capture_busy', 'Finish or dismiss the current recording before starting another.'));
                return;
            }
            setRequest(r => ({ projectId, serial: r.serial + 1 }));
        } }}>
        {children}
        {capture.error && <div role="alert" className="fixed bottom-4 right-4 z-[100] max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-lg p-4 space-y-2">
            <p className="text-sm">{capture.error}</p>
            <div className="flex gap-2 flex-wrap">
                <SecondaryButton busy={capture.filing} onClick={() => capture.retry?.()}>{t('project_home.retry', 'Try again')}</SecondaryButton>
                <SecondaryButton onClick={() => onNavigate(`studio/meeting-notes/${capture.savedId}`)}>{t('project_content.open_saved_meeting', 'Open saved meeting')}</SecondaryButton>
                <SecondaryButton onClick={capture.dismissError}>{t('project_content.dismiss', 'Dismiss')}</SecondaryButton>
            </div>
        </div>}
    </ProjectCaptureContext.Provider>;
}
