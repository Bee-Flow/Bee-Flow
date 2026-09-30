/**
 * One importable recording: what it is, and Transcribe — or, once it has a
 * note, a way to that note instead of a second transcription.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Button, Chip, Icon, ListRow, type IconName } from '@/shared/ui';

export interface ImportRowProps {
    title: string;
    subtitle?: string;
    icon: IconName;
    busy: boolean;
    /** Another import is running: one at a time, like the web's panels. */
    locked: boolean;
    /** The note this recording already became, when known. */
    noteId?: string | null;
    /** Absent when there is nothing to import (no recording yet). */
    onImport?: () => void;
    onOpenNote: (id: string) => void;
    /** Shown instead of the button when there is nothing to import. */
    state?: string;
}

export function ImportRow({ title, subtitle, icon, busy, locked, noteId, onImport, onOpenNote, state }: ImportRowProps) {
    const t = useTranslation();
    const theme = useTheme();
    let trailing: React.ReactNode = null;
    if (noteId) {
        trailing = (
            <Chip label={t('meetings.upcoming_note_created', 'Note created')} tone="success" onPress={() => onOpenNote(noteId)} />
        );
    } else if (onImport) {
        trailing = (
            <Button
                label={busy ? t('meetings.transcribing', 'Transcribing…') : t('meetings.transcribe', 'Transcribe')}
                size="sm"
                variant="secondary"
                loading={busy}
                disabled={locked && !busy}
                onPress={onImport}
            />
        );
    } else if (state) {
        trailing = <Chip label={state} tone="muted" />;
    }
    return (
        <ListRow
            title={title}
            subtitle={subtitle}
            wrapTitle
            leading={<Icon name={icon} size={18} color={theme.colors.textTertiary} />}
            trailing={trailing}
        />
    );
}
