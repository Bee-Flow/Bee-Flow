/**
 * Filling a template in, by chat. A full-screen modal rather than a sheet: it
 * owns a composer and a keyboard, and a half-height surface leaves room for
 * about two messages.
 *
 * The modal is its own window, and Android pans rather than resizes it for
 * the keyboard (softwareKeyboardLayoutMode 'pan'), so the composer sat under
 * the keyboard. The body avoids it the way Screen's `avoidKeyboard` does —
 * 'height' on Android — which a screen's LibraryChat (notebooks) already gets
 * from its Screen.
 *
 * The conversation is kept nowhere but here (the server stores no template
 * chat), so once a question has been sent, closing — Back included — asks
 * first. An untouched chat closes at once.
 */

import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { LibraryChat } from '@/features/notebooks';
import { useConfirm } from '@/shared/patterns';
import { Icon, IconButton, Text } from '@/shared/ui';

import type { Template } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        flex: { flex: 1 },
        root: { flex: 1, backgroundColor: theme.colors.bgPrimary },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.sm,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.borderSubtle,
        },
        titles: { flex: 1 },
    });

/** "Tell it what goes in A, B, C and the rest" — the first three field names. */
function emptyMessage(template: Template, t: TranslateFn): string {
    const params = template.parameters;
    if (!params.length) {
        return t('mobile.templates.chat_empty_no_fields', 'Ask anything about this document, or attach a file to work from.');
    }
    const fields = params
        .slice(0, 3)
        .map((p) => p.name)
        .join(', ');
    return params.length > 3
        ? t('mobile.templates.chat_empty_many', 'Tell it what goes in {fields} and the rest — or attach a document and let it read them out.', { fields })
        : t('mobile.templates.chat_empty_few', 'Tell it what goes in {fields} — or attach a document and let it read them out.', { fields });
}

function fieldCount(count: number, t: TranslateFn): string {
    return count === 1
        ? t('mobile.templates.chat_one_field', '1 field to fill in')
        : t('mobile.templates.chat_fields', '{count} fields to fill in', { count });
}

/** Closing asks first once this template's chat holds a sent question; `onTurnSent` marks that. */
function useCloseChat(template: Template | null, onClose: () => void) {
    const t = useTranslation();
    const confirm = useConfirm();
    const [startedFor, setStartedFor] = useState<string | null>(null);
    const started = template !== null && startedFor === template.id;
    const close = async () => {
        if (started) {
            const leave = await confirm({
                title: t('mobile.templates.chat_leave_title', 'Close this chat?'),
                message: t('mobile.templates.chat_leave_body', 'This conversation is not saved anywhere. Closing it loses the questions and answers so far.'),
                confirmLabel: t('mobile.templates.chat_leave', 'Close chat'),
            });
            if (!leave) return;
        }
        setStartedFor(null);
        onClose();
    };
    return { close: () => void close(), onTurnSent: () => setStartedFor(template?.id ?? null) };
}

export function TemplateChatModal({ template, onClose }: { template: Template | null; onClose: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const insets = useSafeAreaInsets();
    const { close, onTurnSent } = useCloseChat(template, onClose);

    return (
        <Modal visible={Boolean(template)} animationType="slide" onRequestClose={close} statusBarTranslucent>
            <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} testID="template-chat">
                <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
                    <View style={styles.header}>
                        <IconButton
                            icon={<Icon name="ArrowLeft" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel={t('mobile.templates.chat_close', 'Close this chat')}
                            onPress={close}
                        />
                        <View style={styles.titles}>
                            <Text variant="subheading" numberOfLines={1} accessibilityRole="header">
                                {template?.name ?? t('mobile.templates.chat_untitled', 'Template')}
                            </Text>
                            <Text variant="label" tone="tertiary" numberOfLines={1}>
                                {fieldCount(template?.parameters.length ?? 0, t)}
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
                            emptyTitle={t('mobile.templates.chat_empty_title', 'Fill this template in')}
                            emptyMessage={emptyMessage(template, t)}
                            placeholder={t('mobile.templates.chat_placeholder', 'What should go in it?')}
                            onTurnSent={onTurnSent}
                        />
                    ) : null}
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}
