/** Staged attachments above the input; a tap removes one. */

import React from 'react';
import { ScrollView, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { Attachment } from '@/features/chat/model/types';
import { formatBytes } from '@/shared/lib/bytes';
import { Chip, Icon } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row' as const, gap: theme.spacing.sm },
});

export function AttachmentChips({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (index: number) => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.row}>
                {attachments.map((a, i) => (
                    <Chip
                        key={`${a.name}-${i}`}
                        label={a.size ? `${a.name} · ${formatBytes(a.size)}` : a.name}
                        onPress={() => onRemove(i)}
                        icon={<Icon name="X" size={12} color={theme.colors.textMuted} />}
                    />
                ))}
            </View>
        </ScrollView>
    );
}
