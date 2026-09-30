/**
 * Running one Studio app.
 *
 * An app is a form and a result — which is the one shape a phone is better at
 * than a desktop, so this screen is a real runner rather than a link to one.
 * What it renders is the honest subset described in model/appDefinition.ts;
 * everything else is named at the bottom of the screen instead of being faked.
 *
 * Non-owners always run the frozen published definition; that is the server's
 * rule, not a mobile simplification, and it means what you fill in here is the
 * same form your colleague on the desktop sees.
 */

import React, { useMemo, useState } from 'react';

import { useUserRefresh } from '@/shared/patterns';
import { LoadingState, Screen, ScreenHeader } from '@/shared/ui';

import { AppBody } from '../components/AppBody';
import { AppScreenChips } from '../components/AppScreenChips';
import { AppUnavailable } from '../components/AppUnavailable';
import { useAppRuntime } from '../hooks/queries';
import { navigableScreens, planScreen } from '../model/appDefinition';

export function AppDetailScreen({ id, draft = false }: { id: string; draft?: boolean }) {
    const [screenId, setScreenId] = useState<string | null>(null);
    const runtime = useAppRuntime(id, draft);
    const refresh = useUserRefresh(() => runtime.refetch());
    const definition = runtime.data?.definition ?? null;

    const screens = useMemo(() => (definition ? navigableScreens(definition) : []), [definition]);

    // The viewer's role decides what they may see. The server enforces it on
    // every action (studioAppRunGate), and until the phone read this field,
    // role-gated content was drawn and a role-gated button answered 403 on tap.
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
        return <AppUnavailable error={runtime.error} onRetry={() => void runtime.refetch()} />;
    }

    const app = runtime.data;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title={app.name} subtitle={plan.screen?.name ?? undefined} />

            <AppScreenChips
                screens={screens}
                selectedId={screenId ?? plan.screen?.id}
                onSelect={setScreenId}
            />

            <AppBody
                app={app}
                plan={plan}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
            />
        </Screen>
    );
}
