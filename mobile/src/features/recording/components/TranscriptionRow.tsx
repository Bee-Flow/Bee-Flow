/**
 * One past meeting in the library list. It stays openable the whole time it
 * is processing: the detail screen has something useful to say while it waits.
 *
 * In the report's select mode a tap picks the note instead, and a note that
 * is still transcribing or failed is drawn disabled: it has nothing to report
 * on, and a row that looks pickable but ignores the tap is a small lie.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, ListRow, Text } from '@/shared/ui';

import { formatWhen } from '../model/format';
import { isReportable } from '../model/library';
import { rowFacts, rowSubtitle, statusLabel } from '../model/row';
import type { TranscriptionSummary } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        glyph: {
            width: 40,
            height: 40,
            borderRadius: theme.radii.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.bgTertiary,
        },
    });

function glyphFor(item: TranscriptionSummary, colors: Theme['colors']) {
    if (item.status === 'processing') return { icon: 'Loader' as const, colour: colors.accentPrimary };
    if (item.status === 'failed') return { icon: 'TriangleAlert' as const, colour: colors.error };
    return { icon: item.source === 'recording' ? ('Mic' as const) : ('FileText' as const), colour: colors.textSecondary };
}

export function TranscriptionRow({
    item,
    onPress,
    onLongPress,
    selection,
}: {
    item: TranscriptionSummary;
    onPress: () => void;
    onLongPress?: () => void;
    /** Present in select mode: whether this note is picked. */
    selection?: { selected: boolean };
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { icon, colour } = glyphFor(item, theme.colors);
    const facts = rowFacts(item);

    return (
        <ListRow
            title={item.title || t('meetings.untitled', 'Untitled meeting')}
            subtitle={rowSubtitle(item)}
            wrapTitle
            meta={formatWhen(item.createdAt)}
            onPress={onPress}
            onLongPress={onLongPress}
            selected={selection?.selected}
            disabled={selection ? !isReportable(item) : false}
            leading={
                <View style={styles.glyph}>
                    <Icon
                        name={selection?.selected ? 'CircleCheck' : icon}
                        size={18}
                        color={selection?.selected ? theme.colors.accentPrimary : colour}
                    />
                </View>
            }
            trailing={
                item.status === 'completed' && facts.length ? (
                    <Text variant="label" tone="tertiary" numberOfLines={1}>
                        {facts.join(' · ')}
                    </Text>
                ) : (
                    <Text variant="label" tone={item.status === 'failed' ? 'error' : 'accent'} numberOfLines={1}>
                        {statusLabel(item.status)}
                    </Text>
                )
            }
        />
    );
}
