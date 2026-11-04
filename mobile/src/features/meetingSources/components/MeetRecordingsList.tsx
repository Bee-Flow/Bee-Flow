/**
 * Google Meet meetings that ended in the last week and whether each has a
 * recording (agent-hub GoogleMeetImportPanel.jsx), and under them the recent
 * automatic imports (GET /gmeet-imports), so a note that auto-import made — or
 * failed to make — can be found from here too.
 *
 * The imports feed does not depend on the recordings list: with no Google
 * session, missing Meet scopes or no meeting this week the recordings come
 * back empty while the week's (failed) imports still exist, and that is when
 * they matter most. QueryList drops its footer while loading, failed or
 * empty, so the feed is the list's footer only when there are rows, and
 * stands under the list otherwise.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';
import { QueryList } from '@/shared/patterns';
import { Banner, Button, Section } from '@/shared/ui';

import { ImportRow } from './ImportRow';
import { useMeetImports, useMeetRecordings } from '../hooks/queries';
import type { ImportFlow } from '../hooks/useImportFlow';
import type { MeetConnection, MeetImportJob, MeetRecording } from '../model/types';

const styles = StyleSheet.create({
    jobs: { paddingTop: 16 },
    // Under an empty or loading list: its natural height, scrolling once it outgrows the screen.
    jobsAlone: { flexGrow: 0, flexShrink: 1 },
    banner: { paddingHorizontal: 16, paddingBottom: 8 },
});

const keyOf = (recording: MeetRecording) => recording.eventId;

function recordingState(recording: MeetRecording, t: TranslateFn): string | undefined {
    if (recording.recordingState === 'processing') return t('meetings.gmeet_processing', 'Processing…');
    if (recording.recordingState === 'none') return t('meetings.gmeet_no_recording', 'No recording');
    return undefined;
}

/**
 * The chip of a job without a note. Only a job that gave up is a failure:
 * `duplicate` waits on a colleague's import of the same conference (it goes
 * back to pending when that one gives up), `needs_reauth` is parked until
 * Google is reconnected and then resumes.
 */
function jobState(job: MeetImportJob, t: TranslateFn): string {
    if (job.status === 'pending' || job.status === 'awaiting_artifacts') return t('meetings.gmeet_processing', 'Processing…');
    if (job.status === 'duplicate') return t('mobile.recording.import_duplicate', 'Imported by a colleague');
    if (job.status === 'needs_reauth') return t('mobile.recording.import_needs_reauth', 'Reconnect Google');
    if (job.status === 'skipped') return t('mobile.recording.import_skipped', 'Skipped');
    return t('meetings.import_failed', 'Import failed');
}

function ImportJobs({ onOpenNote }: { onOpenNote: (id: string) => void }) {
    const t = useTranslation();
    const router = useRouter();
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
                        onStatePress={job.status === 'needs_reauth' ? () => router.push('/integrations') : undefined}
                        onOpenNote={onOpenNote}
                    />
                ))}
            </Section>
        </View>
    );
}

/**
 * Why the list may be empty for a reason other than "no recordings": an
 * expired grant first (the stored scopes survive it, so the scope check alone
 * says all is well), then no connection, then a connection without Meet.
 */
function ConnectionBanner({ connection }: { connection: MeetConnection | undefined }) {
    const t = useTranslation();
    const router = useRouter();
    if (!connection) return null;
    const toIntegrations = (label: string) => (
        <Button label={label} variant="ghost" size="sm" onPress={() => router.push('/integrations')} />
    );
    let banner: React.ReactNode = null;
    if (connection.needsReauth) {
        banner = (
            <Banner tone="warning" action={toIntegrations(t('meetings.upcoming_reconnect', 'Reconnect'))}>
                {t(
                    'mobile.recording.gmeet_access_expired',
                    'Your Google access expired. Reconnect Google to see and import your Meet meetings.',
                )}
            </Banner>
        );
    } else if (!connection.googleConnected) {
        banner = (
            <Banner tone="info" icon="Video" action={toIntegrations(t('meetings.upcoming_settings_integrations', 'Settings → Connections'))}>
                {t('meetings.upcoming_connect_google', 'Connect Google Workspace to see your Meet meetings here —')}
            </Banner>
        );
    } else if (!connection.meetScopesGranted) {
        banner = (
            <Banner tone="warning" action={toIntegrations(t('meetings.upcoming_reconnect', 'Reconnect'))}>
                {t(
                    'meetings.gmeet_reconsent_desc',
                    'Your Google account was connected before Meet recordings were supported. Re-authorize to let Bee Flow list and import your Meet recordings — your other Google integrations keep working.',
                )}
            </Banner>
        );
    }
    return banner ? <View style={styles.banner}>{banner}</View> : null;
}

export function MeetRecordingsList({ flow, onOpenNote }: { flow: ImportFlow; onOpenNote: (id: string) => void }) {
    const t = useTranslation();
    const query = useMeetRecordings(true);
    // Same query key as ImportJobs below, so no extra request: pull-to-refresh
    // re-reads the jobs footer along with the recordings.
    const imports = useMeetImports(true);
    const items = query.data?.items;
    // QueryList's Rows branch, the only one that renders a footer.
    const hasRows = !query.isLoading && (items?.length ?? 0) > 0;
    const jobs = <ImportJobs onOpenNote={onOpenNote} />;
    return (
        <>
            <ConnectionBanner connection={query.data?.connection} />
            <QueryList<MeetRecording>
                query={{ ...query, data: items, refetch: () => Promise.all([query.refetch(), imports.refetch()]) }}
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
                ListFooterComponent={hasRows ? jobs : null}
                empty={{
                    icon: 'Video',
                    title: t('meetings.gmeet_empty_title', 'No Meet recordings found'),
                    message: t(
                        'meetings.gmeet_empty_desc',
                        'Record a meeting in Google Meet (the host starts the recording). Finished recordings appear here shortly after the meeting ends.',
                    ),
                }}
            />
            {hasRows ? null : <ScrollView style={styles.jobsAlone}>{jobs}</ScrollView>}
        </>
    );
}
