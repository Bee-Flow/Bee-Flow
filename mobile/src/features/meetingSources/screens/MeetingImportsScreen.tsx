/**
 * Import a meeting that was recorded somewhere else: a Nextcloud Talk call
 * recording, any audio file in Nextcloud, or a Google Meet recording — the
 * web capture modal's Talk and Meet panels and the Nextcloud side of its
 * upload panel, one source per segment.
 *
 * An import is synchronous on the server (download, transcribe, summarise)
 * and can take minutes; the row keeps its spinner until the note exists and
 * then opens it. One import at a time, as on the web.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Banner, Button, Screen, ScreenHeader, Segmented, Text } from '@/shared/ui';

import { MeetRecordingsList } from '../components/MeetRecordingsList';
import { NextcloudFilesList } from '../components/NextcloudFilesList';
import { TalkRecordingsList } from '../components/TalkRecordingsList';
import { useImportFlow } from '../hooks/useImportFlow';

type Source = 'talk' | 'files' | 'meet';

const styles = StyleSheet.create({
    top: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
});

function pickHint(source: Source, t: TranslateFn): string {
    if (source === 'meet') {
        return t('meetings.gmeet_pick', 'Pick a recorded Meet call — Bee Flow transcribes it with your configured engine.');
    }
    if (source === 'files') {
        return t(
            'mobile.recording.nextcloud_pick',
            'Pick an audio file from your Nextcloud — Bee Flow transcribes it with your configured engine.',
        );
    }
    return t('meetings.talk_pick', 'Pick a call recording — Bee Flow transcribes it with your configured engine.');
}

export function MeetingImportsScreen() {
    const t = useTranslation();
    const router = useRouter();
    const flow = useImportFlow();
    const [source, setSource] = useState<Source>('talk');
    const openNote = (id: string) => router.push(`/recordings/${id}`);
    const lists = {
        talk: <TalkRecordingsList flow={flow} onOpenNote={openNote} />,
        files: <NextcloudFilesList flow={flow} onOpenNote={openNote} />,
        meet: <MeetRecordingsList flow={flow} onOpenNote={openNote} />,
    };

    return (
        <Screen edges={['top']}>
            <ScreenHeader title={t('mobile.recording.tools_import', 'Import from Nextcloud or Google Meet')} />
            <View style={styles.top}>
                <Segmented<Source>
                    fullWidth
                    value={source}
                    onChange={setSource}
                    options={[
                        { value: 'talk', label: t('meetings.capture_tile_talk_title', 'Nextcloud Talk') },
                        { value: 'files', label: t('mobile.recording.nextcloud_files', 'Nextcloud files') },
                        { value: 'meet', label: t('meetings.capture_tile_gmeet_title', 'Google Meet') },
                    ]}
                />
                <Text variant="caption" tone="tertiary">
                    {pickHint(source, t)}
                </Text>
                {flow.error ? (
                    <Banner
                        tone="error"
                        action={<Button label={t('meetings.dismiss', 'Dismiss')} variant="ghost" onPress={flow.clearError} />}
                    >
                        <Text variant="caption" weight="semibold">
                            {t('meetings.import_failed', 'Import failed')}
                        </Text>
                        <Text variant="caption" tone="secondary">
                            {describeError(flow.error).message}
                        </Text>
                    </Banner>
                ) : null}
            </View>
            {lists[source]}
        </Screen>
    );
}
