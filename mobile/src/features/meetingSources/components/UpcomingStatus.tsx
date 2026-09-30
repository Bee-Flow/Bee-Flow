/**
 * An upcoming row's status chip, with the web's words (UpcomingMeetings.jsx
 * StatusChip). "Note created" opens the note.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Badge, Chip, type BadgeTone } from '@/shared/ui';

function statusBadge(status: string, t: TranslateFn): { label: string; tone: BadgeTone } {
    switch (status) {
        case 'recording_now':
            return { label: t('meetings.upcoming_recording', 'Recording'), tone: 'accent' };
        case 'will_record':
            return { label: t('meetings.upcoming_will_record', 'Will record'), tone: 'accent' };
        case 'decides_at_start':
            return { label: t('meetings.upcoming_decides', 'Decides at start'), tone: 'neutral' };
        case 'not_moderator':
            return { label: t('meetings.upcoming_not_moderator', 'Not a moderator'), tone: 'neutral' };
        case 'not_organizer':
            return { label: t('meetings.upcoming_organizer_only', 'Organizer only'), tone: 'neutral' };
        case 'manual_record':
            return { label: t('meetings.upcoming_record_in_meet', 'Record in Meet'), tone: 'warning' };
        default:
            return { label: t('meetings.upcoming_upcoming', 'Upcoming'), tone: 'neutral' };
    }
}

export function UpcomingStatus({ status, onOpenNote }: { status: string; onOpenNote?: () => void }) {
    const t = useTranslation();
    if (status === 'recorded' && onOpenNote) {
        return <Chip label={t('meetings.upcoming_note_created', 'Note created')} tone="success" onPress={onOpenNote} />;
    }
    const badge = statusBadge(status, t);
    return <Badge label={badge.label} tone={badge.tone} />;
}
