/**
 * What the agent wanted to do and did not (the web's ToolConfirmCard): the
 * tool, whether it leaves the workspace, the server's bounded view of its
 * arguments, and where it stands — pending, approved (it ran, or it will on
 * the next message), declined, or unknown.
 *
 * Without `onDecide` the card is a notice, as on the web: a surface whose
 * next turn cannot carry a decision (the server honours `toolDecisions` in
 * the builder's test chat only) must not show a button that goes nowhere.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ToolDecision } from '@/features/chat/hooks/transcriptActions';
import { confirmDecisionOf } from '@/features/chat/model/toolConfirm';
import type { PendingToolCall } from '@/features/chat/model/types';
import { Badge, Button, Text } from '@/shared/ui';

import { ToolConfirmHeader } from './ToolConfirmHeader';

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.sm, marginVertical: theme.spacing.md },
    card: { borderRadius: theme.radii.lg, borderWidth: 1, borderColor: theme.colors.borderSubtle, overflow: 'hidden' as const },
    declined: { opacity: 0.6 },
    body: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md, gap: theme.spacing[1.5] },
    name: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, gap: theme.spacing.sm },
    preview: { flexDirection: 'row' as const, gap: theme.spacing.sm },
    value: { flex: 1 },
    foot: {
        flexDirection: 'row' as const,
        flexWrap: 'wrap' as const,
        alignItems: 'center' as const,
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgSecondary,
    },
});

export function ToolConfirmCard({
    calls,
    onDecide,
    decided = {},
}: {
    calls: readonly PendingToolCall[];
    onDecide?: (call: PendingToolCall, decision: ToolDecision) => void;
    decided?: Readonly<Record<string, string>>;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.list}>
            {calls.map((call, index) => {
                const { status, by } = confirmDecisionOf(call, decided);
                const sends = call.effect === 'sends';
                return (
                    <View key={call.argsKey ?? call.callId ?? `${index}`} style={[styles.card, status === 'declined' ? styles.declined : null]}>
                        <ToolConfirmHeader status={status} by={by} sends={sends} />
                        <View style={styles.body}>
                            <View style={styles.name}>
                                <Text variant="code" weight="semibold">
                                    {call.toolName}
                                </Text>
                                {sends ? <Badge label={t('agent_studio.test.tool_effect_sends', 'leaves this workspace')} tone="warning" /> : null}
                            </View>
                            {Object.entries(call.preview ?? {}).map(([name, value]) => (
                                <View key={name} style={styles.preview}>
                                    <Text variant="caption" tone="tertiary" weight="medium">
                                        {name}
                                    </Text>
                                    <Text variant="caption" style={styles.value} selectable>
                                        {typeof value === 'string' ? value : JSON.stringify(value)}
                                    </Text>
                                </View>
                            ))}
                        </View>
                        {status === 'pending' ? (
                            <View style={styles.foot}>
                                {onDecide ? (
                                    <>
                                        <Button label={t('agent_studio.test.tool_confirm_approve', 'Approve and run')} size="sm" onPress={() => onDecide(call, 'approve')} />
                                        <Button label={t('agent_studio.test.tool_confirm_decline', 'Do not run it')} size="sm" variant="secondary" onPress={() => onDecide(call, 'decline')} />
                                        <Text variant="label" tone="tertiary">
                                            {t('agent_studio.test.tool_confirm_next_turn', 'Applies on your next message')}
                                        </Text>
                                    </>
                                ) : (
                                    <Text variant="caption" tone="tertiary">
                                        {t('agent_studio.test.tool_confirm_no_decision', 'Nothing was done — this agent asks a person before actions like this.')}
                                    </Text>
                                )}
                            </View>
                        ) : null}
                    </View>
                );
            })}
        </View>
    );
}
