/**
 * The search screen's header, and deliberately not a ScreenHeader: it has no
 * title. The input IS the title, focused on arrival, because this screen
 * exists to be typed into — a heading above it would push the field down for
 * a word the user already knows.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, SearchField, Spinner } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.sm,
        },
        field: { flex: 1 },
        spinner: { width: 24, alignItems: 'center' },
    });

export function SearchBar({
    value,
    onChange,
    onSubmit,
    onBack,
    searching,
}: {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    onBack: () => void;
    searching: boolean;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.bar}>
            <IconButton
                icon={<Icon name="ArrowLeft" size={20} color={theme.colors.textPrimary} />}
                accessibilityLabel="Back"
                onPress={onBack}
            />
            <SearchField
                value={value}
                onChangeText={onChange}
                placeholder="Search chats, notebooks, documents"
                autoFocus
                onSubmit={onSubmit}
                style={styles.field}
            />
            <View style={styles.spinner}>{searching ? <Spinner /> : null}</View>
        </View>
    );
}
