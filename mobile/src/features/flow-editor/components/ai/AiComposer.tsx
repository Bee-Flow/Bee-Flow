/**
 * The assistant's composer: what to build, the model tier it is built on
 * (the tiers this person may use for building routines — the web builder's
 * `automation` task list — `auto` always offered), and Send, which turns
 * into Stop while a turn streams. No attachments: the phone's builder turn
 * sends none (api/builder.ts builderTurnBody).
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useTiers } from '@/features/chat';
import { tierName, tierOptions, type TierConfig } from '@/features/flow-editor/components/editors/ai/tiers';
import { ActionMenu, Chip, Icon, IconButton, TextField } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    shell: { gap: theme.spacing.sm } satisfies ViewStyle,
    row: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
    field: { flex: 1 } satisfies ViewStyle,
    tiers: { flexDirection: 'row' } satisfies ViewStyle,
    send: { color: theme.colors.accentText },
    stop: { color: theme.colors.error },
});

export interface AiComposerProps {
    text: string;
    onText: (text: string) => void;
    tier: string;
    onTier: (tier: string) => void;
    streaming: boolean;
    onSend: () => void;
    onStop: () => void;
}

export function AiComposer({ text, onText, tier, onTier, streaming, onSend, onStop }: AiComposerProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [picking, setPicking] = useState(false);
    const tiers = (useTiers('automation').data ?? {}) as TierConfig;
    const canSend = text.trim().length > 0 && !streaming;
    return (
        <View style={styles.shell}>
            <View style={styles.tiers}>
                <Chip
                    label={t('mobile.flow.ai.tier', 'Model: {tier}', { tier: tierName(tier, tiers, t) })}
                    onPress={() => setPicking(true)}
                    disabled={streaming}
                    testID="ai-tier"
                />
            </View>
            <View style={styles.row}>
                <View style={styles.field}>
                    <TextField
                        value={text}
                        onChangeText={onText}
                        placeholder={t('mobile.flow.ai.placeholder', 'Describe what the routine should do…')}
                        multiline
                        maxLines={5}
                        editable={!streaming}
                        accessibilityLabel={t('mobile.flow.ai.message', 'Message to the assistant')}
                        testID="ai-input"
                    />
                </View>
                {streaming ? (
                    <IconButton icon={<Icon name="Square" size={20} color={styles.stop.color} />} accessibilityLabel={t('mobile.flow.ai.stop', 'Stop')} onPress={onStop} testID="ai-stop" />
                ) : (
                    <IconButton
                        icon={<Icon name="Send" size={20} color={styles.send.color} />}
                        accessibilityLabel={t('mobile.flow.ai.send', 'Send')}
                        onPress={onSend}
                        disabled={!canSend}
                        testID="ai-send"
                    />
                )}
            </View>
            <ActionMenu
                visible={picking}
                onClose={() => setPicking(false)}
                title={t('mobile.flow.ai.tier_title', 'Build with')}
                items={tierOptions(tiers, tier, t).map((o) => ({ id: o.value, label: o.label, selected: o.value === tier, onPress: () => onTier(o.value) }))}
            />
        </View>
    );
}
