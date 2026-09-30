/**
 * The speaker editor in its sheet. A name fixed here is marked `manual` on the
 * server and outranks every later automatic pass.
 */

import React from 'react';

import { Sheet } from '@/shared/ui';

import { SpeakerEditorSheetBody } from './SpeakerEditorSheet';
import type { SpeakerEdit, Transcription } from '../model/types';

export function SpeakersSheet({
    visible,
    meeting,
    saving,
    reidentifying,
    error,
    onSave,
    onReidentify,
    onClose,
}: {
    visible: boolean;
    meeting: Transcription;
    saving: boolean;
    reidentifying: boolean;
    /** The server's refusal, shown verbatim: it names both colliding speakers. */
    error: string | null;
    onSave: (edit: SpeakerEdit) => void;
    onReidentify: (roster: string) => void;
    onClose: () => void;
}) {
    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Speakers"
            subtitle="Fix a name once and it stays fixed, even if this meeting is processed again."
        >
            <SpeakerEditorSheetBody
                speakers={meeting.speakers}
                attendees={meeting.attendees}
                saving={saving}
                reidentifying={reidentifying}
                error={error}
                onSave={onSave}
                onReidentify={onReidentify}
            />
        </Sheet>
    );
}
