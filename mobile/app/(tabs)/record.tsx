/**
 * The Record tab — the one thing this app does that a browser tab cannot.
 *
 * The tab has three jobs, in this order of priority:
 *
 *   1. Start recording in one tap. Someone opening this screen is usually in a
 *     room where a meeting has already started, so the capture control is the
 *     first thing under the header and never behind a menu.
 *   2. Show what has not been uploaded yet. Between "stop" and the server's
 *     202 the phone holds the ONLY copy of the audio, so the outbox sits ABOVE
 *     the library: a failed upload has to be the most visible thing on the
 *     screen, not a footnote under thirty finished meetings.
 *   3. List past meetings and their state.
 *
 * While recording, the tab becomes the recorder — the list and the header are
 * gone. For the next hour nothing else on this screen is anything but a
 * mis-tap risk.
 */

import { Feather } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { getLocales } from 'expo-localization';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import {
    MAX_UPLOAD_BYTES,
    PROCESSING_POLL_MS,
    TRANSCRIPTION_LANGUAGES,
    isAcceptedAudioName,
    listTranscriptions,
    recordingKeys,
} from '../../src/features/recording/api';
import { CaptureSettingsForm } from '../../src/features/recording/components/CaptureSettingsForm';
import { LiveRecorder } from '../../src/features/recording/components/LiveRecorder';
import { MicPermissionCard } from '../../src/features/recording/components/MicPermissionCard';
import { OutboxRow } from '../../src/features/recording/components/OutboxRow';
import { TranscriptionRow } from '../../src/features/recording/components/TranscriptionRow';
import { defaultMeetingTitle } from '../../src/features/recording/format';
import { useOutbox } from '../../src/features/recording/outbox';
import type { TranscriptionSummary } from '../../src/features/recording/types';
import { RECORDINGS_DIRNAME, useRecorder } from '../../src/features/recording/useRecorder';
import { formatBytes } from '../../src/lib/bytes';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Button } from '../../src/ui/Button';
import { Banner, EmptyState, ErrorState, ListSkeleton, describeError } from '../../src/ui/Feedback';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

/**
 * The device's language, if we transcribe it; Dutch otherwise.
 *
 * Dutch is the product default on the server (`language = req.body.language ||
 * 'nl'`) and this is a Dutch-first product, so it is the fallback rather than
 * English — but a phone set to German should not have to change the language
 * on every recording.
 */
function defaultLanguage(): string {
    const code = getLocales()[0]?.languageCode?.toLowerCase();
    return code && TRANSCRIPTION_LANGUAGES.some((l) => l.code === code) ? code : 'nl';
}

export default function RecordScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const recorder = useRecorder();
    const items = useOutbox((state) => state.items);
    const hydrate = useOutbox((state) => state.hydrate);
    const enqueue = useOutbox((state) => state.enqueue);
    const upload = useOutbox((state) => state.upload);
    const uploadAll = useOutbox((state) => state.uploadAll);
    const cancelUpload = useOutbox((state) => state.cancel);
    const discard = useOutbox((state) => state.discard);
    const updateSettings = useOutbox((state) => state.updateSettings);

    const [saving, setSaving] = useState(false);
    const [importing, setImporting] = useState(false);
    const [requesting, setRequesting] = useState(false);
    /** The outbox entry whose details sheet is open, and whether it is brand new. */
    const [editing, setEditing] = useState<{ id: string; fresh: boolean } | null>(null);

    const query = useQuery({
        queryKey: recordingKeys.list,
        queryFn: ({ signal }) => listTranscriptions(signal),
        // Poll only while the server still owes us something. The upload route
        // answers 202 and finishes in the background, so this is the only way
        // a note ever turns from 'processing' into a transcript.
        refetchInterval: (q) =>
            (q.state.data ?? []).some((item) => item.status === 'processing')
                ? PROCESSING_POLL_MS
                : false,
    });

    useEffect(() => {
        void hydrate();
        void recorder.refreshPermission();
        // Deliberately mount-only: refreshPermission and hydrate are both
        // idempotent, and re-running them on every recorder state change would
        // hammer the permission module ten times a second while recording.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onAccepted = useCallback(() => {
        // The server now owns it. Re-read the list so the new 'processing' note
        // appears immediately rather than after the next poll tick.
        void queryClient.invalidateQueries({ queryKey: recordingKeys.list });
    }, [queryClient]);

    /**
     * Come back online → drain the queue.
     *
     * The common failure is a recording finished in a basement meeting room
     * with no signal. Retrying by hand works, but the person who most needs
     * this is the one who has already put their phone away.
     */
    const queuedCount = items.filter((item) => item.status !== 'uploading').length;
    const wasOffline = useRef(false);
    useEffect(() => {
        const unsubscribe = NetInfo.addEventListener((state) => {
            const online = Boolean(state.isConnected) && state.isInternetReachable !== false;
            if (!online) {
                wasOffline.current = true;
                return;
            }
            if (wasOffline.current && queuedCount > 0) {
                wasOffline.current = false;
                void uploadAll(onAccepted);
            }
            wasOffline.current = false;
        });
        return unsubscribe;
    }, [queuedCount, uploadAll, onAccepted]);

    const settingsDraft = useMemo(
        () => items.find((item) => item.id === editing?.id) ?? null,
        [items, editing],
    );

    // ── Capture ──────────────────────────────────────────────────────

    // `start` returns false when the permission is missing. No toast in that
    // case: the card below already explains the situation, and saying it twice
    // is worse than saying it once.
    const handleStart = useCallback(async () => {
        await recorder.start();
    }, [recorder]);

    const handleStop = useCallback(async () => {
        setSaving(true);
        try {
            const captured = await recorder.stop();
            if (!captured) return;
            const entry = await enqueue({
                ...captured,
                captureMode: 'recording',
                settings: {
                    title: defaultMeetingTitle(),
                    language: defaultLanguage(),
                    attendees: '',
                    contextTerms: '',
                    numSpeakers: '',
                },
            });
            // Ask about attendees BEFORE uploading, not after. Once the audio
            // is on the server the pipeline starts immediately, and the roster
            // is the one input that cannot be added late without paying for a
            // second run.
            setEditing({ id: entry.id, fresh: true });
        } finally {
            setSaving(false);
        }
    }, [recorder, enqueue]);

    const handleDiscardLive = useCallback(async () => {
        await recorder.discard();
    }, [recorder]);

    // ── Import ───────────────────────────────────────────────────────

    const handleImport = useCallback(async () => {
        setImporting(true);
        try {
            const result = await DocumentPicker.getDocumentAsync({
                // multer accepts anything with an `audio/*` MIME type or one of
                // its known extensions, so this is the widest honest filter.
                type: ['audio/*'],
                copyToCacheDirectory: true,
                multiple: false,
            });
            if (result.canceled) return;
            const asset = result.assets[0];
            if (!asset) return;

            // Refuse locally what the server would refuse anyway. Discovering a
            // 400 after ten minutes of uploading on mobile data is not a
            // rejection, it is a betrayal.
            if (!isAcceptedAudioName(asset.name) && !asset.mimeType?.startsWith('audio/')) {
                toast('That file type cannot be transcribed', 'error');
                return;
            }
            const size = asset.size ?? 0;
            if (size > MAX_UPLOAD_BYTES) {
                toast(`Too large — the limit is ${formatBytes(MAX_UPLOAD_BYTES)}`, 'error');
                return;
            }

            // The picker's copy lives in the cache directory, which Android is
            // free to delete under storage pressure. Move it next to our own
            // recordings so a queued import cannot evaporate.
            const stored = moveIntoOutbox(asset.uri, asset.name);
            const entry = await enqueue({
                uri: stored.uri,
                fileName: asset.name,
                mimeType: asset.mimeType || 'audio/mpeg',
                sizeBytes: stored.size || size,
                // An imported file's real duration is only known once the
                // server decodes it; 0 here means the row shows no length
                // rather than a made-up one.
                durationSeconds: 0,
                captureMode: 'upload',
                settings: {
                    title: asset.name.replace(/\.[^.]+$/, ''),
                    language: defaultLanguage(),
                    attendees: '',
                    contextTerms: '',
                    numSpeakers: '',
                },
            });
            setEditing({ id: entry.id, fresh: true });
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setImporting(false);
        }
    }, [enqueue, toast]);

    const handleRequestPermission = useCallback(async () => {
        setRequesting(true);
        try {
            await recorder.requestPermission();
        } finally {
            setRequesting(false);
        }
    }, [recorder]);

    // ── Render ───────────────────────────────────────────────────────

    // While capturing, the tab IS the recorder. No header, no list, nothing
    // else to hit by accident.
    if (recorder.active || recorder.phase === 'preparing') {
        return (
            <Screen edges={['top', 'bottom']}>
                <LiveRecorder
                    recorder={recorder}
                    onStop={() => void handleStop()}
                    onDiscard={() => void handleDiscardLive()}
                    saving={saving || recorder.phase === 'preparing'}
                />
            </Screen>
        );
    }

    const meetings = query.data ?? [];
    const showPermissionCard = !recorder.permission.unknown && !recorder.permission.granted;

    /**
     * The one thing this tab exists to do, pinned above the list.
     *
     * It used to live inside `ListHeaderComponent`, below a banner, a
     * permission card and an import button — so on a phone with a few
     * recordings the flagship capability of the app scrolled off the top of its
     * own tab. The outbox stays directly under it, because an un-uploaded
     * recording is the only thing more urgent than starting a new one: those
     * are the only copies that exist.
     */
    const startBar = (
        <View
            style={{
                paddingHorizontal: theme.spacing.lg,
                paddingBottom: theme.spacing.md,
                gap: theme.spacing.md,
            }}
        >
            {showPermissionCard ? (
                <MicPermissionCard
                    permission={recorder.permission}
                    onRequest={() => void handleRequestPermission()}
                    busy={requesting}
                />
            ) : (
                <>
                    <Button
                        label="Start recording"
                        size="lg"
                        fullWidth
                        onPress={() => void handleStart()}
                        icon={<Feather name="mic" size={20} color={theme.colors.accentPrimaryFg} />}
                        accessibilityHint="Records the room and transcribes it when you stop"
                    />
                    <Text variant="caption" tone="tertiary" center>
                        Records this room, keeps going when the screen locks, and transcribes with
                        speakers once you stop.
                    </Text>
                </>
            )}
        </View>
    );

    const header = (
        <View style={{ gap: theme.spacing.xl, paddingBottom: theme.spacing.lg }}>
            {recorder.error ? (
                <Banner tone="error" action={<Button label="Dismiss" variant="ghost" onPress={recorder.clearError} />}>
                    <Text variant="caption" tone="secondary">
                        {recorder.error}
                    </Text>
                </Banner>
            ) : null}

            <Button
                label="Import an audio file"
                variant="secondary"
                fullWidth
                loading={importing}
                onPress={() => void handleImport()}
                icon={<Feather name="upload" size={16} color={theme.colors.textPrimary} />}
            />

            {items.length > 0 ? (
                <Section
                    title="On this phone"
                    subtitle="Not uploaded yet. These are the only copies."
                >
                    <View style={{ gap: theme.spacing.md }}>
                        {items.map((item) => (
                            <OutboxRow
                                key={item.id}
                                item={item}
                                onUpload={() => void upload(item.id, onAccepted)}
                                onCancel={() => cancelUpload(item.id)}
                                onEdit={() => setEditing({ id: item.id, fresh: false })}
                                onDiscard={() => void discard(item.id)}
                            />
                        ))}
                    </View>
                </Section>
            ) : null}

            {meetings.length > 0 ? (
                <Text variant="label" tone="tertiary">
                    MEETINGS
                </Text>
            ) : null}
        </View>
    );

    return (
        <Screen edges={['top']}>
            <ScreenHeader size="large" title="Record" subtitle="Meetings, transcribed" />

            {startBar}

            {query.isLoading ? (
                <ListSkeleton />
            ) : (
                <FlatList<TranscriptionSummary>
                    data={meetings}
                    keyExtractor={(item) => item.id}
                    ListHeaderComponent={header}
                    contentContainerStyle={{
                        paddingHorizontal: theme.spacing.lg,
                        paddingTop: theme.spacing.sm,
                        paddingBottom: theme.spacing.xxxl,
                    }}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderItem={({ item }) => (
                        <TranscriptionRow
                            item={item}
                            onPress={() => router.push(`/recordings/${item.id}`)}
                        />
                    )}
                    ListEmptyComponent={
                        query.isError ? (
                            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
                        ) : (
                            // Deliberately actionless. The Start button is
                            // pinned above this list and is therefore ON SCREEN
                            // while this renders — an empty state whose action
                            // duplicates a live button four centimetres above it
                            // is not teaching anything, it is asking which of
                            // two identical buttons is the real one.
                            <EmptyState
                                icon="mic"
                                title="No meetings yet"
                                message="Record one in the room with the button above, or import audio you already have. You get a transcript with speakers, a summary and the action items."
                            />
                        )
                    }
                />
            )}

            <Sheet
                visible={Boolean(settingsDraft)}
                onClose={() => setEditing(null)}
                title={editing?.fresh ? 'Before we transcribe' : 'Recording details'}
                subtitle={
                    settingsDraft
                        ? `${settingsDraft.fileName} · ${formatBytes(settingsDraft.sizeBytes) || '—'}`
                        : undefined
                }
                footer={
                    settingsDraft ? (
                        <View style={{ gap: theme.spacing.sm, paddingBottom: theme.spacing.sm }}>
                            <Button
                                label="Transcribe now"
                                fullWidth
                                onPress={() => {
                                    const id = settingsDraft.id;
                                    setEditing(null);
                                    void upload(id, onAccepted);
                                }}
                            />
                            <Button
                                label="Keep on this phone for now"
                                variant="ghost"
                                fullWidth
                                onPress={() => setEditing(null)}
                            />
                        </View>
                    ) : null
                }
            >
                {settingsDraft ? (
                    <CaptureSettingsForm
                        value={settingsDraft.settings}
                        onChange={(patch) => updateSettings(settingsDraft.id, patch)}
                    />
                ) : null}
            </Sheet>
        </Screen>
    );
}

/**
 * Move a picked file out of the cache directory.
 *
 * Returns the ORIGINAL location if the move fails: an import that stays in the
 * cache is a small risk, an import that vanished because we threw mid-move is
 * a lost file. Same trade the recorder makes.
 */
function moveIntoOutbox(uri: string, fileName: string): { uri: string; size: number } {
    const source = new File(uri);
    try {
        const dir = new Directory(Paths.document, RECORDINGS_DIRNAME);
        if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
        // Prefix with a timestamp so importing the same file twice does not
        // silently overwrite the copy still waiting to upload.
        const destination = new File(dir, `${Date.now()}-${fileName}`);
        source.moveSync(destination, { overwrite: true });
        return { uri: destination.uri, size: destination.size };
    } catch {
        return { uri: source.uri, size: source.exists ? source.size : 0 };
    }
}
