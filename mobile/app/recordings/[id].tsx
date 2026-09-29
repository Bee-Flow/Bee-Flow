/**
 * One meeting: the transcript, the notes, and everything you can do to them.
 *
 * The screen has to be right in three quite different states, and treating any
 * of them as an afterthought makes the feature untrustworthy:
 *
 *   - PROCESSING. The upload route answers 202 and finishes the pipeline in
 *     the background, so a note is openable for minutes before it has any
 *     content. That state gets a real explanation and a poll, not a spinner.
 *   - FAILED. The pipeline stashes its reason in `summary` (a failed note has
 *     no other use for the field), which is the ONLY place the client ever
 *     learns why — the 202 was sent long before anything went wrong. So the
 *     reason is shown, and Retry re-runs from the saved audio.
 *   - COMPLETED. Summary, action items, decisions, open questions, chapters,
 *     speakers and the transcript itself.
 *
 * The transcript is the FlatList's data rather than content inside a
 * ScrollView: an hour-long meeting is a few thousand turns, and everything
 * above it rides along as the list header.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Directory, File, Paths } from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, RefreshControl, View } from 'react-native';

import { Markdown } from '../../src/features/chat/Markdown';
import {
    PROCESSING_POLL_MS,
    deleteTranscription,
    describeRegenerateOutcome,
    errorCode,
    exportTranscription,
    getTranscription,
    listSummaryTemplates,
    recordingKeys,
    regenerateSummary,
    reidentifySpeakers,
    renameTranscription,
    reprocessTranscription,
    setActionItems,
    updateSpeakers,
    type SummaryTemplate,
} from '../../src/features/recording/api';
import { MeetingChatSheetBody } from '../../src/features/recording/components/MeetingChatSheet';
import {
    SpeakerEditorSheetBody,
    type SpeakerEdit,
} from '../../src/features/recording/components/SpeakerEditorSheet';
import { TranscriptTurn } from '../../src/features/recording/components/TranscriptTurn';
import { buildSpeakerColors, formatDuration, formatWhen } from '../../src/features/recording/format';
import type { ActionItem, Transcription, TranscriptSegment } from '../../src/features/recording/types';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { Banner, ErrorState, LoadingState, describeError } from '../../src/ui/Feedback';
import { TextField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

type OpenSheet = 'none' | 'actions' | 'rename' | 'speakers' | 'regenerate' | 'ask';

export default function MeetingDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [sheet, setSheet] = useState<OpenSheet>('none');
    const [titleDraft, setTitleDraft] = useState('');
    const [speakerError, setSpeakerError] = useState<string | null>(null);

    const query = useQuery({
        queryKey: recordingKeys.detail(id ?? ''),
        queryFn: ({ signal }) => getTranscription(id as string, signal),
        enabled: Boolean(id),
        // Same reasoning as the list: 'processing' resolves in the background
        // and there is nothing to stream, so it is polled — and only then.
        refetchInterval: (q) => (q.state.data?.status === 'processing' ? PROCESSING_POLL_MS : false),
    });

    const meeting = query.data ?? null;

    /** Every write invalidates the list too — the row's status and title live there. */
    const refreshBoth = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: recordingKeys.detail(id ?? '') });
        void queryClient.invalidateQueries({ queryKey: recordingKeys.list });
    }, [queryClient, id]);

    /** The speaker routes answer with the whole note, so seed the cache with it. */
    const acceptUpdatedNote = useCallback(
        (updated: Transcription | null) => {
            if (updated) queryClient.setQueryData(recordingKeys.detail(id ?? ''), updated);
            void queryClient.invalidateQueries({ queryKey: recordingKeys.list });
        },
        [queryClient, id],
    );

    const rename = useMutation({
        mutationFn: (title: string) => renameTranscription(id as string, title),
        onSuccess: () => {
            setSheet('none');
            refreshBoth();
            toast('Renamed', 'success');
        },
        onError: (err) => toast(describeError(err).message, 'error'),
    });

    const regenerate = useMutation({
        mutationFn: (choice: { template?: string; templateId?: string }) =>
            regenerateSummary(id as string, choice),
        // Niet onvoorwaardelijk groen. De server antwoordt 200 óók als het
        // uitwerken van de actiepunten, besluiten en vragen is omgevallen —
        // hij bewaart de oude lijsten en zegt dat in `artifactsRegenerated`.
        // Dat veld is het ENIGE kanaal: de samenvatting is dan wél vernieuwd,
        // dus aan het scherm is niets te zien. describeRegenerateOutcome is
        // dezelfde regel als in de webclient, puur en apart getest.
        onSuccess: (res) => {
            setSheet('none');
            refreshBoth();
            const outcome = describeRegenerateOutcome(res);
            toast(outcome.message, outcome.kind === 'success' ? 'success' : 'neutral');
        },
        onError: (err) => toast(describeError(err).message, 'error'),
    });

    const editSpeakers = useMutation({
        mutationFn: (edit: SpeakerEdit) => updateSpeakers(id as string, edit),
        onSuccess: (updated) => {
            setSpeakerError(null);
            setSheet('none');
            acceptUpdatedNote(updated);
            toast('Speakers updated', 'success');
        },
        // The collision message is written for a human and names both
        // speakers — showing it verbatim beats any paraphrase.
        onError: (err) => setSpeakerError(describeError(err).message),
    });

    const reidentify = useMutation({
        mutationFn: (roster: string) => reidentifySpeakers(id as string, roster),
        onSuccess: (updated) => {
            setSpeakerError(null);
            acceptUpdatedNote(updated);
            toast('Speakers re-identified', 'success');
        },
        onError: (err) => setSpeakerError(describeError(err).message),
    });

    const retry = useMutation({
        mutationFn: () => reprocessTranscription(id as string),
        onSuccess: () => {
            refreshBoth();
            toast('Transcribing again', 'success');
        },
        onError: (err) => {
            // Each code means something different to the person holding the
            // phone, and only one of them is worth trying again.
            const code = errorCode(err);
            const message =
                code === 'already_processing'
                    ? 'It is already being transcribed. Give it a moment.'
                    : code === 'audio_gone_recorded'
                      ? 'The audio is gone and there was never another copy. The transcript below is what remains.'
                      : code === 'audio_gone_uploaded'
                        ? 'The saved audio is gone. Import the original file again to re-transcribe it.'
                        : code === 'audio_storage_unavailable'
                          ? 'Audio storage is briefly unavailable. Try again in a minute.'
                          : describeError(err).message;
            Alert.alert('Cannot re-transcribe', message);
            if (code === 'already_processing') refreshBoth();
        },
    });

    const remove = useMutation({
        mutationFn: () => deleteTranscription(id as string),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: recordingKeys.list });
            router.back();
        },
        onError: (err) => toast(describeError(err).message, 'error'),
    });

    const toggleActionItem = useMutation({
        mutationFn: (items: ActionItem[]) => setActionItems(id as string, items),
        onSuccess: refreshBoth,
        onError: (err) => toast(describeError(err).message, 'error'),
    });

    const templates = useQuery({
        queryKey: recordingKeys.templates,
        queryFn: ({ signal }) => listSummaryTemplates(signal),
        enabled: sheet === 'regenerate',
        staleTime: 5 * 60_000,
    });

    const share = useCallback(async () => {
        if (!meeting) return;
        try {
            const markdown = await exportTranscription(meeting.id, 'md');
            if (!markdown) {
                toast('Nothing to export yet', 'error');
                return;
            }
            // Share a FILE, not a message: a full transcript pasted into a
            // share sheet is truncated by half the apps that receive it.
            const safeName = (meeting.title || 'Meeting').replace(/[^\p{L}\p{N} _-]/gu, '').trim();
            const dir = new Directory(Paths.cache, 'exports');
            if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
            const file = new File(dir, `${safeName || 'Meeting'}.md`);
            if (file.exists) file.delete();
            file.create();
            file.write(markdown);

            if (await Sharing.isAvailableAsync()) {
                await Sharing.shareAsync(file.uri, {
                    mimeType: 'text/markdown',
                    dialogTitle: meeting.title,
                    UTI: 'net.daringfireball.markdown',
                });
            } else {
                await Clipboard.setStringAsync(markdown);
                toast('Copied the notes to the clipboard', 'success');
            }
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    }, [meeting, toast]);

    const colours = useMemo(
        () => (meeting ? buildSpeakerColors(meeting.speakers) : {}),
        [meeting],
    );

    // ── Frame ────────────────────────────────────────────────────────

    const header = (
        <ScreenHeader
            title={meeting?.title || 'Meeting'}
            subtitle={
                meeting
                    ? [formatWhen(meeting.createdAt), formatDuration(meeting.durationSeconds)]
                          .filter(Boolean)
                          .join(' · ')
                    : undefined
            }
            actions={
                <>
                    {meeting?.status === 'completed' ? (
                        <IconButton
                            icon={<Feather name="message-circle" size={20} color={theme.colors.textSecondary} />}
                            accessibilityLabel="Ask about this meeting"
                            onPress={() => setSheet('ask')}
                        />
                    ) : null}
                    <IconButton
                        icon={<Feather name="more-vertical" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel="More actions"
                        onPress={() => setSheet('actions')}
                        disabled={!meeting}
                    />
                </>
            }
        />
    );

    if (query.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                {header}
                <LoadingState label="Opening the meeting" />
            </Screen>
        );
    }

    if (query.isError || !meeting) {
        return (
            <Screen edges={['top', 'bottom']}>
                {header}
                <ErrorState
                    error={query.error ?? new Error('This meeting no longer exists.')}
                    onRetry={() => void query.refetch()}
                />
            </Screen>
        );
    }

    const segments: TranscriptSegment[] = meeting.segments ?? [];

    return (
        <Screen edges={['top', 'bottom']}>
            {header}

            <FlatList<TranscriptSegment>
                data={segments}
                keyExtractor={(segment, index) => `${index}-${segment.start}`}
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
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
                ListHeaderComponent={
                    <MeetingHeader
                        meeting={meeting}
                        retrying={retry.isPending}
                        onRetry={() => retry.mutate()}
                        onEditSpeakers={() => setSheet('speakers')}
                        onRegenerate={() => setSheet('regenerate')}
                        onToggleActionItem={(index) => {
                            const next = meeting.actionItems.map((item, i) =>
                                i === index ? { ...item, done: !item.done } : item,
                            );
                            toggleActionItem.mutate(next);
                        }}
                    />
                }
                renderItem={({ item, index }) => (
                    <TranscriptTurn
                        segment={item}
                        colour={colours[item.speaker] ?? theme.colors.textMuted}
                        continued={index > 0 && segments[index - 1]?.speaker === item.speaker}
                    />
                )}
                ListEmptyComponent={null}
            />

            {/* ── Actions ────────────────────────────────────────────── */}
            <Sheet
                visible={sheet === 'actions'}
                onClose={() => setSheet('none')}
                title={meeting.title || 'Meeting'}
                scroll={false}
            >
                <View style={{ paddingBottom: theme.spacing.md }}>
                    {meeting.isOwner ? (
                        <ListRow
                            title="Rename"
                            leading={<Feather name="edit-2" size={18} color={theme.colors.textSecondary} />}
                            onPress={() => {
                                setTitleDraft(meeting.title || '');
                                setSheet('rename');
                            }}
                        />
                    ) : null}
                    <ListRow
                        title="Share notes"
                        subtitle="Markdown with the summary, action items and transcript"
                        leading={<Feather name="share-2" size={18} color={theme.colors.textSecondary} />}
                        onPress={() => {
                            setSheet('none');
                            void share();
                        }}
                    />
                    <ListRow
                        title="Copy transcript"
                        leading={<Feather name="copy" size={18} color={theme.colors.textSecondary} />}
                        onPress={() => {
                            void Clipboard.setStringAsync(meeting.transcript || meeting.fullText);
                            setSheet('none');
                            toast('Transcript copied', 'success');
                        }}
                    />
                    {meeting.isOwner ? (
                        <>
                            <Divider />
                            <ListRow
                                title="Re-transcribe from the audio"
                                subtitle="Runs the whole pipeline again on the saved recording"
                                leading={
                                    <Feather name="refresh-cw" size={18} color={theme.colors.textSecondary} />
                                }
                                onPress={() => {
                                    setSheet('none');
                                    retry.mutate();
                                }}
                            />
                            <ListRow
                                title="Delete meeting"
                                leading={<Feather name="trash-2" size={18} color={theme.colors.error} />}
                                onPress={() => {
                                    setSheet('none');
                                    Alert.alert(
                                        'Delete this meeting?',
                                        'The transcript, the notes and the saved audio are all removed. This cannot be undone.',
                                        [
                                            { text: 'Cancel', style: 'cancel' },
                                            {
                                                text: 'Delete',
                                                style: 'destructive',
                                                onPress: () => remove.mutate(),
                                            },
                                        ],
                                    );
                                }}
                            />
                        </>
                    ) : null}
                </View>
            </Sheet>

            {/* ── Rename ─────────────────────────────────────────────── */}
            <Sheet
                visible={sheet === 'rename'}
                onClose={() => setSheet('none')}
                title="Rename meeting"
                footer={
                    <View style={{ paddingBottom: theme.spacing.sm }}>
                        <Button
                            label="Save"
                            fullWidth
                            loading={rename.isPending}
                            disabled={!titleDraft.trim()}
                            onPress={() => rename.mutate(titleDraft.trim())}
                        />
                    </View>
                }
            >
                <TextField
                    label="Title"
                    value={titleDraft}
                    onChangeText={setTitleDraft}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={() => titleDraft.trim() && rename.mutate(titleDraft.trim())}
                />
            </Sheet>

            {/* ── Speakers ───────────────────────────────────────────── */}
            <Sheet
                visible={sheet === 'speakers'}
                onClose={() => {
                    setSpeakerError(null);
                    setSheet('none');
                }}
                title="Speakers"
                subtitle="Fix a name once and it stays fixed, even if this meeting is processed again."
            >
                <SpeakerEditorSheetBody
                    speakers={meeting.speakers}
                    attendees={meeting.attendees}
                    saving={editSpeakers.isPending}
                    reidentifying={reidentify.isPending}
                    error={speakerError}
                    onSave={(edit) => editSpeakers.mutate(edit)}
                    onReidentify={(roster) => reidentify.mutate(roster)}
                />
            </Sheet>

            {/* ── Regenerate ─────────────────────────────────────────── */}
            <Sheet
                visible={sheet === 'regenerate'}
                onClose={() => setSheet('none')}
                title="Rewrite the summary"
                subtitle="Uses the transcript that is already here — no audio, no re-transcribing."
            >
                {regenerate.isPending ? (
                    <LoadingState label="Rewriting the notes. This takes a moment on a long meeting." />
                ) : (
                    <View style={{ gap: theme.spacing.md }}>
                        {(templates.data?.custom ?? []).length > 0 ? (
                            <Section title="Your templates">
                                <View style={{ gap: theme.spacing.sm }}>
                                    {(templates.data?.custom ?? []).map((template: SummaryTemplate) => (
                                        <Button
                                            key={template.id}
                                            label={template.name}
                                            variant="secondary"
                                            fullWidth
                                            onPress={() => regenerate.mutate({ templateId: template.id })}
                                        />
                                    ))}
                                </View>
                            </Section>
                        ) : null}
                        <Section title="Built in">
                            <View style={{ gap: theme.spacing.sm }}>
                                {(templates.data?.builtins ?? []).map((template: SummaryTemplate) => (
                                    <Button
                                        key={template.id}
                                        label={template.name}
                                        variant="secondary"
                                        fullWidth
                                        onPress={() => regenerate.mutate({ template: template.id })}
                                    />
                                ))}
                                {templates.isLoading ? <LoadingState /> : null}
                                {templates.isError ? (
                                    <Button
                                        label="General meeting"
                                        variant="secondary"
                                        fullWidth
                                        onPress={() => regenerate.mutate({ template: 'general' })}
                                    />
                                ) : null}
                            </View>
                        </Section>
                    </View>
                )}
            </Sheet>

            {/* ── Ask ────────────────────────────────────────────────── */}
            <Sheet
                visible={sheet === 'ask'}
                onClose={() => setSheet('none')}
                title="Ask about this meeting"
                scroll={false}
            >
                <View style={{ paddingHorizontal: theme.spacing.lg }}>
                    <MeetingChatSheetBody meeting={meeting} />
                </View>
            </Sheet>
        </Screen>
    );
}

/**
 * Everything above the transcript.
 *
 * A separate component purely so the FlatList header does not re-render on
 * every scroll frame along with the rest of this file's state.
 */
function MeetingHeader({
    meeting,
    retrying,
    onRetry,
    onEditSpeakers,
    onRegenerate,
    onToggleActionItem,
}: {
    meeting: Transcription;
    retrying: boolean;
    onRetry: () => void;
    onEditSpeakers: () => void;
    onRegenerate: () => void;
    onToggleActionItem: (index: number) => void;
}) {
    const theme = useTheme();
    const colours = useMemo(() => buildSpeakerColors(meeting.speakers), [meeting.speakers]);

    if (meeting.status === 'processing') {
        return (
            <View style={{ gap: theme.spacing.lg, paddingVertical: theme.spacing.lg }}>
                <Card>
                    <View style={{ gap: theme.spacing.sm }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                            <Feather name="loader" size={18} color={theme.colors.accentPrimary} />
                            <Text variant="subheading">Working on it</Text>
                        </View>
                        <Text variant="body" tone="secondary">
                            The audio is safely on the server. It is being transcribed, split by
                            speaker and summarised — a few minutes for a short meeting, longer for a
                            long one.
                        </Text>
                        <Text variant="caption" tone="tertiary">
                            You can leave this screen. The Record tab shows when it is ready.
                        </Text>
                    </View>
                </Card>
            </View>
        );
    }

    if (meeting.status === 'failed') {
        // The pipeline writes its reason into `summary` because the 202 was
        // sent long before it failed — this is the only channel it has.
        const reason = meeting.summary?.replace(/^Transcription failed:\s*/i, '').trim();
        return (
            <View style={{ gap: theme.spacing.lg, paddingVertical: theme.spacing.lg }}>
                <Card>
                    <View style={{ gap: theme.spacing.md }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                            <Feather name="alert-triangle" size={18} color={theme.colors.error} />
                            <Text variant="subheading">Transcription failed</Text>
                        </View>
                        {reason ? (
                            <Text variant="body" tone="secondary">
                                {reason}
                            </Text>
                        ) : null}
                        {meeting.audio.available ? (
                            <Text variant="caption" tone="tertiary">
                                The recording itself is still saved, so this can be run again.
                            </Text>
                        ) : (
                            <Text variant="caption" tone="warning">
                                {meeting.audio.capture === 'recording'
                                    ? 'The audio is no longer available and there was never another copy.'
                                    : 'The saved audio is no longer available. Import the original file again.'}
                            </Text>
                        )}
                        {meeting.isOwner && meeting.audio.available ? (
                            <Button label="Try again" loading={retrying} onPress={onRetry} fullWidth />
                        ) : null}
                    </View>
                </Card>
            </View>
        );
    }

    const openQuestions = meeting.questions.filter((q) => q.open !== false);

    return (
        <View style={{ gap: theme.spacing.xl, paddingVertical: theme.spacing.lg }}>
            {/* An honest word about the audio, but only when there is something
                worth saying — a note whose recording is durably backed up does
                not need to talk about storage. */}
            {meeting.audio.localOnly ? (
                <Banner tone="warning" icon="hard-drive">
                    <Text variant="caption" tone="secondary">
                        The recording has no backup copy on the server yet. The transcript and notes
                        below are safe either way.
                    </Text>
                </Banner>
            ) : null}

            <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                {meeting.speakers.map((speaker) => (
                    <Chip
                        key={speaker.id}
                        label={
                            meeting.perPersonInsights && speaker.speakingTime
                                ? `${speaker.id} · ${speaker.speakingTime}`
                                : speaker.id
                        }
                        onPress={meeting.isOwner ? onEditSpeakers : undefined}
                        icon={
                            <View
                                style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: 4,
                                    backgroundColor: colours[speaker.id] ?? theme.colors.textMuted,
                                }}
                            />
                        }
                    />
                ))}
                {meeting.isOwner ? (
                    <Chip
                        label="Edit speakers"
                        onPress={onEditSpeakers}
                        icon={<Feather name="edit-2" size={12} color={theme.colors.textSecondary} />}
                    />
                ) : null}
            </View>

            {meeting.summary ? (
                <Section
                    title="Summary"
                    action={
                        meeting.isOwner ? (
                            <Button label="Rewrite" variant="ghost" onPress={onRegenerate} />
                        ) : undefined
                    }
                >
                    <Card>
                        <Markdown value={meeting.summary} />
                    </Card>
                </Section>
            ) : null}

            {meeting.actionItems.length > 0 ? (
                <Section title="Action items">
                    <Card padded={false}>
                        {meeting.actionItems.map((item, index) => (
                            <ListRow
                                key={`${index}-${item.text}`}
                                title={item.text}
                                wrapTitle
                                subtitle={[item.assignee, item.due, item.timestamp]
                                    .filter(Boolean)
                                    .join(' · ')}
                                onPress={meeting.isOwner ? () => onToggleActionItem(index) : undefined}
                                chevron={false}
                                leading={
                                    <Feather
                                        name={item.done ? 'check-square' : 'square'}
                                        size={18}
                                        color={item.done ? theme.colors.success : theme.colors.textMuted}
                                    />
                                }
                            />
                        ))}
                    </Card>
                </Section>
            ) : null}

            {meeting.decisions.length > 0 ? (
                <Section title="Decisions">
                    <Card>
                        <View style={{ gap: theme.spacing.md }}>
                            {meeting.decisions.map((decision, index) => (
                                <View
                                    key={`${index}-${decision.text}`}
                                    style={{ flexDirection: 'row', gap: theme.spacing.sm }}
                                >
                                    <Feather
                                        name="check-circle"
                                        size={14}
                                        color={theme.colors.success}
                                        style={{ marginTop: 4 }}
                                    />
                                    <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                                        {decision.text}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    </Card>
                </Section>
            ) : null}

            {openQuestions.length > 0 ? (
                <Section title="Still open">
                    <Card>
                        <View style={{ gap: theme.spacing.md }}>
                            {openQuestions.map((question, index) => (
                                <View
                                    key={`${index}-${question.text}`}
                                    style={{ flexDirection: 'row', gap: theme.spacing.sm }}
                                >
                                    <Feather
                                        name="help-circle"
                                        size={14}
                                        color={theme.colors.warning}
                                        style={{ marginTop: 4 }}
                                    />
                                    <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                                        {question.text}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    </Card>
                </Section>
            ) : null}

            {meeting.chapters.length > 0 ? (
                <Section title="Chapters">
                    <View style={{ gap: theme.spacing.sm }}>
                        {meeting.chapters.map((chapter, index) => (
                            <View
                                key={`${index}-${chapter.start}`}
                                style={{ flexDirection: 'row', gap: theme.spacing.md }}
                            >
                                <Text
                                    variant="label"
                                    tone="tertiary"
                                    style={{ width: 64, fontVariant: ['tabular-nums'] }}
                                >
                                    {chapter.start}
                                </Text>
                                <View style={{ flex: 1, gap: 2 }}>
                                    <Text variant="body">{chapter.title}</Text>
                                    {chapter.summary ? (
                                        <Text variant="caption" tone="tertiary">
                                            {chapter.summary}
                                        </Text>
                                    ) : null}
                                </View>
                            </View>
                        ))}
                    </View>
                </Section>
            ) : null}

            {meeting.tags.length > 0 ? (
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                    {meeting.tags.map((tag) => (
                        <Badge key={tag} label={tag} />
                    ))}
                </View>
            ) : null}

            {meeting.segments.length > 0 ? (
                <Text variant="label" tone="tertiary">
                    TRANSCRIPT
                </Text>
            ) : null}
        </View>
    );
}
