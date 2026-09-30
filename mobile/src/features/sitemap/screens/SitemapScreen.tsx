/**
 * Everything Bee Flow does — the whole map, A to Z.
 *
 * The drawer mirrors the web's sidebar and the tabs carry the four things a
 * phone is for, so neither lists everything: Settings children, Library,
 * Memory, MCP and the rest live one level down. That leaves a question the
 * navigation cannot answer — "does this app even have X?" — short of guessing
 * a search term.
 *
 * This is that place. Flat, alphabetical, filterable, and gated by the same
 * core/access verdicts as the drawer. It is NOT a second navigation: it sits
 * behind one item in the drawer's profile menu, for the times when browsing
 * has failed and searching has not occurred to you.
 */

import React, { useMemo, useState } from 'react';
import { SectionList, StyleSheet, View, type SectionListRenderItem } from 'react-native';

import { useAccess } from '@/core/access';
import { useLocale, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, Screen, ScreenHeader, SearchField } from '@/shared/ui';

import { SectionTitle } from '../components/SectionTitle';
import { SitemapRow } from '../components/SitemapRow';
import { alphabetSections, translatedLabel, visibleDestinations, type LetterSection } from '../model/sections';
import type { Destination } from '../nav/types';

const renderItem: SectionListRenderItem<Destination, LetterSection> = ({ item }) => (
    <SitemapRow destination={item} />
);

const keyOf = (item: Destination) => item.id;

export function SitemapScreen() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    // `t` never changes identity, so the catalogue itself is the dependency:
    // the map re-sorts when the language (or its strings) arrive.
    const i18n = useLocale();
    const access = useAccess();
    const [search, setSearch] = useState('');

    const sections = useMemo(
        () => alphabetSections(visibleDestinations(access, search, t), translatedLabel(t), i18n.locale),
        [access, search, t, i18n],
    );

    return (
        <Screen edges={['top']}>
            <ScreenHeader title={t('mobile.sitemap.title', 'Everything Bee Flow does')} showBack />

            <View style={styles.searchBar}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder={t('mobile.sitemap.filter', 'Filter this list')}
                />
            </View>

            {sections.length === 0 ? (
                <EmptyState
                    icon="Compass"
                    title={t('mobile.sitemap.no_match_title', 'Nothing matches')}
                    message={t(
                        'mobile.sitemap.no_match_message',
                        'Try a shorter word — this list matches names, descriptions and keywords.',
                    )}
                />
            ) : (
                <SectionList
                    sections={sections}
                    keyExtractor={keyOf}
                    stickySectionHeadersEnabled={false}
                    contentContainerStyle={styles.content}
                    renderSectionHeader={({ section }) => (
                        <SectionTitle title={section.title} inset />
                    )}
                    renderItem={renderItem}
                />
            )}
        </Screen>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        searchBar: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        content: { paddingBottom: theme.spacing.xxxl },
    });
