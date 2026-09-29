/**
 * Forms — every hosted form your organisation has published.
 *
 * A form here is the front door of a routine: `GET /api/automation/forms`
 * walks the form pages, finds the form trigger inside each routine's
 * definition, and returns one row per form with its address, its state and how
 * many submissions it has taken. This screen is the whole of what a phone
 * should do with that — see which forms are open, and get to their answers.
 *
 * It is NOT a form builder, for the same reason the Apps screen is not App
 * Studio: the fields, the branching and the routine behind them are built in
 * the web app, and a builder squeezed onto a phone would be a worse version of
 * something that already exists.
 *
 * The list is org-scoped on purpose — a published form has an address, and an
 * address belongs to the organisation rather than to whoever typed it. So rows
 * for colleagues' forms appear here, marked, and their submissions do not:
 * every automation endpoint below this list is still per-user.
 */

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { listForms, publishingKeys } from '../../src/features/publishing/api';
import type { FormSummary } from '../../src/features/publishing/types';
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

export default function FormsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const [search, setSearch] = useState('');

    const query = useQuery({
        queryKey: publishingKeys.forms,
        queryFn: ({ signal }) => listForms(signal),
    });

    const items = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const forms = query.data ?? [];
        if (!needle) return forms;
        return forms.filter((form) =>
            `${form.title} ${form.description ?? ''}`.toLowerCase().includes(needle),
        );
    }, [query.data, search]);

    const openCount = (query.data ?? []).filter((form) => form.live).length;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title="Forms"
                subtitle={
                    query.data
                        ? `${query.data.length} form${query.data.length === 1 ? '' : 's'} · ${openCount} open`
                        : undefined
                }
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Search forms" />
            </View>

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : items.length === 0 ? (
                <EmptyState
                    icon="file-text"
                    title={search ? 'No form matches that' : 'No forms yet'}
                    message={
                        search
                            ? 'Try another word.'
                            : 'A form is the front door of a routine, built in the web app. Once one is published you can share its link and read its answers from here.'
                    }
                    actionLabel={search ? 'Clear search' : 'See routines'}
                    onAction={search ? () => setSearch('') : () => router.push('/automations')}
                />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(form) => form.id}
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
                        <FormRow form={item} onPress={() => router.push(`/forms/${item.id}`)} />
                    )}
                    ListFooterComponent={
                        <Text
                            variant="caption"
                            tone="tertiary"
                            center
                            style={{ padding: theme.spacing.xl }}
                        >
                            Building a form happens in the web app on a desktop.
                        </Text>
                    }
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}
        </Screen>
    );
}

function FormRow({ form, onPress }: { form: FormSummary; onPress: () => void }) {
    const submissions =
        form.submissions === 1 ? '1 submission' : `${form.submissions} submissions`;
    // lastSeenAt is stamped on every accepted submission, so it is the honest
    // "is anyone actually using this" signal — more useful in a list than the
    // creation date, which never changes.
    const subtitle = form.lastSeenAt
        ? `${submissions} · last ${relativeTime(form.lastSeenAt)}`
        : submissions;

    return (
        <ListRow
            title={form.title}
            subtitle={subtitle}
            wrapTitle
            trailing={
                <Badge
                    label={form.live ? 'Open' : 'Closed'}
                    tone={form.live ? 'success' : 'neutral'}
                />
            }
            onPress={onPress}
        />
    );
}
