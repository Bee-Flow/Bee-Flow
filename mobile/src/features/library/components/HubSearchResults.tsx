/**
 * The hub collapsed into one ranked list of matches, each with its kind as a
 * badge. When you are looking for one specific thing you do not know or care
 * which collection it is in.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { openRoute } from '@/shared/navigation';
import { Badge, EmptyState, Icon, ListRow } from '@/shared/ui';

import { KIND_ICON, KIND_LABEL } from '../model/hits';
import type { LibraryHit } from '../model/types';

const styles = StyleSheet.create({ content: { paddingBottom: 96 } });

export function HubSearchResults({
    hits,
    refreshing,
    onRefresh,
}: {
    hits: LibraryHit[];
    refreshing: boolean;
    onRefresh: () => void;
}) {
    const theme = useTheme();
    const router = useRouter();

    return (
        <FlatList
            data={hits}
            keyExtractor={(hit) => `${hit.kind}-${hit.id}`}
            keyboardShouldPersistTaps="handled"
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            ListEmptyComponent={
                <EmptyState
                    icon="Search"
                    title="Nothing matches that"
                    message="Try fewer words. Search looks at names and descriptions, not inside documents — to search inside a knowledge base, open it and use Query."
                />
            }
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <ListRow
                    title={item.title}
                    subtitle={item.subtitle}
                    meta={item.meta}
                    wrapTitle
                    leading={<Icon name={KIND_ICON[item.kind]} size={18} color={theme.colors.textMuted} />}
                    trailing={<Badge label={KIND_LABEL[item.kind]} />}
                    onPress={() => openRoute(router, item.href)}
                />
            )}
        />
    );
}
