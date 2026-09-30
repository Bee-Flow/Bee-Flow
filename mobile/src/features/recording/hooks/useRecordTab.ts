/**
 * The Meeting Notes tab's state: the recorder, the outbox, which recording's
 * details sheet is open (and whether it is brand new), and the notice about a
 * recording that reached the outbox without Stop (useRecordingRescue).
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { useDrainOnReconnect } from './useDrainOnReconnect';
import { useImportAudio } from './useImportAudio';
import { useRecorder } from './useRecorder';
import { useRecordingRescue } from './useRecordingRescue';
import { recordingKeys } from '../api/keys';
import { newCaptureSettings } from '../model/capture';
import { defaultMeetingTitle } from '../model/format';
import { closeJournal } from '../model/journal';
import { useOutbox } from '../model/outbox';

export function useRecordTab() {
    const queryClient = useQueryClient();
    const rescue = useRecordingRescue();
    const recorder = useRecorder({ onInterrupted: (audio, reason) => void rescue.keepInterrupted(audio, reason) });
    const outbox = useOutbox();
    const [saving, setSaving] = useState(false);
    const [requesting, setRequesting] = useState(false);
    const [editing, setEditing] = useState<{ id: string; fresh: boolean } | null>(null);

    // The server now owns it. Re-read the list so the new 'processing' note
    // appears immediately rather than after the next poll tick.
    const onAccepted = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: recordingKeys.list });
    }, [queryClient]);

    useDrainOnReconnect(onAccepted);
    const { importing, importAudio } = useImportAudio((id) => setEditing({ id, fresh: true }));

    useEffect(() => {
        // Recovery reads the outbox, so it waits for the queue to be back.
        void outbox.hydrate().then(() => rescue.recover(recorder.owns));
        void recorder.refreshPermission();
        // Deliberately mount-only: refreshPermission and hydrate are both
        // idempotent, and re-running them on every recorder state change would
        // hammer the permission module ten times a second while recording.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const stop = async () => {
        setSaving(true);
        try {
            const captured = await recorder.stop();
            if (!captured) return;
            const entry = await outbox.enqueue({
                ...captured,
                captureMode: 'recording',
                settings: newCaptureSettings(defaultMeetingTitle()),
            });
            // The outbox has it now; the journal's insurance is no longer needed.
            await closeJournal();
            // Ask about attendees BEFORE uploading, not after. Once the audio is
            // on the server the pipeline starts immediately, and the roster is
            // the one input that cannot be added late without a second run.
            setEditing({ id: entry.id, fresh: true });
        } finally {
            setSaving(false);
        }
    };

    const requestPermission = async () => {
        setRequesting(true);
        try {
            await recorder.requestPermission();
        } finally {
            setRequesting(false);
        }
    };

    const draft = outbox.items.find((item) => item.id === editing?.id) ?? null;
    return { recorder, outbox, onAccepted, notice: rescue.notice, dismissNotice: rescue.dismissNotice, saving, requesting, importing, importAudio, stop, requestPermission, editing, setEditing, draft };
}
