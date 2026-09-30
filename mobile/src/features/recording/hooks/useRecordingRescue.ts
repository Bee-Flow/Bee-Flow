/**
 * The two ways a meeting reaches the outbox without anybody pressing Stop, and
 * the sentence that tells the person it happened.
 *
 *   - RECOVERED: the app died mid-recording (a battery manager, a crash, a
 *     reboot). The journal still points at the file; on the next open it is
 *     queued as "Recovered recording from <time>", to upload or delete.
 *   - INTERRUPTED: the recorder ended while the app lived (the encoder or the
 *     media server failed). What was written is queued straight away.
 *
 * Either way the recording is never deleted here, and never silently queued.
 */

import { useState } from 'react';

import { useTranslation } from '@/core/i18n';

import { newCaptureSettings } from '../model/capture';
import type { CapturedAudio } from '../model/files';
import { defaultMeetingTitle } from '../model/format';
import { closeJournal, recoverInterrupted } from '../model/journal';
import { useOutbox } from '../model/outbox';

export type RecordingNotice =
    | { kind: 'recovered'; title: string }
    | { kind: 'interrupted'; kept: boolean; reason: string | null };

function startedLabel(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    return at.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Queue a file the person did not stop, then let the journal go. */
async function queue(audio: CapturedAudio, title: string): Promise<void> {
    await useOutbox.getState().enqueue({ ...audio, captureMode: 'recording', settings: newCaptureSettings(title) });
    await closeJournal();
}

export function useRecordingRescue() {
    const t = useTranslation();
    const [notice, setNotice] = useState<RecordingNotice | null>(null);

    /** After the outbox has hydrated, with no recording running. */
    const recover = async (isLive: (uri: string) => boolean): Promise<void> => {
        const found = await recoverInterrupted({
            isLive,
            isQueued: (uri) => useOutbox.getState().items.some((item) => item.uri === uri),
        });
        if (!found) return;
        const title = t('mobile.recording.recovered_title', 'Recovered recording from {time}', {
            time: startedLabel(found.startedAt),
        });
        await queue(found.audio, title);
        setNotice({ kind: 'recovered', title });
    };

    const keepInterrupted = async (audio: CapturedAudio | null, reason: string | null): Promise<void> => {
        if (audio) await queue(audio, defaultMeetingTitle());
        else await closeJournal();
        setNotice({ kind: 'interrupted', kept: Boolean(audio), reason });
    };

    return { notice, dismissNotice: () => setNotice(null), recover, keepInterrupted };
}
