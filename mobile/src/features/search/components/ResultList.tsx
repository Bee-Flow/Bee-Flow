/**
 * The grouped results. Two props here are the point of the screen: a result
 * stays tappable while the keyboard is up (`keyboardShouldPersistTaps`), and
 * scrolling the results does not dismiss it (`keyboardDismissMode="none"`) —
 * refining a query after glancing at the answers is the normal path.
 */

import React from 'react';
import { RefreshControl, SectionList, StyleSheet } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { GroupHeader } from './GroupHeader';
import { HitRow } from './HitRow';
import type { ResultSection } from '../hooks/useSearch';
import type { SearchHit } from '../model/types';

const makeStyles = (theme: Theme) => StyleSheet.create({ content: { paddingBottom: theme.spacing.xxl } });

const keyOf = (hit: SearchHit) => hit.key;

export function ResultList({
    sections,
    refreshing,
    onRefresh,
    onOpen,
}: {
    sections: ResultSection[];
    refreshing: boolean;
    onRefresh: () => void;
    onOpen: (hit: SearchHit) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <SectionList<SearchHit, ResultSection>
            sections={sections}
            keyExtractor={keyOf}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="none"
            stickySectionHeadersEnabled={false}
            contentContainerStyle={styles.content}
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            renderSectionHeader={({ section }) => <GroupHeader section={section} />}
            renderItem={({ item }) => <HitRow hit={item} onPress={onOpen} />}
        />
    );
}
