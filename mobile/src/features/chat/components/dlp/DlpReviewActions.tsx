/** Block, Send anyway, and Redact and send (just "Send" when nothing is marked). */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { DlpChoice } from '@/features/chat/hooks/dlpResolver';
import { Button } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    foot: {
        flexDirection: 'row' as const,
        flexWrap: 'wrap' as const,
        justifyContent: 'flex-end' as const,
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.md,
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgSecondary,
    },
});

export function DlpReviewActions({
    busy,
    anyMarked,
    onChoose,
    bottomInset,
}: {
    busy: DlpChoice | null;
    anyMarked: boolean;
    onChoose: (choice: DlpChoice) => void;
    bottomInset: number;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const pad = { paddingBottom: bottomInset + 12 };
    return (
        <View style={[styles.foot, pad]}>
            <Button label={t('dlp.action_block', 'Block')} iconName="X" variant="danger" size="sm" loading={busy === 'block'} disabled={busy !== null} onPress={() => onChoose('block')} />
            <Button
                label={t('dlp.action_allow', 'Send anyway')}
                iconName="Send"
                variant="secondary"
                size="sm"
                accessibilityHint={t('dlp.action_allow_tooltip', 'Send the prompt unchanged')}
                loading={busy === 'allow'}
                disabled={busy !== null}
                onPress={() => onChoose('allow')}
            />
            <Button
                label={anyMarked ? t('dlp.action_redact', 'Redact and send') : t('dlp.action_confirm_send', 'Send')}
                iconName="Eye"
                size="sm"
                loading={busy === 'redact'}
                disabled={busy !== null}
                onPress={() => onChoose('redact')}
            />
        </View>
    );
}
