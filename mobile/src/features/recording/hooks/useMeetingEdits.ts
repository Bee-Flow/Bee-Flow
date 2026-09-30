/**
 * The meeting screen's edits — rename, rewrite the summary, fix the speakers —
 * with what each one says when it lands or fails. `closeSheet` puts the screen
 * back once an edit has been accepted.
 */

import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useToast } from '@/shared/ui';

import {
    useReidentifySpeakers,
    useRegenerateSummary,
    useRenameTranscription,
    useUpdateSpeakers,
} from './mutations';
import { describeRegenerateOutcome } from '../model/regenerate';

export function useMeetingEdits(id: string, closeSheet: () => void) {
    const { toast } = useToast();
    const [speakerError, setSpeakerError] = useState<string | null>(null);
    const showError = (err: Error) => toast(describeError(err).message, 'error');
    // The collision message is written for a human and names both speakers —
    // showing it verbatim beats any paraphrase.
    const showSpeakerError = (err: Error) => setSpeakerError(describeError(err).message);

    const rename = useRenameTranscription(id, {
        onSuccess: () => {
            closeSheet();
            toast('Renamed', 'success');
        },
        onError: showError,
    });

    // Niet onvoorwaardelijk groen: de server antwoordt 200 óók als het
    // uitwerken van actiepunten, besluiten en vragen is omgevallen, en zegt dat
    // alleen in `artifactsRegenerated`. describeRegenerateOutcome is dezelfde
    // regel als in de webclient, puur en apart getest.
    const regenerate = useRegenerateSummary(id, {
        onSuccess: (res) => {
            closeSheet();
            const outcome = describeRegenerateOutcome(res);
            toast(outcome.message, outcome.kind === 'success' ? 'success' : 'neutral');
        },
        onError: showError,
    });

    const editSpeakers = useUpdateSpeakers(id, {
        onSuccess: () => {
            setSpeakerError(null);
            closeSheet();
            toast('Speakers updated', 'success');
        },
        onError: showSpeakerError,
    });

    const reidentify = useReidentifySpeakers(id, {
        onSuccess: () => {
            setSpeakerError(null);
            toast('Speakers re-identified', 'success');
        },
        onError: showSpeakerError,
    });

    return { rename, regenerate, editSpeakers, reidentify, speakerError, clearSpeakerError: () => setSpeakerError(null) };
}
