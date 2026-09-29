/**
 * Language.
 *
 * Two different things share this screen and the copy keeps them apart,
 * because conflating them is the reason language settings confuse people:
 *
 *   1. The language of the APP's own words. That now follows the same rule the
 *      web app follows — an explicit choice, else the organisation's default
 *      language, else the phone's — and the strings come from the SERVER's
 *      catalogue (`/api/languages/user/strings/<locale>`), so a string your
 *      administrator translated once shows up in the browser and here.
 *      Screens not yet converted still render their English literals: every
 *      lookup carries the English text as its fallback, so a partly translated
 *      app is a working app rather than a blank one.
 *   2. The language Bee Flow WRITES in — summaries, meeting notes, agent
 *      replies, the emails your workspace sends. That is a workspace setting
 *      with a per-person preference on top, and it is what the list below is.
 *
 * The list comes from `/api/languages/user/locales`, which returns only the
 * locales an administrator has actually added, each annotated with
 * `isOrgDefault`. Offering languages the server has no strings for would be
 * offering a 404.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { getLocales } from 'expo-localization';
import React, { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { listLocales, settingsKeys } from '../../src/features/settings/api';
import { loadLocalePreference, saveLocalePreference } from '../../src/features/settings/preferences';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { OptionRow } from '../../src/ui/Controls';
import { ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

export default function LanguageScreen() {
    const theme = useTheme();
    const [preference, setPreference] = useState<string | null>(null);
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        void loadLocalePreference().then((code) => {
            setPreference(code);
            setHydrated(true);
        });
    }, []);

    const locales = useQuery({
        queryKey: settingsKeys.locales,
        queryFn: ({ signal }) => listLocales(signal),
        staleTime: 10 * 60_000,
    });

    const choose = (code: string | null) => {
        setPreference(code);
        void saveLocalePreference(code);
    };

    const deviceLocale = getLocales()[0];
    const deviceName = deviceLocale
        ? `${deviceLocale.languageCode ?? '—'}${deviceLocale.regionCode ? `-${deviceLocale.regionCode}` : ''}`
        : 'Unknown';

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Language" />

            <ScrollView
                refreshControl={
                    <RefreshControl
                        refreshing={locales.isRefetching}
                        onRefresh={() => void locales.refetch()}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <Group title="This phone">
                    <InfoRow label="System language" value={deviceName} />
                    <NoteRow>
                        Bee Flow for Android follows Android&rsquo;s own language for dates and
                        numbers. Its own text is English in this release; the web app has the full
                        translated interface.
                    </NoteRow>
                </Group>

                <Group
                    title="Language Bee Flow writes in"
                    footer="Applies to summaries, meeting notes and what your agents reply in. Stored on this phone, the same way the web app stores it in your browser — Bee Flow has no per-account language column to sync to."
                >
                    <OptionRow
                        label="Follow my phone"
                        description={`Currently ${deviceName}`}
                        selected={preference === null}
                        onPress={() => choose(null)}
                        leading={
                            <Feather name="smartphone" size={16} color={theme.colors.textSecondary} />
                        }
                    />
                </Group>

                {locales.isLoading || !hydrated ? (
                    <ListSkeleton rows={4} />
                ) : locales.isError ? (
                    <ErrorState error={locales.error} onRetry={() => void locales.refetch()} />
                ) : locales.data && locales.data.length > 0 ? (
                    <Group
                        title="Available in your workspace"
                        footer="Only languages an administrator has added appear here."
                    >
                        {locales.data.map((locale) => (
                            <OptionRow
                                key={locale.code}
                                label={locale.name || locale.code}
                                description={locale.code}
                                selected={preference === locale.code}
                                onPress={() => choose(locale.code)}
                                leading={
                                    locale.isOrgDefault ? (
                                        <Badge label="Default" tone="accent" />
                                    ) : (
                                        <View style={{ width: 0 }} />
                                    )
                                }
                            />
                        ))}
                    </Group>
                ) : (
                    <Group title="Available in your workspace">
                        <NoteRow>
                            <Text variant="caption" tone="tertiary">
                                Your administrator has not added any languages, so Bee Flow uses its
                                built-in defaults.
                            </Text>
                        </NoteRow>
                    </Group>
                )}
            </ScrollView>
        </Screen>
    );
}
