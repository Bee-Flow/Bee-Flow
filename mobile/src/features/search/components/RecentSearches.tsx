/**
 * What the search screen shows before a term is long enough: the recent
 * searches, or — with none — what can be searched. The keyboard stays up
 * while a term is picked, like everywhere on this screen.
 */

import React from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, Icon, IconButton, ListRow, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg },
        heading: { flex: 1 },
        footer: { padding: theme.spacing.lg },
    });

const keyOf = (value: string) => value;

export function RecentSearches({
    terms,
    onPick,
    onRemove,
    onClear,
    tooShort,
}: {
    terms: string[];
    onPick: (term: string) => void;
    onRemove: (term: string) => void;
    onClear: () => void;
    tooShort: boolean;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    if (terms.length === 0) {
        return (
            <EmptyState
                icon="Search"
                title={tooShort ? 'Keep typing' : 'Search everything'}
                message={
                    tooShort
                        ? `Two characters or more, and Bee Flow starts looking.`
                        : 'Chats, notebooks, documents, knowledge bases, routines and meeting notes — all at once.'
                }
            />
        );
    }

    return (
        <FlatList
            data={terms}
            keyExtractor={keyOf}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="none"
            ListHeaderComponent={
                <View style={styles.header}>
                    <Text variant="label" tone="tertiary" accessibilityRole="header" style={styles.heading}>
                        RECENT SEARCHES
                    </Text>
                    <IconButton
                        icon={<Icon name="Trash2" size={16} color={theme.colors.textMuted} />}
                        accessibilityLabel="Clear all recent searches"
                        onPress={onClear}
                    />
                </View>
            }
            renderItem={({ item }) => (
                <ListRow
                    title={item}
                    leading={<Icon name="Clock" size={16} color={theme.colors.textMuted} />}
                    onPress={() => onPick(item)}
                    trailing={
                        <IconButton
                            icon={<Icon name="X" size={16} color={theme.colors.textMuted} />}
                            accessibilityLabel={`Forget the search ${item}`}
                            onPress={() => onRemove(item)}
                        />
                    }
                />
            )}
            ListFooterComponent={
                <Text variant="caption" tone="tertiary" style={styles.footer}>
                    Recent searches are kept on this phone only — they are never sent to your
                    server.
                </Text>
            }
        />
    );
}
