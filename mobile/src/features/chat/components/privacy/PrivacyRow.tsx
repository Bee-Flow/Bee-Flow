/**
 * Under a question the shield changed: the privacy line, and the amber pill
 * when part of an upload went unchecked. Right-aligned with the bubble.
 */

import React from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { privacyCount } from '@/features/chat/model/turnContext';
import type { ChatMessage } from '@/features/chat/model/types';

import { PrivacyLineText } from './PrivacyLineText';
import { ScanWarningPill } from './ScanWarningPill';

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row' as const,
        flexWrap: 'wrap' as const,
        justifyContent: 'flex-end' as const,
        alignItems: 'center' as const,
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        marginTop: theme.spacing.xs,
    },
});

export function PrivacyRow({ message }: { message: ChatMessage }) {
    const styles = useThemedStyles(makeStyles);
    const warnings = message.privacy?.scanWarnings ?? [];
    const count = privacyCount(message);
    if (!count && warnings.length === 0) return null;
    return (
        <View style={styles.row}>
            <PrivacyLineText
                count={count}
                messageText={message.content}
                tokenMap={message.turnTokenMap}
                scanIncomplete={warnings.length > 0}
            />
            <ScanWarningPill warnings={warnings} />
        </View>
    );
}
