/**
 * More — the complete sitemap.
 *
 * Four tabs cannot carry a product with thirty destinations, so this is the
 * other twenty-six. The rule it holds itself to: every Bee Flow feature is
 * reachable from this screen. A feature that exists in the app and cannot be
 * found here is a bug in src/features/settings/sitemap.ts, which is where the
 * list lives so that it can be filtered and gated in one place instead of
 * three.
 *
 * Searchable, because a grouped list of twenty-six rows is a directory and
 * nobody reads a directory — they look for the one word they came with. The
 * search matches hidden keywords too ("gdpr" finds Privacy, "2fa" finds
 * Security), which is the difference between a search box and a filter.
 */

import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useMemo, useState } from 'react';
import { Alert, SectionList, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import {
    DESTINATIONS,
    GROUP_ORDER,
    isReachable,
    matchesSearch,
    type Destination,
    type SitemapGroup,
} from '../../src/features/settings/sitemap';
import { useTranslation } from '../../src/i18n';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Avatar } from '../../src/ui/Badge';
import { EmptyState } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Card } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';

interface Section {
    title: SitemapGroup;
    data: Destination[];
}

export default function MoreScreen() {
    const theme = useTheme();
    const router = useRouter();
    const { user, permissions, signOut, busy } = useAuth();
    const t = useTranslation();
    const [search, setSearch] = useState('');

    const searching = search.trim().length > 0;

    const allowed = useMemo(
        () =>
            DESTINATIONS.filter(
                (d) =>
                    isReachable(d, permissions?.permissions ?? null, Boolean(user?.isAdmin)) &&
                    matchesSearch(d, search, t),
            ),
        [permissions, user?.isAdmin, search, t],
    );

    /**
     * The six shortcuts at the top.
     *
     * Not while searching: a search is a request for a flat answer, and a grid
     * above the results would put six rows the user did not ask about between
     * them and the one they did.
     */
    const primary = useMemo(
        () => (searching ? [] : allowed.filter((d) => d.weight === 'primary')),
        [allowed, searching],
    );

    const sections = useMemo<Section[]>(() => {
        // `hidden` rows are filtered out of the RENDERED list only — they stay
        // in `allowed`, so a search still finds them. That is the whole point:
        // typing "transcribe" must still reach Record even though Record is a
        // tab you can see from here.
        const listed = allowed.filter((d) =>
            searching ? true : d.weight !== 'hidden' && d.weight !== 'primary',
        );
        return GROUP_ORDER.map((title) => ({
            title,
            data: listed.filter((d) => d.group === title),
        })).filter((section) => section.data.length > 0);
    }, [allowed, searching]);

    const open = (destination: Destination) => {
        if (destination.external) {
            // openBrowserAsync, not Linking: a Custom Tab keeps the user inside
            // Bee Flow's task stack, so "back" returns here rather than to
            // whatever Chrome had open last.
            void WebBrowser.openBrowserAsync(destination.href);
            return;
        }
        // A sibling TAB is switched to, not pushed. `push` would stack a second
        // copy of the tab navigator on top of this one, so the back button
        // would return to More instead of leaving the app — and the tab bar
        // would highlight the wrong tab underneath.
        if (destination.href.startsWith('/(tabs)')) router.navigate(destination.href);
        else router.push(destination.href);
    };

    const confirmSignOut = () => {
        Alert.alert(
            'Sign out?',
            'Your encryption key is removed from this device. Anything you have not sent is lost.',
            [
                { text: 'Stay signed in', style: 'cancel' },
                { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
            ],
        );
    };

    return (
        <Screen edges={['top']}>
            <ScreenHeader size="large" title="More" />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search everything Bee Flow does"
                />
            </View>

            <SectionList
                sections={sections}
                keyExtractor={(item) => item.id}
                stickySectionHeadersEnabled={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    // NO `gap`. It was 8px, applied between every item in the
                    // list — including between rows of the SAME group — which
                    // defeated the shared-card trick below and made a grouped
                    // directory render as thirty separate slabs. Separation
                    // between sections comes from the section header's own top
                    // padding, which is the only place it should.
                }}
                // The account card is part of the scrolling content rather than
                // pinned: on a search it is noise, and it disappears with the
                // rest of the list instead of hovering over four results.
                ListHeaderComponent={
                    searching ? null : (
                        <>
                            <AccountCard
                                name={user?.displayName ?? 'Your account'}
                                detail={accountDetail(user)}
                                avatar={user?.avatar ?? null}
                                onPress={() => router.push('/settings/account')}
                            />
                            {/*
                              * Six shortcuts, two columns. The list below is a
                              * directory and reads like one; these are the
                              * destinations people open More in order to reach,
                              * and a directory that makes you read 37 equal rows
                              * to find one of six is a directory that has given
                              * up on ranking.
                              */}
                            {primary.length ? (
                                <View
                                    style={{
                                        flexDirection: 'row',
                                        flexWrap: 'wrap',
                                        gap: theme.spacing.sm,
                                        marginTop: theme.spacing.sm,
                                    }}
                                >
                                    {primary.map((d) => (
                                        <Card
                                            key={d.id}
                                            padded={false}
                                            onPress={() => open(d)}
                                            accessibilityLabel={d.label}
                                            accessibilityHint={d.hint}
                                            style={{
                                                // Two per row, sharing the gap.
                                                width: '48%',
                                                flexGrow: 1,
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: theme.spacing.xs,
                                                paddingVertical: theme.spacing.lg,
                                            }}
                                        >
                                            <Feather
                                                name={d.icon}
                                                size={20}
                                                color={theme.colors.accentText}
                                            />
                                            <Text variant="caption" weight="medium" center>
                                                {d.label}
                                            </Text>
                                        </Card>
                                    ))}
                                </View>
                            ) : null}
                        </>
                    )
                }
                ListEmptyComponent={
                    <EmptyState
                        icon="search"
                        title="Nothing matches that"
                        message="Try a shorter word — the search looks at what each screen does, not just its name."
                        actionLabel="Clear search"
                        onAction={() => setSearch('')}
                    />
                }
                renderSectionHeader={({ section }) => (
                    <Text
                        variant="label"
                        tone="tertiary"
                        style={{
                            paddingTop: theme.spacing.lg,
                            paddingBottom: theme.spacing.xs,
                            paddingHorizontal: theme.spacing.xs,
                        }}
                    >
                        {section.title.toUpperCase()}
                    </Text>
                )}
                renderItem={({ item, index, section }) => (
                    <Card
                        padded={false}
                        style={{
                            // The rows within a group share one card, which is
                            // what makes a group read as a group. Rounding only
                            // the outer corners is the cheapest way to get that
                            // without a wrapper per section.
                            borderTopLeftRadius: index === 0 ? theme.radii.lg : 0,
                            borderTopRightRadius: index === 0 ? theme.radii.lg : 0,
                            borderBottomLeftRadius:
                                index === section.data.length - 1 ? theme.radii.lg : 0,
                            borderBottomRightRadius:
                                index === section.data.length - 1 ? theme.radii.lg : 0,
                            borderTopWidth: index === 0 ? undefined : 0,
                        }}
                    >
                        <ListRow
                            title={item.label}
                            subtitle={item.hint}
                            onPress={() => open(item)}
                            leading={
                                <View
                                    style={{
                                        width: 34,
                                        height: 34,
                                        borderRadius: theme.radii.sm,
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        backgroundColor: theme.colors.bgTertiary,
                                    }}
                                >
                                    <Feather
                                        name={item.icon}
                                        size={16}
                                        color={theme.colors.textSecondary}
                                    />
                                </View>
                            }
                            trailing={
                                item.external ? (
                                    <Feather
                                        name="external-link"
                                        size={16}
                                        color={theme.colors.textMuted}
                                    />
                                ) : undefined
                            }
                        />
                    </Card>
                )}
                ListFooterComponent={
                    search.trim() ? null : (
                        <View style={{ paddingTop: theme.spacing.xl, gap: theme.spacing.lg }}>
                            {/*
                              * The complete map, for when browsing has failed
                              * and searching has not occurred to you. This
                              * directory hides twelve rows that duplicate a tab
                              * or live inside Settings — right for a list you
                              * browse, and it left nowhere that answered "does
                              * this app even have X?".
                              */}
                            <Card padded={false}>
                                <ListRow
                                    title="Everything Bee Flow does"
                                    subtitle="The whole map, A to Z"
                                    onPress={() => router.push('/sitemap')}
                                    leading={
                                        <Feather
                                            name="compass"
                                            size={18}
                                            color={theme.colors.textMuted}
                                        />
                                    }
                                />
                            </Card>

                            <Card padded={false}>
                                <ListRow
                                    title="Sign out"
                                    subtitle="Removes your encryption key from this device"
                                    disabled={busy}
                                    chevron={false}
                                    onPress={confirmSignOut}
                                    leading={
                                        <View
                                            style={{
                                                width: 34,
                                                height: 34,
                                                borderRadius: theme.radii.sm,
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                backgroundColor: theme.colors.bgTertiary,
                                            }}
                                        >
                                            <Feather
                                                name="log-out"
                                                size={16}
                                                color={theme.colors.error}
                                            />
                                        </View>
                                    }
                                />
                            </Card>
                        </View>
                    )
                }
            />
        </Screen>
    );
}

function AccountCard({
    name,
    detail,
    avatar,
    onPress,
}: {
    name: string;
    detail: string;
    avatar: string | null;
    onPress: () => void;
}) {
    const theme = useTheme();
    return (
        <Card onPress={onPress} accessibilityLabel={`${name}. ${detail}. Open account settings`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
                <Avatar name={name} uri={avatar} size={48} />
                <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="subheading" numberOfLines={1}>
                        {name}
                    </Text>
                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                        {detail}
                    </Text>
                </View>
                <Feather name="chevron-right" size={18} color={theme.colors.textMuted} />
            </View>
        </Card>
    );
}

/**
 * The one line under the user's name.
 *
 * Email first — it is what identifies the account to the person. Falls back to
 * the org and then to the role, because an SSO account may legitimately have
 * no stored email (the username is the handle).
 */
function accountDetail(user: ReturnType<typeof useAuth>['user']): string {
    if (!user) return 'Not signed in';
    const parts = [user.email, user.organizationId, user.orgRole ?? user.role].filter(
        (part): part is string => Boolean(part),
    );
    return parts[0] ?? 'Signed in';
}
