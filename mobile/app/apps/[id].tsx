/**
 * Running one Studio app.
 *
 * An app is a form and a result — which is the one shape a phone is better at
 * than a desktop, so this screen is a real runner rather than a link to one.
 *
 * What it renders is the honest subset described in appDefinition.ts:
 * headings, text, callouts, stats with static values, forms made of the six
 * core input types, and buttons wired to a `run_automation` action — which is
 * exactly the set the server's run bridge will accept. Everything else (data
 * grids, kanban boards, charts, the live browser view, multi-step sequences)
 * is named at the bottom of the screen instead of being faked.
 *
 * Non-owners always run the frozen published definition; that is the server's
 * rule, not a mobile simplification, and it means what you fill in here is the
 * same form your colleague on the desktop sees.
 */

import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { ApiError } from '../../src/api/client';
import { automateKeys, getAppRuntime } from '../../src/features/automate/api';
import { navigableScreens, planScreen } from '../../src/features/automate/appDefinition';
import { AppRunner } from '../../src/features/automate/components/AppRunner';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Chip } from '../../src/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '../../src/ui/Feedback';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

export default function AppDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const theme = useTheme();
    const [screenId, setScreenId] = useState<string | null>(null);

    const runtime = useQuery({
        queryKey: automateKeys.appRuntime(id),
        queryFn: ({ signal }) => getAppRuntime(id, signal),
        enabled: Boolean(id),
        // An app's definition only changes when its owner republishes, and a
        // refetch mid-form would reset half-typed answers.
        staleTime: 5 * 60_000,
    });

    const definition = runtime.data?.definition ?? null;

    const screens = useMemo(
        () => (definition ? navigableScreens(definition) : []),
        [definition],
    );

    // The viewer's role decides what they may see. The server enforces it on
    // every action (studioAppRunGate), and until now the phone fetched this
    // field and never read it — so role-gated content was drawn, and a
    // role-gated button looked available and answered 403 on tap.
    const viewerRole = runtime.data?.viewer?.roleKey ?? null;

    const plan = useMemo(
        () => (definition ? planScreen(definition, screenId, viewerRole) : null),
        [definition, screenId, viewerRole],
    );

    if (runtime.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="App" />
                <LoadingState label="Loading the app" />
            </Screen>
        );
    }

    if (runtime.isError || !runtime.data || !plan) {
        // A 404 here means "not published, or not for you" — the server never
        // distinguishes the two, and neither should this screen.
        //
        // But the sentence that reached the user was the generic one from
        // describeError: "This item no longer exists", with the retry button
        // suppressed because a 404 is normally permanent. Here it very often is
        // not — the owner unpublished the app while it sat in your list, and
        // republishing brings it straight back. So this case gets its own
        // wording and keeps its retry, and the screen's intended message
        // finally fires instead of being shadowed.
        const notFound = runtime.error instanceof ApiError && runtime.error.status === 404;
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="App" />
                <ErrorState
                    error={
                        notFound
                            ? new Error(
                                  'This app is not published, or is not shared with you. If it was just unpublished, try again once it is back.',
                              )
                            : (runtime.error ?? new Error('This app is not available to you.'))
                    }
                    onRetry={() => void runtime.refetch()}
                />
            </Screen>
        );
    }

    const app = runtime.data;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={app.name}
                subtitle={plan.screen?.name ?? undefined}
            />

            {screens.length > 1 ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{
                        gap: theme.spacing.sm,
                        paddingHorizontal: theme.spacing.lg,
                        paddingBottom: theme.spacing.sm,
                    }}
                >
                    {screens.map((screen) => (
                        <Chip
                            key={screen.id}
                            label={screen.name ?? 'Screen'}
                            selected={(screenId ?? plan.screen?.id) === screen.id}
                            onPress={() => setScreenId(screen.id)}
                        />
                    ))}
                </ScrollView>
            ) : null}

            <ScrollView
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.lg,
                }}
                keyboardShouldPersistTaps="handled"
                refreshControl={
                    <RefreshControl
                        refreshing={runtime.isRefetching}
                        onRefresh={() => void runtime.refetch()}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                {plan.blocks.length === 0 ? (
                    <EmptyState
                        icon="monitor"
                        title="Nothing to fill in here"
                        message={
                            plan.unsupported.length > 0
                                ? `This screen is built from ${plan.unsupported.join(', ')} — parts the phone cannot draw. Open the app in a browser to use it.`
                                : 'This screen has no form or button on it.'
                        }
                    />
                ) : (
                    <AppRunner appId={app.id} plan={plan} />
                )}

                {app.appVersion !== null ? (
                    <View style={{ paddingTop: theme.spacing.sm }}>
                        <Text variant="label" tone="tertiary">
                            {`Published version ${app.appVersion}${app.draft ? ' · draft preview' : ''}`}
                        </Text>
                    </View>
                ) : null}
            </ScrollView>
        </Screen>
    );
}
