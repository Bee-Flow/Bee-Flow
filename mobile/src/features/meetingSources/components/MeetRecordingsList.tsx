/**
 * Google Meet meetings that ended in the last week and whether each has a
 * recording (agent-hub GoogleMeetImportPanel.jsx), and under them the recent
 * automatic imports (GET /gmeet-imports), so a note that auto-import made — or
 * failed to make — can be found from here too.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';
import { QueryList } from '@/shared/patterns';
import { Banner, Section } from '@/shared/ui';

import { ImportRow } from './ImportRow';
import { useMeetImports, useMeetRecordings } from '../hooks/queries';
import type { ImportFlow } from '../hooks/useImportFlow';
import type { MeetImportJob, MeetRecording } from '../model/types';

const styles = StyleSheet.create({ jobs: { paddingTop: 16 }, banner: { paddingHorizontal: 16, paddingBottom: 8 } });

const keyOf = (recording: MeetRecording) => recording.eventId;

function recordingState(recording: MeetRecording, t: TranslateFn): string | undefined {
    if (recording.recordingState === 'processing') return t('meetings.gmeet_processing', 'Processing…');
    if (recording.recordingState === 'none') return t('meetings.gmeet_no_recording', 'No recording');
    return undefined;
}

function jobState(job: MeetImportJob, t: TranslateFn): string {
    if (job.status === 'pending' || job.status === 'awaiting_artifacts') return t('meetings.gmeet_processing', 'Processing…');
    if (job.status === 'skipped') return t('mobile.recording.import_skipped', 'Skipped');
    return t('meetings.import_failed', 'Import failed');
}

function ImportJobs({ onOpenNote }: { onOpenNote: (id: string) => void }) {
    const t = useTranslation();
    const jobs = useMeetImports(true).data ?? [];
    if (!jobs.length) return null;
    return (
        <View style={styles.jobs}>
            <Section title={t('mobile.recording.auto_imports', 'Automatic imports this week')}>
                {jobs.map((job) => (
                    <ImportRow
                        key={job.id}
                        title={job.title || t('meetings.gmeet_call', 'Meet call')}
                        subtitle={absoluteDate(job.meetingStart)}
                        icon="Video"
                        busy={false}
                        locked
                        noteId={job.transcriptionId}
                        state={jobState(job, t)}
                        onOpenNote={onOpenNote}
                    />
                ))}
            </Section>
        </View>
    );
}

export function MeetRecordingsList({ flow, onOpenNote }: { flow: ImportFlow; onOpenNote: (id: string) => void }) {
    const t = useTranslation();
    const query = useMeetRecordings(true);
    const connection = query.data?.connection;
    return (
        <>
            {connection && !connection.meetScopesGranted ? (
                <View style={styles.banner}>
                    <Banner tone="warning">
                        {connection.googleConnected
                            ? t(
                                  'meetings.gmeet_reconsent_desc',
                                  'Your Google account was connected before Meet recordings were supported. Re-authorize to let Bee Flow list and import your Meet recordings — your other Google integrations keep working.',
                              )
                            : t('meetings.upcoming_connect_google', 'Connect Google Workspace to see your Meet meetings here —')}
                    </Banner>
                </View>
            ) : null}
            <QueryList<MeetRecording>
                query={{ ...query, data: query.data?.items }}
                keyExtractor={keyOf}
                renderItem={({ item }) => (
                    <ImportRow
                        title={item.title || t('meetings.gmeet_call', 'Meet call')}
                        subtitle={absoluteDate(item.start)}
                        icon="Video"
                        busy={flow.busy === item.eventId}
                        locked={flow.busy !== null}
                        noteId={item.importedNoteId}
                        onImport={item.recordingState === 'available' ? () => flow.fromMeet(item) : undefined}
                        state={recordingState(item, t)}
                        onOpenNote={onOpenNote}
                    />
                )}
                ListFooterComponent={<ImportJobs onOpenNote={onOpenNote} />}
                empty={{
                    icon: 'Video',
                    title: t('meetings.gmeet_empty_title', 'No Meet recordings found'),
                    message: t(
                        'meetings.gmeet_empty_desc',
                        'Record a meeting in Google Meet (the host starts the recording). Finished recordings appear here shortly after the meeting ends.',
                    ),
                }}
            />
        </>
    );
}
