/**
 * Audio files in a Nextcloud folder (GET /nextcloud-audio-files), for a
 * recording that was not made in Talk: a dictaphone upload, a phone memo
 * synced to Nextcloud. The folder is typed; the web's default is /Recordings.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

import { ImportRow } from './ImportRow';
import { useNextcloudFiles } from '../hooks/queries';
import type { ImportFlow } from '../hooks/useImportFlow';
import { DEFAULT_AUDIO_FOLDER, fileFacts, normaliseFolder } from '../model/imports';
import type { NextcloudFile } from '../model/types';

const styles = StyleSheet.create({ folder: { paddingHorizontal: 16, paddingBottom: 8 } });

const keyOf = (file: NextcloudFile) => file.path;

export function NextcloudFilesList({ flow, onOpenNote }: { flow: ImportFlow; onOpenNote: (id: string) => void }) {
    const t = useTranslation();
    const [typed, setTyped] = useState(DEFAULT_AUDIO_FOLDER);
    const [folder, setFolder] = useState(DEFAULT_AUDIO_FOLDER);
    const query = useNextcloudFiles(folder, true);
    return (
        <>
            <View style={styles.folder}>
                <TextField
                    label={t('mobile.recording.nextcloud_folder', 'Nextcloud folder')}
                    value={typed}
                    onChangeText={setTyped}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    onSubmitEditing={() => setFolder(normaliseFolder(typed))}
                    onBlur={() => setFolder(normaliseFolder(typed))}
                />
            </View>
            <QueryList<NextcloudFile>
                query={query}
                keyExtractor={keyOf}
                renderItem={({ item }) => (
                    <ImportRow
                        title={item.name}
                        subtitle={fileFacts(item.size, item.lastModified)}
                        icon="FileAudio"
                        busy={flow.busy === item.path}
                        locked={flow.busy !== null}
                        onImport={() => flow.fromNextcloud(item)}
                        onOpenNote={onOpenNote}
                    />
                )}
                empty={{
                    icon: 'FolderOpen',
                    title: t('mobile.recording.nextcloud_empty', 'No audio files in this folder'),
                    message: t(
                        'mobile.recording.nextcloud_empty_hint',
                        'Audio and video files (.mp3, .wav, .m4a, .webm, .mp4 and more) in this Nextcloud folder show up here.',
                    ),
                }}
            />
        </>
    );
}
