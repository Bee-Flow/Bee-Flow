/** What changed: the five latest published changelog entries, if the server has any. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, ListSkeleton, NoteRow } from '@/shared/ui';

import { ReleaseNoteItem } from './ReleaseNoteItem';
import { useReleaseNotes } from '../hooks/queries';

export function ReleaseNotesGroup() {
    const t = useTranslation();
    const notes = useReleaseNotes();
    return (
        <Group title={t('mobile.settings.what_changed', 'What changed')}>
            {notes.isLoading ? (
                <NoteRow>
                    <ListSkeleton rows={2} />
                </NoteRow>
            ) : notes.data && notes.data.length > 0 ? (
                notes.data.slice(0, 5).map((entry) => <ReleaseNoteItem key={entry.id} entry={entry} />)
            ) : (
                <NoteRow>
                    {t(
                        'mobile.settings.release_notes_empty',
                        'Your server has not published any release notes, or its changelog is not reachable right now.',
                    )}
                </NoteRow>
            )}
        </Group>
    );
}
