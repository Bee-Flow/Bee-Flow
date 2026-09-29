/**
 * Members and roles.
 *
 * A read screen, searchable, grouped by role. `GET /auth/users` scopes itself
 * to the caller's organisations server-side — a non-super-admin who somehow
 * reaches this list still only sees their own org's people (and the filter is
 * "scope down to self", never "widen to everyone", per the comment in
 * auth/admin/userRoutes.js). So there is nothing here that leaks; the gate
 * below is about not offering a screen that will 403.
 *
 * Deliberately no editing. Creating a user, changing someone's role or
 * resetting their two-factor are irreversible, org-wide and easy to fat-finger
 * on a phone — and each needs context (groups, permissions, licence seats)
 * that does not fit here. The screen says where those live instead of
 * pretending to be a lesser version of them.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import React, { useMemo, useState } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import { listGroups, listOrgMembers, settingsKeys } from '../../src/features/settings/api';
import { humanise } from '../../src/features/settings/format';
import { useIsOrgAdmin } from '../../src/features/settings/permissions';
import type { OrgMember } from '../../src/features/settings/types';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Avatar, Badge } from '../../src/ui/Badge';
import { EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

interface Section {
    title: string;
    data: OrgMember[];
}

/** Role order, most privileged first — the order an admin scans in. */
const ROLE_ORDER = ['admin', 'org_admin', 'manager', 'member', 'user', 'guest'];

export default function OrgMembersScreen() {
    const theme = useTheme();
    const { user } = useAuth();
    const isOrgAdmin = useIsOrgAdmin();
    const [search, setSearch] = useState('');

    const members = useQuery({
        queryKey: settingsKeys.orgMembers,
        queryFn: ({ signal }) => listOrgMembers(signal),
        enabled: isOrgAdmin,
        retry: false,
    });

    const groups = useQuery({
        queryKey: settingsKeys.orgGroups,
        queryFn: ({ signal }) => listGroups(signal),
        enabled: isOrgAdmin,
        retry: false,
        staleTime: 5 * 60_000,
    });

    const sections = useMemo(() => groupByRole(members.data ?? [], search), [members.data, search]);

    if (!isOrgAdmin) {
        return (
            <Screen edges={['top']} inset>
                <ScreenHeader title="Members" />
                <EmptyState
                    icon="users"
                    title="Only administrators can see the roster"
                    message="Your organisation's member list, roles and groups are visible to people with user-management permission. Ask an administrator if you need access."
                />
            </Screen>
        );
    }

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title="Members"
                subtitle={
                    members.data
                        ? `${members.data.length} people${groups.data ? `, ${groups.data.length} groups` : ''}`
                        : undefined
                }
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search by name or email"
                />
            </View>

            {members.isLoading ? (
                <ListSkeleton />
            ) : members.isError ? (
                <ErrorState error={members.error} onRetry={() => void members.refetch()} />
            ) : sections.length === 0 ? (
                <EmptyState
                    icon="users"
                    title={search ? 'Nobody matches that' : 'No members yet'}
                    message={
                        search
                            ? 'Try part of a name or an email address.'
                            : 'People appear here once they accept an invitation.'
                    }
                    actionLabel={search ? 'Clear search' : undefined}
                    onAction={search ? () => setSearch('') : undefined}
                />
            ) : (
                <SectionList
                    sections={sections}
                    keyExtractor={(item) => item.id}
                    stickySectionHeadersEnabled={false}
                    keyboardShouldPersistTaps="handled"
                    refreshControl={
                        <RefreshControl
                            refreshing={members.isRefetching}
                            onRefresh={() => void members.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
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
                            {`${section.title.toUpperCase()} · ${section.data.length}`}
                        </Text>
                    )}
                    renderItem={({ item }) => (
                        <ListRow
                            title={displayName(item)}
                            subtitle={item.email || item.username || item.id}
                            chevron={false}
                            leading={
                                <Avatar
                                    name={displayName(item)}
                                    uri={item.avatar ?? null}
                                    size={38}
                                />
                            }
                            trailing={
                                item.id === user?.id ? (
                                    <Badge label="You" tone="accent" />
                                ) : item.isSystem ? (
                                    <Badge label="System" />
                                ) : undefined
                            }
                        />
                    )}
                    ListFooterComponent={
                        <View
                            style={{
                                padding: theme.spacing.lg,
                                paddingTop: theme.spacing.xl,
                                gap: theme.spacing.sm,
                            }}
                        >
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: theme.spacing.sm,
                                }}
                            >
                                <Feather
                                    name="info"
                                    size={14}
                                    color={theme.colors.textMuted}
                                />
                                <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
                                    Inviting people, changing a role, moving someone between groups
                                    and resetting two-factor are done in the web app. They affect
                                    everyone in the organisation and need the context a phone
                                    cannot show.
                                </Text>
                            </View>
                        </View>
                    }
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}
        </Screen>
    );
}

function displayName(member: OrgMember): string {
    return (
        member.displayName ||
        [member.firstName, member.lastName].filter(Boolean).join(' ').trim() ||
        member.username ||
        member.id
    );
}

/**
 * Group by org role, falling back to the platform role.
 *
 * `orgRole` is the meaningful one inside a company — the platform `role` is
 * 'admin' only for the installation's operator, and grouping by it would put
 * every ordinary colleague in one undifferentiated bucket.
 */
function groupByRole(members: OrgMember[], search: string): Section[] {
    const needle = search.trim().toLowerCase();
    const filtered = needle
        ? members.filter((m) =>
              [displayName(m), m.email, m.username, m.id]
                  .filter((v): v is string => Boolean(v))
                  .some((v) => v.toLowerCase().includes(needle)),
          )
        : members;
    if (filtered.length === 0) return [];

    const buckets = new Map<string, OrgMember[]>();
    for (const member of filtered) {
        const role = (member.orgRole || member.role || 'member').toLowerCase();
        const existing = buckets.get(role);
        if (existing) existing.push(member);
        else buckets.set(role, [member]);
    }

    return [...buckets.entries()]
        .sort(([a], [b]) => {
            const rankA = ROLE_ORDER.indexOf(a);
            const rankB = ROLE_ORDER.indexOf(b);
            // Unknown roles sort after the known ones, then alphabetically —
            // a custom role should not silently jump to the top of the list.
            if (rankA !== rankB) return (rankA < 0 ? 99 : rankA) - (rankB < 0 ? 99 : rankB);
            return a.localeCompare(b);
        })
        .map(([role, data]) => ({
            title: humanise(role),
            data: data.sort((a, b) => displayName(a).localeCompare(displayName(b))),
        }));
}
