/**
 * The user's message: a bubble, right-aligned and capped at 85% width —
 * short, scannable, obviously theirs. Long-press copies it. Under it: the
 * privacy line when the shield changed it, and the pencil that rewrites it
 * (when the transcript allows edits) beside the time it was sent.
 *
 * A message the security policy removed is not drawn as a bubble — its words
 * are gone from the database — but as a small notice saying so.
 */

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { PrivacyRow } from '@/features/chat/components/privacy/PrivacyRow';
import { useTranscriptActions } from '@/features/chat/hooks/transcriptActions';
import type { ChatMessage } from '@/features/chat/model/types';
import { Icon, Text, useToast } from '@/shared/ui';

import { AttachmentStrip } from './AttachmentStrip';
import { MessageAction } from './MessageAction';
import { UserEditComposer } from './UserEditComposer';

/** What the server stores in place of a question its policy removed. */
const REMOVED_BY_POLICY = '[Message removed - policy violation]';

const makeStyles = (theme: Theme) => ({
    row: { paddingHorizontal: theme.spacing.lg },
    bubble: {
        maxWidth: '85%' as const,
        backgroundColor: theme.colors.userBubbleBg,
        borderRadius: theme.radii.lg,
        // Squared off at the sending corner — the standard cue for "this one is mine".
        borderBottomRightRadius: theme.radii.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
    },
    text: { color: theme.colors.userBubbleFg },
    removed: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.spacing.sm,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        borderStyle: 'dashed' as const,
        borderColor: theme.colors.borderSubtle,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing[2.5],
    },
    meta: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, alignItems: 'center' as const, gap: theme.spacing.lg, paddingHorizontal: theme.spacing.lg },
});

function sentAt(iso: string | undefined): string | null {
    if (!iso) return null;
    const when = new Date(iso);
    return Number.isNaN(when.getTime()) ? null : when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function UserMessage({ message }: { message: ChatMessage }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const { onEdit } = useTranscriptActions();
    const [editing, setEditing] = useState(false);

    if (message.content === REMOVED_BY_POLICY) {
        return (
            <View style={[fixed.row, styles.row]}>
                <View style={styles.removed}>
                    <Icon name="Shield" size={14} color={theme.colors.textMuted} />
                    <Text variant="caption" tone="tertiary">
                        {t('chat.message_removed', 'Message removed by security policy')}
                    </Text>
                </View>
            </View>
        );
    }
    if (editing && onEdit) {
        return (
            <UserEditComposer
                initial={message.content}
                onCancel={() => setEditing(false)}
                onSubmit={(text) => {
                    setEditing(false);
                    onEdit(message, text);
                }}
            />
        );
    }

    const copy = () => {
        void Clipboard.setStringAsync(message.content);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        toast(t('mobile.chat.copied', 'Copied'));
    };
    const time = sentAt(message.createdAt);
    return (
        <View>
            <Pressable
                onLongPress={copy}
                accessibilityRole="text"
                accessibilityLabel={t('mobile.chat.you_said', 'You said: {text}', { text: message.content })}
                style={[fixed.row, styles.row]}
            >
                <View style={styles.bubble}>
                    <Text variant="body" style={styles.text} selectable>
                        {message.content}
                    </Text>
                    {message.attachments?.length ? <AttachmentStrip attachments={message.attachments} /> : null}
                </View>
            </Pressable>
            <PrivacyRow message={message} />
            {onEdit || time ? (
                <View style={styles.meta}>
                    {onEdit ? (
                        <MessageAction icon="Pencil" label={t('chat.msg.edit_message', 'Edit message')} onPress={() => setEditing(true)} />
                    ) : null}
                    {time ? (
                        <Text variant="label" tone="tertiary">
                            {time}
                        </Text>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

const fixed = StyleSheet.create({
    row: { flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: 6 },
});
