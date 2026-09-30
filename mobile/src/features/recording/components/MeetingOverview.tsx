/**
 * Everything above the transcript, in whichever of the note's three states it
 * is in: still processing, failed (with the reason and a retry), or finished.
 *
 * A separate component purely so the FlatList header does not re-render on
 * every scroll frame along with the rest of the screen's state.
 */

import React from 'react';

import { MeetingFailedCard } from './MeetingFailedCard';
import { MeetingNotes, type MeetingNotesProps } from './MeetingNotes';
import { MeetingProcessingCard } from './MeetingProcessingCard';

export interface MeetingOverviewProps extends MeetingNotesProps {
    retrying: boolean;
    onRetry: () => void;
}

export function MeetingOverview({ retrying, onRetry, ...notes }: MeetingOverviewProps) {
    if (notes.meeting.status === 'processing') return <MeetingProcessingCard />;
    if (notes.meeting.status === 'failed') {
        return <MeetingFailedCard meeting={notes.meeting} retrying={retrying} onRetry={onRetry} />;
    }
    return <MeetingNotes {...notes} />;
}
