/**
 * One line of the hub's "Needs attention" card: a group of findings of one
 * source and code (model/attentionGroups). A single finding opens its object
 * ("Show me"); several open the whole list, where each has its own.
 */

import React from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, KindTile, Text } from '@/shared/ui';

import { useOpenTarget } from '../hooks/useOpenTarget';
import { rowKind } from '../model/attention';
import { groupWords, type AttentionGroup } from '../model/attentionGroups';
import { attentionTarget } from '../model/links';

export function AttentionGroupRow({ group, onShowAll }: { group: AttentionGroup; onShowAll: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const open = useOpenTarget();
    const words = groupWords(group);
    const title = 'text' in words.title ? words.title.text : t(words.title.key, words.title.fallback);
    const many = group.rows.length > 1;
    const [first] = group.rows;
    const target = !many && first ? attentionTarget(first) : null;
    const onPress = many ? onShowAll : target ? () => open(target) : undefined;
    return (
        <Pressable
            onPress={onPress}
            disabled={!onPress}
            accessibilityRole={onPress ? 'button' : 'text'}
            accessibilityLabel={many ? `${title}, ${group.rows.length}` : title}
            accessibilityHint={target ? t('studio.attention.show_me', 'Show me') : undefined}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`studio-attention-group-${group.code}`}
        >
            <KindTile kind={rowKind(group.kind)} size={24} />
            <View style={styles.words}>
                <Text variant="caption" numberOfLines={1}>
                    {title}
                </Text>
                {many && words.detail ? (
                    <Text variant="label" tone="tertiary" numberOfLines={1}>
                        {words.detail}
                    </Text>
                ) : null}
            </View>
            {many ? (
                <Text variant="caption" tone="tertiary" style={styles.count}>
                    {group.rows.length}
                </Text>
            ) : null}
            {onPress ? <Icon name="ChevronRight" size={14} color={theme.colors.textTertiary} /> : null}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2.5],
        minHeight: 40,
        borderRadius: theme.radii.sm,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    words: { flex: 1 } satisfies ViewStyle,
    count: { fontVariant: ['tabular-nums'] } satisfies TextStyle,
});
