/**
 * Templates.
 *
 * A template is a Word document with `{{placeholders}}` in it. The server
 * extracts them on upload (mammoth → extractParameters in routes/templates.js)
 * and the chat runtime's whole job is to fill them in from what you tell it,
 * from an attached file, or from the knowledge base the upload auto-created.
 *
 * So the primary action here is "start a chat", not "download". Downloading
 * the blank .docx is available and quiet; filling it in is the reason the
 * feature exists.
 *
 * The entire router is behind requireBetaFeature('templates'), which means a
 * 403 on the list is the expected answer for most organisations. That is an
 * explanation, not an error — a red banner with a Retry button that can never
 * succeed would be actively misleading.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { deleteTemplate, isUnavailable, libraryKeys, listTemplates } from '../../src/features/library/api';
import { LibraryChat } from '../../src/features/library/components/LibraryChat';
import { UploadQueue } from '../../src/features/library/components/UploadQueue';
import { pickDocuments } from '../../src/features/library/pickers';
import { shareServerFile } from '../../src/features/library/share';
import type { Template } from '../../src/features/library/types';
import { templateUploadTarget } from '../../src/features/library/upload';
import { useUploadQueue } from '../../src/features/library/useUploadQueue';
import { plural } from '../../src/lib/format';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { EmptyState, ErrorState, ListSkeleton, describeError } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet, Sheet } from '../../src/ui/Sheet';
import { Divider } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export default function TemplatesScreen() {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [search, setSearch] = useState('');
    const [detailOf, setDetailOf] = useState<Template | null>(null);
    const [chatWith, setChatWith] = useState<Template | null>(null);
    const [pendingDelete, setPendingDelete] = useState<Template | null>(null);
    const [downloading, setDownloading] = useState(false);

    const query = useQuery({
        queryKey: libraryKeys.templates,
        queryFn: ({ signal }) => listTemplates(signal),
        retry: false,
    });

    const refresh = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: libraryKeys.templates });
    }, [queryClient]);

    const uploads = useUploadQueue(
        // `skipAutoParameterize` is deliberately NOT set: letting the server
        // find the placeholders is the whole value of uploading here, and it
        // runs in the background after the 200.
        templateUploadTarget(),
        { onUploaded: refresh },
    );

    const remove = useMutation({
        mutationFn: (id: string) => deleteTemplate(id),
        onSuccess: () => {
            toast('Template deleted', 'success');
            setPendingDelete(null);
            setDetailOf(null);
            refresh();
        },
    });

    const pickTemplate = useCallback(async () => {
        const files = await pickDocuments();
        // The route rejects anything not ending in .docx before it reads a
        // byte, so refusing here saves a pointless upload and gives a better
        // message than "Only .docx files are supported".
        const accepted = files.filter((f) => /\.docx$/i.test(f.name));
        if (accepted.length !== files.length) {
            toast('Templates have to be Word .docx files', 'error');
        }
        if (accepted.length) uploads.add(accepted);
    }, [uploads, toast]);

    const download = useCallback(
        async (template: Template) => {
            setDownloading(true);
            try {
                await shareServerFile(
                    `/api/templates/${encodeURIComponent(template.id)}/download`,
                    template.fileName || `${template.name}.docx`,
                    DOCX_MIME,
                );
            } catch (err) {
                toast(describeError(err).message, 'error');
            } finally {
                setDownloading(false);
            }
        },
        [toast],
    );

    const unavailable = query.isError && isUnavailable(query.error);
    const needle = search.trim().toLowerCase();
    const templates = (query.data ?? []).filter(
        (t) =>
            !needle ||
            t.name.toLowerCase().includes(needle) ||
            (t.description ?? '').toLowerCase().includes(needle),
    );

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title="Templates"
                actions={
                    <>
                        {!unavailable ? (
                            <IconButton
                                icon={<Feather name="upload" size={20} color={theme.colors.textPrimary} />}
                                accessibilityLabel="Upload a Word template"
                                onPress={() => void pickTemplate()}
                            />
                        ) : null}
                    </>
                }
            />

            {unavailable ? (
                <EmptyState
                    icon="lock"
                    title="Templates are not enabled"
                    message="Templates are a beta feature on this server. An administrator can switch them on for your organisation."
                />
            ) : (
                <>
                    <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                        <SearchField
                            value={search}
                            onChangeText={setSearch}
                            placeholder="Search templates"
                        />
                    </View>

                    {query.isLoading ? (
                        <ListSkeleton />
                    ) : query.isError ? (
                        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
                    ) : (
                        <FlatList
                            data={templates}
                            keyExtractor={(t) => t.id}
                            refreshControl={
                                <RefreshControl
                                    refreshing={query.isRefetching}
                                    onRefresh={() => void query.refetch()}
                                    tintColor={theme.colors.accentPrimary}
                                    colors={[theme.colors.accentPrimary]}
                                />
                            }
                            ListHeaderComponent={
                                uploads.items.length > 0 ? (
                                    <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
                                        <UploadQueue
                                            items={uploads.items}
                                            onRetry={uploads.retry}
                                            onRemove={uploads.remove}
                                            onClearFinished={uploads.clearFinished}
                                        />
                                    </View>
                                ) : null
                            }
                            ListEmptyComponent={
                                uploads.active ? null : (
                                    <EmptyState
                                        icon="layout"
                                        title={search ? 'Nothing matches that' : 'No templates yet'}
                                        message={
                                            search
                                                ? 'Try a different word.'
                                                : 'Upload a Word document with {{placeholders}} in it. Bee Flow finds them and fills them in for you.'
                                        }
                                        actionLabel={search ? undefined : 'Upload a .docx'}
                                        onAction={search ? undefined : () => void pickTemplate()}
                                    />
                                )
                            }
                            contentContainerStyle={{ paddingVertical: theme.spacing.md, paddingBottom: 96 }}
                            renderItem={({ item }) => (
                                <ListRow
                                    title={item.name}
                                    subtitle={item.description || item.fileName || undefined}
                                    meta={relativeTime(item.updatedAt ?? item.createdAt)}
                                    wrapTitle
                                    leading={
                                        <Feather name="layout" size={18} color={theme.colors.textMuted} />
                                    }
                                    trailing={
                                        <Badge
                                            label={plural(item.parameters.length, 'field')}
                                            tone={item.parameters.length > 0 ? 'accent' : 'neutral'}
                                        />
                                    }
                                    onPress={() => setDetailOf(item)}
                                    onLongPress={() => setPendingDelete(item)}
                                />
                            )}
                        />
                    )}
                </>
            )}

            <Sheet
                visible={Boolean(detailOf)}
                onClose={() => setDetailOf(null)}
                title={detailOf?.name ?? ''}
                subtitle={detailOf?.fileName ?? undefined}
                footer={
                    <View style={{ gap: theme.spacing.sm }}>
                        <Button
                            label="Start a chat from this"
                            fullWidth
                            onPress={() => {
                                const template = detailOf;
                                setDetailOf(null);
                                setChatWith(template);
                            }}
                            icon={
                                <Feather
                                    name="message-circle"
                                    size={16}
                                    color={theme.colors.accentPrimaryFg}
                                />
                            }
                        />
                        <Button
                            label="Download the blank template"
                            variant="secondary"
                            fullWidth
                            loading={downloading}
                            onPress={() => detailOf && void download(detailOf)}
                        />
                    </View>
                }
            >
                {detailOf?.description ? (
                    <Text variant="body" tone="secondary">
                        {detailOf.description}
                    </Text>
                ) : null}

                <View style={{ gap: theme.spacing.sm }}>
                    <Text variant="label" tone="tertiary">
                        {detailOf?.parameters.length
                            ? `${plural(detailOf.parameters.length, 'PLACEHOLDER')}`.toUpperCase()
                            : 'NO PLACEHOLDERS FOUND'}
                    </Text>
                    {detailOf?.parameters.length ? (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                            {detailOf.parameters.map((param) => (
                                <Chip key={param.name} label={param.name} />
                            ))}
                        </View>
                    ) : (
                        <Text variant="caption" tone="tertiary">
                            Bee Flow could not find any {'{{placeholders}}'} in this document. You can
                            still chat about it — it just has nothing to fill in.
                        </Text>
                    )}
                </View>

                {detailOf?.instructions ? (
                    <>
                        <Divider />
                        <View style={{ gap: theme.spacing.xs }}>
                            <Text variant="label" tone="tertiary">
                                HOW IT SHOULD BE FILLED
                            </Text>
                            <Text variant="caption" tone="secondary">
                                {detailOf.instructions}
                            </Text>
                        </View>
                    </>
                ) : null}

                <Pressable
                    onPress={() => detailOf && setPendingDelete(detailOf)}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${detailOf?.name ?? 'this template'}`}
                    style={{ minHeight: theme.minTouch, justifyContent: 'center' }}
                >
                    <Text variant="body" tone="error">
                        Delete this template
                    </Text>
                </Pressable>
            </Sheet>

            {/*
              Chat gets a full-screen modal rather than a sheet: it owns a
              composer and a keyboard, and a half-height surface leaves room for
              about two messages.
            */}
            <TemplateChatModal template={chatWith} onClose={() => setChatWith(null)} />

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title={`Delete “${pendingDelete?.name ?? ''}”?`}
                message="The template file is removed from your server. Documents you already filled in from it are unaffected."
                confirmLabel="Delete template"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
            />
        </Screen>
    );
}

function TemplateChatModal({
    template,
    onClose,
}: {
    template: Template | null;
    onClose: () => void;
}) {
    const theme = useTheme();
    const insets = useSafeAreaInsets();

    return (
        <Modal
            visible={Boolean(template)}
            animationType="slide"
            onRequestClose={onClose}
            statusBarTranslucent
        >
            <View
                style={{
                    flex: 1,
                    backgroundColor: theme.colors.bgPrimary,
                    paddingTop: insets.top,
                    paddingBottom: insets.bottom,
                }}
            >
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.sm,
                        paddingHorizontal: theme.spacing.sm,
                        paddingVertical: theme.spacing.sm,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: theme.colors.borderSubtle,
                    }}
                >
                    <IconButton
                        icon={<Feather name="arrow-left" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel="Close this chat"
                        onPress={onClose}
                    />
                    <View style={{ flex: 1 }}>
                        <Text variant="subheading" numberOfLines={1} accessibilityRole="header">
                            {template?.name ?? 'Template'}
                        </Text>
                        <Text variant="label" tone="tertiary" numberOfLines={1}>
                            {plural(template?.parameters.length ?? 0, 'field')} to fill in
                        </Text>
                    </View>
                </View>

                {template ? (
                    <LibraryChat
                        streamPath="/ai/chat/template/stream"
                        extraBody={{ templateId: template.id }}
                        // Template chat is not persisted server-side, so every
                        // session starts empty and the history it sends is
                        // whatever happened in this modal.
                        initialMessages={[]}
                        emptyTitle="Fill this template in"
                        emptyMessage={
                            template.parameters.length
                                ? `Tell it what goes in ${template.parameters
                                      .slice(0, 3)
                                      .map((p) => p.name)
                                      .join(', ')}${template.parameters.length > 3 ? ' and the rest' : ''} — or attach a document and let it read them out.`
                                : 'Ask anything about this document, or attach a file to work from.'
                        }
                        placeholder="What should go in it?"
                    />
                ) : null}
            </View>
        </Modal>
    );
}
