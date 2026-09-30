/**
 * "Pick from a conversation" — the web's FromConversationPicker. First the
 * caller's own conversations, then the answers in one of them (personal data
 * removed), then the answer that becomes an example. The best examples are
 * made where the good answer already happened.
 *
 * The note at the top is what the list may promise: "personal data removed"
 * only while every message on screen was actually checked.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, type ListRenderItem } from 'react-native';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { InsetDivider, ListRow, LoadingState, Sheet, Text } from '@/shared/ui';

import type { ExampleConversation, ExampleMessage } from '../api/exampleEndpoints';
import { useExampleConversations, useExampleMessages, useTakeExample } from '../hooks/examples';
import type { SkillExample } from '../model/types';

const makeStyles = (theme: Theme) => StyleSheet.create({ note: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } });

function takeError(t: TranslateFn, e: unknown): string {
    const code = e instanceof ApiError ? e.code : undefined;
    if (code === 'pii_unchecked') {
        return t('skills_studio.examples.err_pii_unchecked', 'The personal-data check is unavailable, so this answer cannot be copied into an example right now.');
    }
    if (code === 'too_many_examples') return t('skills_studio.examples.err_full', 'This skill already has the maximum number of examples.');
    return describeError(e).message || t('skills_studio.examples.err_take', 'Could not use that message.');
}

function Note({ t, checked, error }: { t: TranslateFn; checked: boolean; error: string | null }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <>
            <Text variant="caption" tone={checked ? 'secondary' : 'warning'} style={styles.note}>
                {checked
                    ? t('skills_studio.examples.from_chat_help', 'Only your own conversations are listed. Personal data is removed before the example is stored.')
                    : t('mobile.skills.pii_unchecked', 'Not every message could be checked for personal data, so nothing is promised about this list.')}
            </Text>
            {error ? <Text variant="caption" tone="error" style={styles.note}>{error}</Text> : null}
        </>
    );
}

export function ExamplePickerSheet({ visible, skillId, onClose, onTaken }: { visible: boolean; skillId: string; onClose: () => void; onTaken: (e: SkillExample) => void }) {
    const t = useTranslation();
    const [conversation, setConversation] = useState<string | null>(null);
    const conversations = useExampleConversations(visible);
    const messages = useExampleMessages(conversation);
    const take = useTakeExample(skillId, (example) => {
        setConversation(null);
        onTaken(example);
    });
    const close = () => {
        setConversation(null);
        onClose();
    };
    const renderConversation: ListRenderItem<ExampleConversation> = ({ item }) => (
        <ListRow title={item.title || t('mobile.skills.untitled_chat', 'Untitled conversation')}
            subtitle={[item.agentName, timeAgo(item.updatedAt, { suffix: true })].filter(Boolean).join(' · ')}
            chevron onPress={() => setConversation(item.id)} />
    );
    const renderMessage: ListRenderItem<ExampleMessage> = ({ item }) => (
        <ListRow title={item.text} wrapTitle disabled={take.isPending}
            onPress={() => conversation && take.mutate({ conversationId: conversation, messageIndex: item.index })} />
    );
    const loading = conversation ? messages.isLoading : conversations.isLoading;
    const readError = conversation ? messages.error : conversations.error;
    const error = take.error ? takeError(t, take.error) : readError ? describeError(readError).message : null;
    return (
        <Sheet visible={visible} onClose={close} title={t('skills_studio.examples.from_chat', 'Pick from a conversation')} scroll={false} tall>
            <Note t={t} checked={conversation ? messages.data?.piiChecked !== false : true} error={error} />
            {loading ? <LoadingState /> : null}
            {conversation ? (
                <FlatList data={messages.data?.messages ?? []} keyExtractor={(m) => String(m.index)} renderItem={renderMessage} ItemSeparatorComponent={InsetDivider} />
            ) : (
                <FlatList data={conversations.data ?? []} keyExtractor={(c) => c.id} renderItem={renderConversation} ItemSeparatorComponent={InsetDivider} />
            )}
        </Sheet>
    );
}
