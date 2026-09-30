// "Record or upload" from a project's meetings tab.
//
// The capture itself is the app's own modal and recorder (one per app, they
// outlive page changes), which know nothing about projects. So the tab ARMS a
// capture for its project, and when the recorder reports a finished meeting
// the tab files it into the project (PUT /:id/resources, kind meeting) and
// opens it.
//
// The arm lives at module scope, not in component state: transcribing a long
// recording takes minutes, and the member may look at another tab meanwhile.
// When they come back, the finished meeting is still waiting in the recorder
// and is claimed then. Filing makes a transcript readable by every member, so
// an arm claims exactly ONE result, the one its own capture produced, and
// nothing that might be another meeting:
//   - it only claims the FIRST result that finished after it was armed (the
//     recorder's completion counter moved on by exactly one). Two or more
//     finished meanwhile: the newest is not known to be ours, so it disarms;
//   - the capture modal was opened again from anywhere else (the meeting
//     palette, the meeting notes page, a notebook) since the arm: whatever
//     finishes now may be that capture, so it disarms. The capture context
//     numbers every opening for this;
//   - a result someone else already took (the meeting notes page claims every
//     result while it is open) disarms it;
//   - closing the capture modal without starting anything disarms it, and an
//     arm older than ARM_TTL_MS is dropped.
// When in doubt the meeting stays where it is, private to its owner, who can
// still add it to the project by hand.

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useAttachResource } from '../../../../api/queries/projects';
import useTranslation from '../../../../hooks/useTranslation';
import { projectErrorText } from '../projectErrorText';
import { useCapture } from '../../../../pages/meeting-notes/capture/CaptureContext';
import { useRecorder } from '../../../../pages/meeting-notes/hooks/RecorderContext';

export const ARM_TTL_MS = 6 * 60 * 60 * 1000;

export interface CaptureArm {
    projectId: string;
    /** The recorder's completion counter when the capture was started. */
    version: number;
    /** The capture modal's opening this arm started (see CaptureContext). */
    session: number;
    at: number;
}

/** What the app's capture and recorder say right now. */
export interface CaptureState {
    version: number;
    lastResultId: string | null;
    /** The capture modal's latest opening. */
    session: number;
}

let arm: CaptureArm | null = null;

/** For tests: the arm in flight, and a way to reset it between cases. */
export function currentCaptureArm(): CaptureArm | null { return arm; }
export function resetCaptureArm(): void { arm = null; }

export type ClaimDecision = 'wait' | 'disarm' | 'claim' | 'ignore';

/** What to do with the recorder's latest result, for the project `projectId`. */
export function decideClaim(current: CaptureArm | null, projectId: string, state: CaptureState, now: number): ClaimDecision {
    if (!current || current.projectId !== projectId) return 'ignore';
    if (now - current.at > ARM_TTL_MS) return 'disarm';
    // Another capture was opened since: its result is not ours to file.
    if (state.session !== current.session) return 'disarm';
    if (state.version <= current.version) return 'wait';
    // More than one capture finished since the arm: the newest may not be ours.
    if (state.version !== current.version + 1) return 'disarm';
    return state.lastResultId ? 'claim' : 'disarm';
}

export interface ProjectMeetingCapture {
    /** Open the capture modal for this project. */
    start: () => void;
    /** A capture for this project is armed. */
    pending: boolean;
    /** The armed capture is being uploaded and transcribed. */
    uploading: boolean;
    /** The finished meeting is being filed into the project. */
    filing: boolean;
    error: string | null;
    dismissError: () => void;
}

export default function useProjectMeetingCapture(projectId: string, onFiled: (meetingId: string) => void): ProjectMeetingCapture {
    const { t } = useTranslation();
    const { open: captureOpen, openCapture, session: captureSession = 0 } = useCapture();
    const recorder = useRecorder();
    const attach = useAttachResource(projectId);
    const [, rerender] = useState(0);
    const [filing, setFiling] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const wasOpen = useRef(captureOpen);
    const mine = arm?.projectId === projectId;

    const start = () => {
        const version = recorder.version;
        const session = openCapture() ?? 0;
        arm = { projectId, version, session, at: Date.now() };
        setError(null);
        rerender(n => n + 1);
    };

    const claim = useEffectEvent(async () => {
        const state = { version: recorder.version, lastResultId: recorder.lastResultId, session: captureSession };
        const decision = decideClaim(arm, projectId, state, Date.now());
        if (decision === 'ignore' || decision === 'wait') return;
        arm = null;
        rerender(n => n + 1);
        if (decision === 'disarm') return;
        const { id } = recorder.consumeLastResult();
        if (!id) return;
        setFiling(true);
        try {
            await attach.mutateAsync({ kind: 'meeting', id, attach: true });
            onFiled(id);
        } catch (e) {
            setError(projectErrorText(t, e, t('project_content.meeting_file_failed', 'The meeting was saved, but it could not be added to this project.')));
        } finally {
            setFiling(false);
        }
    });

    useEffect(() => { claim(); }, [recorder.version, recorder.lastResultId, captureSession]);

    // Closing the modal with nothing recorded, uploading or finished is a cancel.
    const onModalClosed = useEffectEvent(() => {
        const idle = recorder.recorder?.state === 'idle' && !recorder.uploading;
        if (arm?.projectId === projectId && idle && recorder.version === arm.version) {
            arm = null;
            rerender(n => n + 1);
        }
    });

    useEffect(() => {
        if (wasOpen.current && !captureOpen) onModalClosed();
        wasOpen.current = captureOpen;
    }, [captureOpen]);

    return {
        start,
        pending: mine,
        uploading: mine && !!recorder.uploading,
        filing,
        error,
        dismissError: () => setError(null),
    };
}
