/**
 * One finding on "Needs attention": its kind's tile, the producer's sentence
 * (which already names the object), the remediation under it, and — when the
 * row says where the object lives — a "Show me" that opens it.
 */

import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { KindTile, Text } from '@/shared/ui';

import { useOpenTarget } from '../hooks/useOpenTarget';
import type { AttentionRow } from '../model/api';
import { rowKind } from '../model/attention';
import { attentionTarget } from '../model/links';

export function AttentionRowView({ row }: { row: AttentionRow }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const open = useOpenTarget();
    const target = attentionTarget(row);
    const showMe = t('studio.attention.show_me', 'Show me');
    return (
        <Pressable
            onPress={target ? () => open(target) : undefined}
            disabled={!target}
            accessibilityRole={target ? 'button' : 'text'}
            accessibilityHint={target ? showMe : undefined}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`studio-attention-row-${row.code}`}
        >
            <KindTile kind={rowKind(row.kind)} size={28} />
            <View style={styles.words}>
                <Text variant="caption" numberOfLines={3}>
                    {row.message || row.code}
                </Text>
                {row.remediation ? (
                    <Text variant="label" tone="tertiary" numberOfLines={2}>
                        {row.remediation}
                    </Text>
                ) : null}
                {target ? (
                    <Text variant="label" tone="accent" weight="semibold">
                        {showMe}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing[3],
        paddingVertical: theme.spacing[2],
        borderRadius: theme.radii.sm,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    words: { flex: 1, gap: 2 } satisfies ViewStyle,
});
