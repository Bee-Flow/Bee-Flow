/**
 * The data-loss-prevention decision.
 *
 * This is the one place in chat where the server stops and waits for a person.
 * The privacy scanner has found personal data in what is about to be sent to a
 * model, and the turn does not advance until the app POSTs an answer to
 * /api/chat/dlp-decision. A client that ignores `dlp_preview` looks like it has
 * hung, with no error and no way forward — which is why this is a blocking,
 * unmissable panel rather than a toast.
 *
 * The three choices are the server's, not ours:
 *   redact — replace the findings with tokens, then continue. The safe default,
 *            and the one the product exists to make easy.
 *   allow  — send it as written.
 *   block  — cancel the turn.
 *
 * "Remember for this conversation" is offered because a document review is a
 * long sequence of near-identical decisions, and asking twenty times trains
 * people to stop reading the question.
 */

import { Feather } from '@expo/vector-icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { DlpDecision } from './types';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Text } from '../../ui/Text';


export function DlpPrompt({
    decision,
    onChoose,
}: {
    decision: DlpDecision;
    onChoose: (
        choice: 'allow' | 'redact' | 'block',
        rememberForConversation?: boolean,
    ) => Promise<void>;
}) {
    const theme = useTheme();
    const [remember, setRemember] = useState(false);
    const [busy, setBusy] = useState<'allow' | 'redact' | 'block' | null>(null);

    const choose = (choice: 'allow' | 'redact' | 'block') => {
        setBusy(choice);
        void onChoose(choice, remember).finally(() => setBusy(null));
    };

    return (
        <View
            accessibilityLiveRegion="assertive"
            style={{
                margin: theme.spacing.lg,
                padding: theme.spacing.lg,
                borderRadius: theme.radii.lg,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.warning,
                backgroundColor: theme.colors.bgCard,
                gap: theme.spacing.md,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                <Feather name="shield" size={18} color={theme.colors.warning} />
                <Text variant="subheading" style={{ flex: 1 }}>
                    Personal data found
                </Text>
            </View>

            <Text variant="body" tone="secondary">
                {decision.summary}
            </Text>

            {decision.findings?.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
                    {decision.findings.map((f) => (
                        <Badge key={f.category} label={`${f.category} · ${f.count}`} tone="warning" />
                    ))}
                </View>
            ) : null}

            <Button
                label={remember ? 'Remembering for this chat' : 'Remember my choice for this chat'}
                variant="ghost"
                onPress={() => setRemember((v) => !v)}
                icon={
                    <Feather
                        name={remember ? 'check-square' : 'square'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                }
            />

            <View style={{ gap: theme.spacing.sm }}>
                <Button
                    label="Replace with placeholders"
                    onPress={() => choose('redact')}
                    loading={busy === 'redact'}
                    disabled={busy !== null && busy !== 'redact'}
                    fullWidth
                />
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                    <Button
                        label="Send as written"
                        variant="secondary"
                        onPress={() => choose('allow')}
                        loading={busy === 'allow'}
                        disabled={busy !== null && busy !== 'allow'}
                        style={{ flex: 1 }}
                    />
                    <Button
                        label="Cancel"
                        variant="destructive"
                        onPress={() => choose('block')}
                        loading={busy === 'block'}
                        disabled={busy !== null && busy !== 'block'}
                        style={{ flex: 1 }}
                    />
                </View>
            </View>
        </View>
    );
}
