/**
 * Everything Bee Flow does — the whole map, A to Z.
 *
 * The More tab groups what it renders and deliberately hides twelve rows that
 * duplicate a tab or live inside Settings. That is the right call for a
 * directory somebody browses, and it leaves a gap: there was no single place
 * that listed everything, so "does this app even have X?" had no answer short
 * of guessing a search term.
 *
 * This is that place. Flat, alphabetical, and it includes the `hidden` rows —
 * sitemap.ts says in as many words that hidden means "not rendered, but STILL
 * SEARCHABLE", and a complete map is the other half of that promise.
 *
 * It is NOT a second navigation. It sits behind one row at the bottom of More,
 * for the times when browsing has failed and searching has not occurred to you.
 */

import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Linking, SectionList, View } from 'react-native';

import { useAuth } from '../src/auth/AuthProvider';
import { DESTINATIONS, isReachable, matchesSearch } from '../src/features/settings/sitemap';
import { useTranslation } from '../src/i18n';
import { useTheme } from '../src/theme/ThemeProvider';
import { EmptyState } from '../src/ui/Feedback';
import { SearchField } from '../src/ui/Input';
import { ListRow } from '../src/ui/List';
import { Screen } from '../src/ui/Screen';
import { ScreenHeader } from '../src/ui/ScreenHeader';
import { Text } from '../src/ui/Text';

export default function SitemapScreen() {
    const theme = useTheme();
    const router = useRouter();
    const t = useTranslation();
    const { user, permissions } = useAuth();
    const [search, setSearch] = useState('');

    const sections = useMemo(() => {
        const allowed = DESTINATIONS.filter(
            (d) =>
                isReachable(d, permissions?.permissions ?? null, Boolean(user?.isAdmin)) &&
                matchesSearch(d, search, t),
        ).sort((a, b) => a.label.localeCompare(b.label));

        const byLetter = new Map<string, typeof allowed>();
        for (const d of allowed) {
            const letter = d.label.charAt(0).toUpperCase();
            byLetter.set(letter, [...(byLetter.get(letter) ?? []), d]);
        }
        return [...byLetter.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([title, data]) => ({ title, data }));
    }, [permissions, user?.isAdmin, search, t]);

    return (
        <Screen edges={['top']}>
            <ScreenHeader title="Everything Bee Flow does" showBack />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Filter this list"
                />
            </View>

            {sections.length === 0 ? (
                <EmptyState
                    icon="compass"
                    title="Nothing matches"
                    message="Try a shorter word — this list matches names, descriptions and keywords."
                />
            ) : (
                <SectionList
                    sections={sections}
                    keyExtractor={(item) => item.id}
                    stickySectionHeadersEnabled={false}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}
                    renderSectionHeader={({ section }) => (
                        <Text
                            variant="label"
                            tone="tertiary"
                            style={{
                                paddingHorizontal: theme.spacing.lg,
                                paddingTop: theme.spacing.lg,
                                paddingBottom: theme.spacing.xs,
                            }}
                        >
                            {section.title}
                        </Text>
                    )}
                    renderItem={({ item }) => (
                        <ListRow
                            title={item.i18nKey ? t(item.i18nKey, item.label) : item.label}
                            subtitle={item.hint}
                            leading={
                                <Feather
                                    name={item.icon}
                                    size={18}
                                    color={theme.colors.textMuted}
                                />
                            }
                            trailing={
                                item.external ? (
                                    <Feather
                                        name="external-link"
                                        size={14}
                                        color={theme.colors.textMuted}
                                    />
                                ) : undefined
                            }
                            onPress={() => {
                                if (item.external) void Linking.openURL(item.href);
                                else router.push(item.href as never);
                            }}
                        />
                    )}
                />
            )}
        </Screen>
    );
}
