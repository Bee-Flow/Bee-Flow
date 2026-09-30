/**
 * Search Studio — the web's StudioSearchOverlay as a screen: a name search
 * across the nine Studio kinds (GET /api/studio/search), grouped under the
 * section each kind belongs to.
 *
 * What it must not do is say "no matches" when the truth is "we could not
 * look": a failed request is one line and no empty state, and a partial answer
 * renders what did answer under a line that says the list may be incomplete.
 */

import React from 'react';
import { SectionList, View, type SectionListData, type SectionListRenderItem, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Screen, ScreenHeader, SearchField, SectionLabel, Text } from '@/shared/ui';

import { SearchHitRow } from '../components/SearchHitRow';
import { useStudioSearchState } from '../hooks/useStudioSearchState';
import type { StudioHit } from '../model/api';
import type { SearchGroup, SearchLine } from '../model/search';

interface HitSection {
    key: string;
    title: string;
    group: SearchGroup;
    data: StudioHit[];
}

function lineText(line: SearchLine, query: string, t: TranslateFn): string | null {
    switch (line) {
        case 'failed':
            return t('studio.search.failed', 'Search is unavailable right now — this is not an empty result.');
        case 'partial':
            return t('studio.search.partial', 'Some sources could not be searched — this list may be incomplete.');
        case 'too_short':
            return t('studio.search.min_chars', 'Type at least two characters');
        case 'loading':
            return t('studio.search.loading', 'Searching…');
        case 'empty':
            return t('studio.search.empty', 'No matches for "{q}"', { q: query });
        default:
            return null;
    }
}

const keyOf = (hit: StudioHit) => hit.id;
const renderHit: SectionListRenderItem<StudioHit, HitSection> = ({ item, section }) => (
    <SearchHitRow hit={item} section={section.group.section} />
);
const renderHeading = ({ section }: { section: SectionListData<StudioHit, HitSection> }) => (
    <SectionLabel label={section.title} />
);

export function StudioSearchScreen() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const search = useStudioSearchState();
    const line = lineText(search.line, search.query, t);
    const sections: HitSection[] = search.groups.map((group) => ({
        key: group.kind,
        title: group.section ? t(group.section.labelKey, group.section.labelFallback) : group.kind,
        group,
        data: group.hits,
    }));

    return (
        <Screen edges={['top']}>
            <ScreenHeader title={t('studio.search.title', 'Search Studio')} showBack global={false} />
            <View style={styles.bar}>
                <SearchField
                    value={search.term}
                    onChangeText={search.setTerm}
                    placeholder={t('studio.search.placeholder', 'Search Studio…')}
                    autoFocus
                />
                {line ? (
                    <Text variant="caption" tone={search.line === 'failed' || search.line === 'partial' ? 'secondary' : 'tertiary'} testID="studio-search-line">
                        {line}
                    </Text>
                ) : null}
            </View>
            <SectionList
                sections={sections}
                keyExtractor={keyOf}
                keyboardShouldPersistTaps="handled"
                stickySectionHeadersEnabled={false}
                contentContainerStyle={styles.content}
                renderSectionHeader={renderHeading}
                renderItem={renderHit}
            />
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    bar: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm, gap: theme.spacing[2] } satisfies ViewStyle,
    content: { paddingBottom: theme.spacing.xxxl } satisfies ViewStyle,
});
