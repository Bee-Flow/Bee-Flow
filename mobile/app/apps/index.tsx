/**
 * Studio apps you can run.
 *
 * `GET /api/studio-apps` lists the apps the caller's org and groups let them
 * see, meta only — the component tree comes later, from /runtime, which is
 * also where the audience gate is actually enforced.
 *
 * Two things this screen deliberately does NOT show:
 *
 *   - The App Marketplace (`/apps` on the server, `appStore`). Those "apps" are
 *     HTML and JavaScript that the web client renders in a sandboxed iframe.
 *     There is no honest way to run them natively, and the dishonest way is a
 *     WebView, which this app does not have and is not getting.
 *   - Drafts. An unpublished app answers 404 from /runtime for everyone but its
 *     owner, so listing one would be offering a door that does not open.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { automateKeys, listStudioApps } from '../../src/features/automate/api';
import type { StudioAppMeta } from '../../src/features/automate/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Divider } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';

export default function AppsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const [search, setSearch] = useState('');

    const query = useQuery({
        queryKey: automateKeys.apps,
        queryFn: ({ signal }) => listStudioApps(signal),
    });

    const items = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const published = (query.data ?? []).filter((app) => app.isPublished);
        if (!needle) return published;
        return published.filter((app) =>
            `${app.name} ${app.description}`.toLowerCase().includes(needle),
        );
    }, [query.data, search]);

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title="Apps"
                subtitle={items.length ? `${items.length} you can run` : undefined}
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Search apps" />
            </View>

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : items.length === 0 ? (
                <EmptyState
                    icon="layout"
                    title={search ? 'No app matches that' : 'No published apps'}
                    message={
                        search
                            ? 'Try another word.'
                            : 'Apps are built in App Studio on the desktop. Once one is published, you can fill in its form and run it from here.'
                    }
                    actionLabel={search ? 'Clear search' : undefined}
                    onAction={search ? () => setSearch('') : undefined}
                />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(app) => app.id}
                    ItemSeparatorComponent={() => <Divider inset={theme.spacing.lg} />}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderItem={({ item }) => (
                        <AppRow app={item} onPress={() => router.push(`/apps/${item.id}`)} />
                    )}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}
        </Screen>
    );
}

function AppRow({ app, onPress }: { app: StudioAppMeta; onPress: () => void }) {
    const theme = useTheme();
    return (
        <ListRow
            title={app.name}
            subtitle={app.description || undefined}
            meta={app.publishedAt ? relativeTime(app.publishedAt) : undefined}
            wrapTitle
            leading={
                <View
                    style={{
                        width: 36,
                        height: 36,
                        borderRadius: theme.radii.md,
                        alignItems: 'center',
                        justifyContent: 'center',
                        // `accentColor` is the app's own brand colour, set by
                        // its author; falling back to the surface keeps an
                        // unbranded app from looking broken.
                        backgroundColor: app.accentColor ?? theme.colors.bgTertiary,
                    }}
                >
                    {app.icon ? (
                        <Text variant="body">{app.icon}</Text>
                    ) : (
                        <Feather name="layout" size={16} color={theme.colors.textPrimary} />
                    )}
                </View>
            }
            onPress={onPress}
        />
    );
}
