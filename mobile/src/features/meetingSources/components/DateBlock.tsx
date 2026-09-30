/**
 * The date tile at the start of an upcoming row: weekday, day, month, in the
 * meeting kind's tint. Without a start time (Talk's calendar may send none)
 * it is a calendar glyph with a reason, never an invented date.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, kindColor, Text, tint } from '@/shared/ui';

import { dateBlockParts } from '../model/when';

const styles = StyleSheet.create({
    tile: { width: 40, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    small: { fontSize: 9, lineHeight: 11, textTransform: 'uppercase' },
    day: { fontSize: 15, lineHeight: 18, fontWeight: '600' },
});

export function DateBlock({ start }: { start: string | null }) {
    const t = useTranslation();
    const theme = useTheme();
    const ink = kindColor(theme, 'meeting');
    // The kind's colour is theme data, so the tile's paint is computed.
    const paint = { backgroundColor: tint(ink, 16) };
    const inkText = { color: ink };
    const parts = dateBlockParts(start);

    if (!parts) {
        return (
            <View
                style={[styles.tile, paint]}
                accessible
                accessibilityLabel={t('meetings.upcoming_no_start', 'This meeting has no start time in the calendar.')}
            >
                <Icon name="Calendar" size={16} color={ink} />
            </View>
        );
    }
    return (
        <View style={[styles.tile, paint]}>
            <Text variant="caption" style={[styles.small, inkText]}>
                {parts.weekday}
            </Text>
            <Text variant="body" style={[styles.day, inkText]}>
                {parts.day}
            </Text>
            <Text variant="caption" style={[styles.small, inkText]}>
                {parts.month}
            </Text>
        </View>
    );
}
