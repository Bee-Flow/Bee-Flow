/**
 * Projects the user owns or has been shared into.
 *
 * `GET /api/projects` answers a BARE array (not `{ projects: [...] }` like most
 * of this API), already ordered by `updated_at DESC`, and every row carries the
 * caller's own `permission` — so the role badge needs no second request.
 *
 * The whole route is gated: requireModule('projects') + requireCapability(
 * 'projects'). A 403 here is a licensing answer and ErrorState says so rather
 * than offering a retry that will fail identically.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { automateKeys, listProjects } from '../../src/features/automate/api';
import type { Project } from '../../src/features/automate/types';
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

export default function ProjectsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const [search, setSearch] = useState('');

    const query = useQuery({
        queryKey: automateKeys.projects,
        queryFn: ({ signal }) => listProjects(signal),
    });

    const items = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const all = query.data ?? [];
        if (!needle) return all;
        return all.filter((project) =>
            `${project.name} ${project.description ?? ''}`.toLowerCase().includes(needle),
        );
    }, [query.data, search]);

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title="Projects"
                subtitle={query.data ? `${query.data.length} you can open` : undefined}
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Search projects" />
            </View>

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : items.length === 0 ? (
                <EmptyState
                    icon="folder"
                    title={query.data?.length ? 'No project matches that' : 'No projects yet'}
                    message={
                        query.data?.length
                            ? 'Try another word.'
                            : 'A project keeps a piece of work together — its chats, its automations, its apps and the people on it.'
                    }
                    actionLabel={query.data?.length ? 'Clear search' : undefined}
                    onAction={query.data?.length ? () => setSearch('') : undefined}
                />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(project) => project.id}
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
                        <ProjectRow
                            project={item}
                            onPress={() => router.push(`/projects/${item.id}`)}
                        />
                    )}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}
        </Screen>
    );
}

function ProjectRow({ project, onPress }: { project: Project; onPress: () => void }) {
    const theme = useTheme();

    return (
        <ListRow
            title={project.name}
            subtitle={project.description || undefined}
            meta={project.updatedAt ? relativeTime(project.updatedAt) : undefined}
            wrapTitle
            leading={
                <View
                    style={{
                        width: 36,
                        height: 36,
                        borderRadius: theme.radii.md,
                        alignItems: 'center',
                        justifyContent: 'center',
                        // The admin picks the colour; it is a hex string on the
                        // row and the only per-project branding there is.
                        backgroundColor: project.color ?? theme.colors.bgTertiary,
                    }}
                >
                    {project.icon ? (
                        <Text variant="body">{project.icon}</Text>
                    ) : (
                        <Feather name="folder" size={16} color={theme.colors.textPrimary} />
                    )}
                </View>
            }
            trailing={
                project.permission && project.permission !== 'owner' ? (
                    <Badge label={project.permission} />
                ) : undefined
            }
            onPress={onPress}
        />
    );
}
