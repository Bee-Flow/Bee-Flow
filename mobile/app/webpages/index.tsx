/**
 * Webpages — the pages your organisation has built, and what they are doing.
 *
 * The web app's Webpages surface is an IDE: a file tree, three editors, an AI
 * builder, a live preview iframe. None of that is on this screen and none of
 * it is going to be. A phone is where you find out that the page you published
 * on Tuesday has had eleven views and where you send someone the link — the
 * authoring half stays on the desktop, and the screen says so in one line
 * rather than offering a text editor that nobody would use twice.
 *
 * The list is `GET /api/webpages`, which is audience-scoped: your own pages
 * plus anything published to your organisation or your groups. So a row here
 * is not necessarily yours to change, and the detail screen is where that
 * distinction gets made (the response carries `readOnly`).
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { listWebpages, publishingKeys } from '../../src/features/publishing/api';
import type { Webpage } from '../../src/features/publishing/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Divider } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';

export default function WebpagesScreen() {
    const theme = useTheme();
    const router = useRouter();
    const [search, setSearch] = useState('');

    const query = useQuery({
        queryKey: publishingKeys.webpages,
        queryFn: ({ signal }) => listWebpages(signal),
    });

    const items = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const pages = query.data ?? [];
        if (!needle) return pages;
        return pages.filter((page) =>
            `${page.name} ${page.description} ${page.tagline}`.toLowerCase().includes(needle),
        );
    }, [query.data, search]);

    const publishedCount = (query.data ?? []).filter((page) => page.isPublished).length;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title="Webpages"
                subtitle={
                    query.data
                        ? `${query.data.length} page${query.data.length === 1 ? '' : 's'} · ${publishedCount} published`
                        : undefined
                }
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Search pages" />
            </View>

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : items.length === 0 ? (
                <EmptyState
                    icon="globe"
                    title={search ? 'No page matches that' : 'No pages yet'}
                    message={
                        search
                            ? 'Try another word.'
                            : 'Pages are built in the web app. Once one exists, you can publish it, share its link and see its views from here.'
                    }
                    actionLabel={search ? 'Clear search' : undefined}
                    onAction={search ? () => setSearch('') : undefined}
                />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(page) => page.id}
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
                        <WebpageRow
                            page={item}
                            onPress={() => router.push(`/webpages/${item.id}`)}
                        />
                    )}
                    ListFooterComponent={
                        <Text
                            variant="caption"
                            tone="tertiary"
                            center
                            style={{ padding: theme.spacing.xl }}
                        >
                            Editing a page happens in the web app on a desktop.
                        </Text>
                    }
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}
        </Screen>
    );
}

function WebpageRow({ page, onPress }: { page: Webpage; onPress: () => void }) {
    const theme = useTheme();
    // A page whose three slots are all empty has been created but never built.
    // That is a different thing from an unpublished draft, and the row that
    // does not say so sends people looking for content that was never written.
    const empty = page.htmlSize + page.cssSize + page.jsSize === 0;

    return (
        <ListRow
            title={page.name || 'Untitled page'}
            subtitle={page.tagline || page.description || undefined}
            meta={relativeTime(page.updatedAt)}
            wrapTitle
            leading={
                <View
                    style={{
                        width: 36,
                        height: 36,
                        borderRadius: theme.radii.md,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: page.accentColor || theme.colors.bgTertiary,
                    }}
                >
                    {page.icon ? (
                        <Text variant="body">{page.icon}</Text>
                    ) : (
                        <Feather name="globe" size={16} color={theme.colors.textPrimary} />
                    )}
                </View>
            }
            trailing={
                page.isPublished ? (
                    <Badge label="Published" tone="success" />
                ) : empty ? (
                    <Badge label="Empty" tone="neutral" />
                ) : (
                    <Badge label="Draft" tone="neutral" />
                )
            }
            onPress={onPress}
        />
    );
}
