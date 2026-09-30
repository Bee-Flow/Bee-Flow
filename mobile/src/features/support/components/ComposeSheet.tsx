/**
 * A new support request: a subject, what happened, and — unless switched off
 * — the version details every thread would otherwise have to ask for.
 */

import React, { useState } from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { useServerHealth } from '@/features/settings';
import { FormSheet } from '@/shared/patterns';
import { Button, Icon, Text, TextField } from '@/shared/ui';

import { useCreateSupportThread } from '../hooks/mutations';
import { diagnostics } from '../model/diagnostics';

export function ComposeSheet({
    visible,
    onClose,
    onFiled,
}: {
    visible: boolean;
    onClose: () => void;
    onFiled: () => void;
}) {
    const theme = useTheme();
    const [subject, setSubject] = useState('');
    const [message, setMessage] = useState('');
    const [attachDetails, setAttachDetails] = useState(true);
    const health = useServerHealth({ enabled: visible, staleTime: 60_000 });
    const create = useCreateSupportThread();

    const send = () =>
        create.mutate(
            {
                subject: subject.trim(),
                message: attachDetails
                    ? `${message.trim()}\n\n---\n${diagnostics(health.data?.appVersion)}`
                    : message.trim(),
            },
            {
                onSuccess: () => {
                    setSubject('');
                    setMessage('');
                    onFiled();
                },
            },
        );

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title="Ask for help"
            subtitle="Bee Flow answers first; a person takes over if it cannot"
            submitLabel="Send"
            onSubmit={send}
            canSubmit={subject.trim().length > 0 && message.trim().length > 0}
            submitting={create.isPending}
            error={create.isError ? create.error : undefined}
        >
            <TextField
                label="What is this about?"
                value={subject}
                onChangeText={setSubject}
                maxLength={200}
                placeholder="Recording will not upload"
            />
            <TextField
                label="What happened?"
                value={message}
                onChangeText={setMessage}
                multiline
                maxLines={8}
                maxLength={5000}
                placeholder="What you did, what you expected, and what happened instead."
            />
            <Button
                label={
                    attachDetails
                        ? 'Version details will be attached'
                        : 'Version details will not be attached'
                }
                variant="ghost"
                onPress={() => setAttachDetails((v) => !v)}
                icon={
                    <Icon
                        name={attachDetails ? 'SquareCheckBig' : 'Square'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                }
            />
            <Text variant="caption" tone="tertiary">
                Your message and, if you leave it on, your app and server versions are sent.
                Nothing else — no chat contents, no files.
            </Text>
        </FormSheet>
    );
}
