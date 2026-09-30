/**
 * Nextcloud Talk call recordings (agent-hub TalkImportPanel.jsx), newest
 * first, one row per recording with its conversation named in the subtitle.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';

import { ImportRow } from './ImportRow';
import { useTalkRecordings } from '../hooks/queries';
import type { ImportFlow } from '../hooks/useImportFlow';
import { fileFacts } from '../model/imports';
import type { TalkRecording, TalkRoom } from '../model/types';

interface Item {
    room: TalkRoom;
    recording: TalkRecording;
}

const keyOf = (item: Item) => item.recording.path;

function roomName(room: TalkRoom, t: TranslateFn): string {
    return room.name || t('meetings.talk_conversation', 'Conversation {token}', { token: room.token });
}

function kindWord(kind: string, t: TranslateFn): string {
    return kind === 'video' ? t('meetings.kind_video', 'Video') : t('meetings.kind_audio', 'Audio');
}

export function TalkRecordingsList({ flow, onOpenNote }: { flow: ImportFlow; onOpenNote: (id: string) => void }) {
    const t = useTranslation();
    const query = useTalkRecordings(true);
    const items = query.data?.flatMap((room) => room.recordings.map((recording) => ({ room, recording })));
    return (
        <QueryList<Item>
            query={{ ...query, data: items }}
            keyExtractor={keyOf}
            renderItem={({ item }) => (
                <ImportRow
                    title={item.recording.name}
                    subtitle={[
                        roomName(item.room, t),
                        kindWord(item.recording.kind, t),
                        fileFacts(item.recording.size, item.recording.lastModified),
                    ]
                        .filter(Boolean)
                        .join(' · ')}
                    icon={item.recording.kind === 'video' ? 'Video' : 'FileAudio'}
                    busy={flow.busy === item.recording.path}
                    locked={flow.busy !== null}
                    onImport={() => flow.fromNextcloud(item.recording)}
                    onOpenNote={onOpenNote}
                />
            )}
            empty={{
                icon: 'MessageSquare',
                title: t('meetings.talk_empty_title', 'No Talk recordings found'),
                message: t(
                    'meetings.talk_empty_desc',
                    'Record a call in Nextcloud Talk (the moderator can record audio-only or video). Finished recordings appear here automatically.',
                ),
            }}
        />
    );
}
