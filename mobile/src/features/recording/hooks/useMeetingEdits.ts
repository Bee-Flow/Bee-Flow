/**
 * The meeting screen's edits — rename, rewrite the summary, fix the speakers —
 * with what each one says when it lands or fails. `closeSheet` puts the screen
 * back once an edit has been accepted.
 */

import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import {
    useReidentifySpeakers,
    useRegenerateSummary,
    useRenameTranscription,
    useUpdateSpeakers,
} from './mutations';
import { describeRegenerateOutcome } from '../model/regenerate';

export function useMeetingEdits(id: string, closeSheet: () => void) {
    const t = useTranslation();
    const { toast } = useToast();
    const [speakerError, setSpeakerError] = useState<string | null>(null);
    const showError = (err: Error) => toast(describeError(err).message, 'error');
    // The collision message is written for a human and names both speakers —
    // showing it verbatim beats any paraphrase.
    const showSpeakerError = (err: Error) => setSpeakerError(describeError(err).message);

    const rename = useRenameTranscription(id, {
        onSuccess: () => {
            closeSheet();
            toast(t('mobile.recording.renamed', 'Renamed'), 'success');
        },
        onError: showError,
    });

    // Not unconditionally green: the server ALSO answers 200 when the elaboration
    // of action items, decisions and questions has failed, and says so only in
    // `artifactsRegenerated`. describeRegenerateOutcome is the same rule as in the
    // web client, pure and tested separately.
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
            toast(t('mobile.recording.speakers_updated', 'Speakers updated'), 'success');
        },
        onError: showSpeakerError,
    });

    const reidentify = useReidentifySpeakers(id, {
        onSuccess: () => {
            setSpeakerError(null);
            toast(t('mobile.recording.speakers_reidentified', 'Speakers re-identified'), 'success');
        },
        onError: showSpeakerError,
    });

    return { rename, regenerate, editSpeakers, reidentify, speakerError, clearSpeakerError: () => setSpeakerError(null) };
}
