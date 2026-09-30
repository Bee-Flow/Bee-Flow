/** Search and the category chips above the agent list. */

import React from 'react';
import { ScrollView, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, SearchField } from '@/shared/ui';

import { useAgentCategories } from '../hooks/queries';
import { ALL, FAVORITES } from '../model/format';

const makeStyles = (theme: Theme) => ({
    bar: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm },
    chips: { gap: theme.spacing.sm, paddingVertical: theme.spacing.xs, paddingRight: theme.spacing.lg },
});

export function AgentFilters({
    search,
    onSearch,
    category,
    onCategory,
}: {
    search: string;
    onSearch: (next: string) => void;
    category: string;
    onCategory: (next: string) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const categories = useAgentCategories();
    return (
        <View style={styles.bar}>
            <SearchField value={search} onChangeText={onSearch} placeholder="Search agents" />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                <Chip label="All" selected={category === ALL} onPress={() => onCategory(ALL)} />
                <Chip label="Favourites" selected={category === FAVORITES} onPress={() => onCategory(FAVORITES)} />
                {(categories.data ?? []).map((c) => (
                    <Chip
                        key={c.id}
                        label={c.icon ? `${c.icon} ${c.name}` : c.name}
                        selected={category === c.id}
                        onPress={() => onCategory(c.id)}
                    />
                ))}
            </ScrollView>
        </View>
    );
}
