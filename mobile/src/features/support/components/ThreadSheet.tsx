/**
 * A support thread, read and replied to in place. The conversation is one
 * request's back-and-forth — short by nature — so it renders in the sheet's
 * own scroll rather than a virtualised list nested inside it.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, LoadingState, Sheet, Text, TextField } from '@/shared/ui';

import { ThreadMessage } from './ThreadMessage';
import { useReplyToSupportThread } from '../hooks/mutations';
import { useSupportThread } from '../hooks/queries';
import { isFinished, statusCopy } from '../model/status';

export function ThreadSheet({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const [reply, setReply] = useState('');
    const thread = useSupportThread(threadId);
    const send = useReplyToSupportThread(threadId);
    const detail = thread.data;

    const footer = isFinished(detail?.thread.status) ? (
        <Text variant="caption" tone="tertiary" center>
            This request is closed. Ask a new question if something else comes up.
        </Text>
    ) : (
        <View style={styles.footer}>
            <TextField
                value={reply}
                onChangeText={setReply}
                placeholder="Reply"
                multiline
                maxLines={4}
                maxLength={10_000}
                accessibilityLabel="Reply to this request"
            />
            <Button
                label="Send reply"
                onPress={() => send.mutate(reply.trim(), { onSuccess: () => setReply('') })}
                disabled={reply.trim().length === 0}
                loading={send.isPending}
                fullWidth
            />
        </View>
    );

    return (
        <Sheet
            visible={threadId !== null}
            onClose={onClose}
            title={detail?.thread.subject ?? 'Request'}
            subtitle={detail ? statusCopy(detail.thread.status).label : undefined}
            footer={footer}
        >
            {thread.isLoading ? (
                <LoadingState />
            ) : thread.isError ? (
                <Banner tone="error">{describeError(thread.error).message}</Banner>
            ) : detail ? (
                <View style={styles.messages}>
                    {send.isError ? (
                        <Banner tone="error">{describeError(send.error).message}</Banner>
                    ) : null}
                    {detail.messages.map((entry) => (
                        <ThreadMessage key={entry.id} entry={entry} />
                    ))}
                </View>
            ) : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        footer: { gap: theme.spacing.sm },
        messages: { gap: theme.spacing.lg },
    });
