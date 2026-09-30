/** The files a message was sent with, as badges under its text. */

import React from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatMessage } from '@/features/chat/model/types';
import { Badge } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    strip: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6, marginTop: theme.spacing.sm },
});

export function AttachmentStrip({ attachments }: { attachments: NonNullable<ChatMessage['attachments']> }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.strip}>
            {attachments.map((a, i) => (
                <Badge key={a.id ?? i} label={a.name} tone="neutral" />
            ))}
        </View>
    );
}
