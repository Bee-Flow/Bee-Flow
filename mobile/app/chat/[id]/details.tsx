/**
 * Conversation details — everything about a chat that is not the chat.
 *
 * Reached from the title and the overflow button on app/chat/[id].tsx. It is a
 * screen rather than a sheet because there are six independent things here and
 * a bottom sheet that scrolls is a sheet pretending to be a screen.
 *
 * Three server facts shape the whole file:
 *
 *   1. Rename, pin and labels are ONE endpoint. `PATCH /ai/direct/conversations/:id`
 *      reads `{ title, pinned, labels }` and applies whichever keys are present
 *      (routes/ai/directChat/conversationRoutes.js), so each control sends only
 *      its own field and they never fight over each other's values.
 *   2. Moving a chat into a project is NOT part of that PATCH — the route
 *      simply does not read `project_id`, and sending it looks like it worked.
 *      Filing goes through the projects router instead, and taking a chat back
 *      out has its own route that needs no project role, because the assign
 *      route requires `editor` and a user downgraded to viewer could otherwise
 *      never unfile their own chat.
 *   3. Labels are GLOBAL to the user, not to the chat. `labels_json` on the
 *      conversation is a JSON array of label IDs; the labels themselves live
 *      under /ai/labels. Deleting one therefore removes it from every
 *      conversation, which is why that action confirms and the assign action
 *      does not.
 */

import { Feather } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useState } from 'react';
import { Alert, RefreshControl, ScrollView, Share, View } from 'react-native';

import { ApiError } from '../../../src/api/client';
import type { ChatMessage, SessionSkill } from '../../../src/features/chat/types';
import { useChatDetails } from '../../../src/features/chat/useChatDetails';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../../src/ui/Badge';
import { Button, IconButton } from '../../../src/ui/Button';
import { Switch } from '../../../src/ui/Controls';
import {
    Banner,
    describeError,
    EmptyState,
    ErrorState,
    LoadingState,
    Spinner,
} from '../../../src/ui/Feedback';
import { TextField } from '../../../src/ui/Input';
import { ListRow, SettingRow } from '../../../src/ui/List';
import { Screen } from '../../../src/ui/Screen';
import { ScreenHeader } from '../../../src/ui/ScreenHeader';
import { Card, Divider, Section, Spacer } from '../../../src/ui/Surface';
import { Text } from '../../../src/ui/Text';
import { useToast } from '../../../src/ui/Toast';

// ─── Screen ──────────────────────────────────────────────────────────

export default function ChatDetailsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const conversationId = id ?? '';
    const theme = useTheme();
    const router = useRouter();
    // Sharing and exporting happen here, not in the hook: they are the screen
    // reaching for the OS, and they report through the same toast.
    const { toast } = useToast();

    // Every query, mutation and draft this screen has is in the hook; what is
    // left below is the rendering.
    const {
        conversationQuery, labelsQuery, projectsQuery, skillsQuery,
        conversation, title, serverTitle, appliedLabelIds, failure,
        setDraftTitle, newLabel, setNewLabel, editingLabelId, setEditingLabelId,
        patch, saveTitle, addLabel, renameLabel, dropLabel, moveToProject,
        regenerate, dropSkill, destroy,
    } = useChatDetails(conversationId);

    if (!conversationId || conversationId === 'new') {
        return (
            <Screen edges={['top', 'bottom']}>
                <Stack.Screen options={{ headerShown: false }} />
                <Header title="Details" onBack={() => router.back()} />
                <EmptyState
                    icon="message-square"
                    title="Nothing to show yet"
                    message="Send a message first — a chat gets a name, labels and a project once it exists on the server."
                    actionLabel="Back to the chat"
                    onAction={() => router.back()}
                />
            </Screen>
        );
    }

    if (conversationQuery.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                <Stack.Screen options={{ headerShown: false }} />
                <Header title="Details" onBack={() => router.back()} />
                <LoadingState label="Loading this conversation" />
            </Screen>
        );
    }

    if (conversationQuery.isError || !conversation) {
        return (
            <Screen edges={['top', 'bottom']}>
                <Stack.Screen options={{ headerShown: false }} />
                <Header title="Details" onBack={() => router.back()} />
                <ErrorState
                    error={conversationQuery.error}
                    onRetry={() => void conversationQuery.refetch()}
                />
            </Screen>
        );
    }

    const labels = labelsQuery.data ?? [];
    const projects = projectsQuery.data ?? [];
    const currentProject = projects.find((p) => p.id === conversation.project_id) ?? null;
    const messages = conversation.messages ?? [];
    const skills = skillsQuery.data?.skills ?? [];
    const activated = new Set(skillsQuery.data?.activatedSkillIds ?? []);

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <Stack.Screen options={{ headerShown: false }} />
            <Header
                title={conversation.title || 'Untitled chat'}
                onBack={() => router.back()}
                busy={patch.isPending}
            />

            <ScrollView
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.xl,
                }}
                keyboardShouldPersistTaps="handled"
                refreshControl={
                    <RefreshControl
                        refreshing={conversationQuery.isRefetching}
                        onRefresh={() => {
                            void conversationQuery.refetch();
                            void labelsQuery.refetch();
                            void projectsQuery.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                {failure ? (
                    <Banner tone="error">
                        {`${describeError(failure).title}. ${describeError(failure).message}`}
                    </Banner>
                ) : null}

                {/* ── Name ─────────────────────────────────────────── */}
                <Section title="Name">
                    <TextField
                        label="Conversation name"
                        value={title}
                        onChangeText={setDraftTitle}
                        placeholder="Untitled chat"
                        returnKeyType="done"
                        onSubmitEditing={saveTitle}
                        hint="Bee Flow names a chat from its first message; rename it to anything."
                    />
                    <Button
                        label="Save name"
                        onPress={saveTitle}
                        disabled={title.trim() === serverTitle.trim() || patch.isPending}
                        loading={patch.isPending}
                        variant="secondary"
                    />
                </Section>

                {/* ── Pin ──────────────────────────────────────────── */}
                <Card padded={false}>
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: theme.spacing.md,
                            padding: theme.spacing.lg,
                            minHeight: theme.minTouch,
                        }}
                    >
                        <Feather name="bookmark" size={18} color={theme.colors.textSecondary} />
                        <View style={{ flex: 1 }}>
                            <Text variant="body">Pinned</Text>
                            <Text variant="caption" tone="tertiary">
                                Keeps this chat at the top of the list.
                            </Text>
                        </View>
                        <Switch
                            value={Boolean(conversation.pinned)}
                            onValueChange={(next) => patch.mutate({ pinned: next })}
                            disabled={patch.isPending}
                            accessibilityLabel="Pin this conversation"
                        />
                    </View>
                </Card>

                {/* ── Labels ───────────────────────────────────────── */}
                <Section
                    title="Labels"
                    subtitle="Labels are shared across all your chats — deleting one removes it everywhere."
                >
                    {labelsQuery.isLoading ? (
                        <Spinner />
                    ) : labels.length === 0 ? (
                        <Text variant="caption" tone="tertiary">
                            No labels yet. Create the first one below.
                        </Text>
                    ) : (
                        <View
                            style={{
                                flexDirection: 'row',
                                flexWrap: 'wrap',
                                gap: theme.spacing.sm,
                            }}
                        >
                            {labels.map((label) => {
                                const applied = appliedLabelIds.includes(label.id);
                                return (
                                    <Chip
                                        key={label.id}
                                        label={label.name}
                                        selected={applied}
                                        icon={
                                            <View
                                                style={{
                                                    width: 8,
                                                    height: 8,
                                                    borderRadius: 4,
                                                    backgroundColor:
                                                        label.color || theme.colors.accentPrimary,
                                                }}
                                            />
                                        }
                                        onPress={() =>
                                            patch.mutate({
                                                labels: applied
                                                    ? appliedLabelIds.filter((v) => v !== label.id)
                                                    : [...appliedLabelIds, label.id],
                                            })
                                        }
                                    />
                                );
                            })}
                        </View>
                    )}

                    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm }}>
                        <TextField
                            label="New label"
                            value={newLabel}
                            onChangeText={setNewLabel}
                            placeholder="Invoices"
                            returnKeyType="done"
                            containerStyle={{ flex: 1 }}
                            onSubmitEditing={() =>
                                newLabel.trim() && addLabel.mutate(newLabel.trim())
                            }
                        />
                        <Button
                            label="Add"
                            variant="secondary"
                            onPress={() => addLabel.mutate(newLabel.trim())}
                            disabled={!newLabel.trim() || addLabel.isPending}
                            loading={addLabel.isPending}
                        />
                    </View>

                    {labels.length > 0 ? (
                        <Card padded={false}>
                            {labels.map((label, index) => (
                                <View key={`manage-${label.id}`}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    {editingLabelId === label.id ? (
                                        <LabelRenameRow
                                            initial={label.name}
                                            busy={renameLabel.isPending}
                                            onCancel={() => setEditingLabelId(null)}
                                            onSave={(name) =>
                                                renameLabel.mutate({ labelId: label.id, name })
                                            }
                                        />
                                    ) : (
                                        <ListRow
                                            title={label.name}
                                            subtitle={
                                                appliedLabelIds.includes(label.id)
                                                    ? 'On this chat'
                                                    : undefined
                                            }
                                            onPress={() => setEditingLabelId(label.id)}
                                            chevron={false}
                                            trailing={
                                                <IconButton
                                                    icon={
                                                        <Feather
                                                            name="trash-2"
                                                            size={16}
                                                            color={theme.colors.error}
                                                        />
                                                    }
                                                    tone="destructive"
                                                    accessibilityLabel={`Delete the label ${label.name}`}
                                                    onPress={() =>
                                                        confirmDestructive(
                                                            `Delete “${label.name}”?`,
                                                            'It will be removed from every conversation that uses it. This cannot be undone.',
                                                            () => dropLabel.mutate(label.id),
                                                        )
                                                    }
                                                />
                                            }
                                        />
                                    )}
                                </View>
                            ))}
                        </Card>
                    ) : null}
                </Section>

                {/* ── Project ──────────────────────────────────────── */}
                <Section
                    title="Project"
                    subtitle="Filing a chat into a project shares it with the project's members."
                >
                    {projectsQuery.isError ? (
                        // Projects are licence-gated at the mount point, so a
                        // 402/403 here is an answer about the plan, not a bug.
                        <Text variant="caption" tone="tertiary">
                            {describeError(projectsQuery.error).message}
                        </Text>
                    ) : projects.length === 0 ? (
                        <Text variant="caption" tone="tertiary">
                            You are not a member of any project yet.
                        </Text>
                    ) : (
                        <Card padded={false}>
                            <SettingRow
                                label="No project"
                                value={currentProject ? undefined : 'Current'}
                                icon={
                                    <Feather
                                        name="minus-circle"
                                        size={18}
                                        color={theme.colors.textMuted}
                                    />
                                }
                                disabled={!currentProject || moveToProject.isPending}
                                onPress={() => moveToProject.mutate(null)}
                            />
                            {projects.map((project) => (
                                <View key={project.id}>
                                    <Divider inset={theme.spacing.lg} />
                                    <SettingRow
                                        label={project.name}
                                        value={
                                            project.id === conversation.project_id
                                                ? 'Current'
                                                : undefined
                                        }
                                        icon={
                                            <View
                                                style={{
                                                    width: 18,
                                                    height: 18,
                                                    borderRadius: theme.radii.sm,
                                                    backgroundColor:
                                                        project.color || theme.colors.bgTertiary,
                                                }}
                                            />
                                        }
                                        disabled={
                                            project.id === conversation.project_id ||
                                            moveToProject.isPending
                                        }
                                        onPress={() => moveToProject.mutate(project.id)}
                                    />
                                </View>
                            ))}
                        </Card>
                    )}
                </Section>

                {/* ── Session skills ───────────────────────────────── */}
                <SessionSkillsSection
                    skills={skills}
                    activated={activated}
                    loading={skillsQuery.isLoading}
                    error={skillsQuery.error}
                    regenerating={regenerate.isPending}
                    onRegenerate={() => regenerate.mutate()}
                    onDelete={(skill) =>
                        confirmDestructive(
                            `Remove “${skill.name}”?`,
                            'The step is dropped from this conversation only.',
                            () => dropSkill.mutate(skill.id),
                        )
                    }
                />

                {/* ── Transcript ───────────────────────────────────── */}
                <Section
                    title="Transcript"
                    subtitle={`${messages.length} message${messages.length === 1 ? '' : 's'} in this conversation.`}
                >
                    <Button
                        label="Share transcript"
                        variant="secondary"
                        icon={<Feather name="share-2" size={16} color={theme.colors.textPrimary} />}
                        disabled={messages.length === 0}
                        onPress={() => {
                            void Share.share({
                                title: conversation.title || 'Bee Flow conversation',
                                message: transcriptMarkdown(conversation.title, messages),
                            }).catch(() => toast('Sharing was cancelled'));
                        }}
                    />
                    <Button
                        label="Export as Markdown"
                        variant="secondary"
                        icon={<Feather name="download" size={16} color={theme.colors.textPrimary} />}
                        disabled={messages.length === 0}
                        onPress={() => {
                            void exportTranscript(conversation.title, messages).catch((err) =>
                                toast(describeError(err).message, 'error'),
                            );
                        }}
                    />
                    <Text variant="caption" tone="tertiary">
                        The file is written to this phone&apos;s cache and handed to the Android
                        share sheet. Nothing is uploaded.
                    </Text>
                </Section>

                <Spacer />
                <Divider />

                {/* ── Delete ───────────────────────────────────────── */}
                <Section title="Danger zone">
                    <Text variant="caption" tone="tertiary">
                        Deleting removes the conversation and every message in it from your server.
                        This cannot be undone.
                    </Text>
                    <Button
                        label="Delete conversation"
                        variant="destructive"
                        loading={destroy.isPending}
                        onPress={() =>
                            confirmDestructive(
                                'Delete this conversation?',
                                `“${conversation.title || 'Untitled chat'}” and all ${messages.length} of its messages will be permanently removed from your server.`,
                                () => destroy.mutate(),
                            )
                        }
                    />
                </Section>
            </ScrollView>
        </Screen>
    );
}

// ─── Pieces ──────────────────────────────────────────────────────────

function Header({
    title,
    onBack,
    busy = false,
}: {
    title: string;
    onBack: () => void;
    busy?: boolean;
}) {
    return (
        <ScreenHeader
            title={title}
            actions={
                <>
                    {busy ? <Spinner /> : null}
                </>
            }
        />
    );
}

function LabelRenameRow({
    initial,
    busy,
    onSave,
    onCancel,
}: {
    initial: string;
    busy: boolean;
    onSave: (name: string) => void;
    onCancel: () => void;
}) {
    const theme = useTheme();
    const [value, setValue] = useState(initial);
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                gap: theme.spacing.sm,
                padding: theme.spacing.lg,
            }}
        >
            <TextField
                label="Rename label"
                value={value}
                onChangeText={setValue}
                autoFocus
                returnKeyType="done"
                containerStyle={{ flex: 1 }}
                onSubmitEditing={() => value.trim() && onSave(value.trim())}
            />
            <Button
                label="Save"
                variant="secondary"
                onPress={() => onSave(value.trim())}
                disabled={!value.trim() || busy}
                loading={busy}
            />
            <IconButton
                icon={<Feather name="x" size={18} color={theme.colors.textMuted} />}
                accessibilityLabel="Cancel renaming"
                onPress={onCancel}
            />
        </View>
    );
}

/**
 * Chat-local skills.
 *
 * The endpoint only answers usefully for a Standard-tier conversation, and
 * regeneration 400s with "Standard tier is not configured." on an install that
 * has not set one up. Neither is a broken screen, so a 404/400 collapses the
 * section to a single sentence instead of an error state.
 */
function SessionSkillsSection({
    skills,
    activated,
    loading,
    error,
    regenerating,
    onRegenerate,
    onDelete,
}: {
    skills: SessionSkill[];
    activated: ReadonlySet<string>;
    loading: boolean;
    error: unknown;
    regenerating: boolean;
    onRegenerate: () => void;
    onDelete: (skill: SessionSkill) => void;
}) {
    const theme = useTheme();

    // A 404 means this conversation has no session-skill surface at all; a 403
    // means the tier is not on this plan. Both are "nothing to see", not
    // "something went wrong".
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;

    if (loading) {
        return (
            <Section title="Session skills">
                <Spinner />
            </Section>
        );
    }

    if (error) {
        return (
            <Section title="Session skills">
                <Text variant="caption" tone="tertiary">
                    {describeError(error).message}
                </Text>
            </Section>
        );
    }

    return (
        <Section
            title="Session skills"
            subtitle="The steps Bee Flow planned for this conversation. They live in this chat only."
        >
            {skills.length === 0 ? (
                <Text variant="caption" tone="tertiary">
                    This conversation has no planned steps.
                </Text>
            ) : (
                <Card padded={false}>
                    {skills.map((skill, index) => (
                        <View key={skill.id}>
                            {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                            <ListRow
                                title={skill.name}
                                subtitle={skill.description}
                                wrapTitle
                                chevron={false}
                                leading={
                                    <Text variant="label" tone="tertiary">
                                        {index + 1}
                                    </Text>
                                }
                                trailing={
                                    <View
                                        style={{
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            gap: theme.spacing.sm,
                                        }}
                                    >
                                        {activated.has(skill.id) ? (
                                            <Badge label="Active" tone="accent" />
                                        ) : null}
                                        <IconButton
                                            icon={
                                                <Feather
                                                    name="trash-2"
                                                    size={16}
                                                    color={theme.colors.error}
                                                />
                                            }
                                            tone="destructive"
                                            accessibilityLabel={`Remove the step ${skill.name}`}
                                            onPress={() => onDelete(skill)}
                                        />
                                    </View>
                                }
                            />
                        </View>
                    ))}
                </Card>
            )}
            <Button
                label="Re-plan the steps"
                variant="secondary"
                loading={regenerating}
                disabled={regenerating}
                onPress={onRegenerate}
            />
        </Section>
    );
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * A native confirm for anything irreversible.
 *
 * `Alert` rather than a custom sheet: it is the dialog Android users already
 * recognise as "this is serious", it is announced correctly by TalkBack, and
 * it cannot be dismissed by an accidental tap outside.
 */
function confirmDestructive(title: string, message: string, onConfirm: () => void): void {
    Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onConfirm },
    ]);
}

/**
 * The transcript, as Markdown.
 *
 * Tool and system turns are dropped: they are internal machinery and a person
 * sharing a conversation means the conversation. `thinking` is dropped for the
 * same reason — it is the model's scratchpad, not the answer, and it is not
 * what someone intends to forward to a colleague.
 */
function transcriptMarkdown(title: string | null | undefined, messages: ChatMessage[]): string {
    const header = `# ${title || 'Bee Flow conversation'}\n\n`;
    const body = messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => {
            const who = message.role === 'user' ? 'You' : 'Bee Flow';
            const when = message.createdAt
                ? ` · ${new Date(message.createdAt).toLocaleString()}`
                : '';
            const attachments = message.attachments?.length
                ? `\n\n_Attachments: ${message.attachments.map((a) => a.name).join(', ')}_`
                : '';
            return `## ${who}${when}\n\n${message.content}${attachments}`;
        })
        .join('\n\n');
    return `${header}${body}\n`;
}

/** Strip anything Android's file layer would object to. */
function safeFileName(name: string): string {
    const cleaned = name.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
    return (cleaned.length ? cleaned.slice(0, 80) : 'conversation') + '.md';
}

/**
 * Write the transcript to the cache and hand it to the share sheet.
 *
 * Deliberately a real file rather than a clipboard blob, so it can land in
 * Drive, an email or a Files app like anything else. The cache directory is
 * reclaimed by the OS when it needs the space, so nothing accumulates.
 */
async function exportTranscript(
    title: string | null | undefined,
    messages: ChatMessage[],
): Promise<void> {
    const name = safeFileName(title || 'Bee Flow conversation');
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create({ overwrite: true, intermediates: true });
    file.write(transcriptMarkdown(title, messages));

    if (!(await Sharing.isAvailableAsync())) {
        throw new Error('This phone has nothing that can receive a shared file.');
    }
    await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', dialogTitle: name });
}
