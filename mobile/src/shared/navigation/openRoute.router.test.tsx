/**
 * openRoute against the real router, in the app's shape: a root Stack holding
 * a (drawer) group whose tabs are the drawer's screens, and a screen pushed
 * over it. The failure this pins is a SECOND (drawer) on the root Stack — what
 * push and navigate both produce for a tab address from a pushed screen.
 */

import { router, Stack, Tabs } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import React from 'react';
import { Text } from 'react-native';

import { openRoute } from './openRoute';

jest.setTimeout(60_000);

const page = (name: string) =>
    function Page() {
        return <Text>{name}</Text>;
    };

// The router's own state; `renderRouter`'s helpers are lost to the async render.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = () => require('expo-router/build/global-state/router-store').store;

interface RouteState {
    routes: { name: string; state?: RouteState }[];
}

/** The root Stack's routes (under expo-router's own `__root`). */
function rootRoutes(): string[] {
    const outer = store().state as RouteState;
    return (outer.routes[0]?.state?.routes ?? []).map((r) => r.name);
}

async function mountApp() {
    await renderRouter(
        {
            _layout: () => <Stack screenOptions={{ headerShown: false }} />,
            '(drawer)/_layout': () => <Stack screenOptions={{ headerShown: false }} />,
            '(drawer)/(tabs)/_layout': () => <Tabs />,
            '(drawer)/(tabs)/index': page('home'),
            '(drawer)/(tabs)/studio': page('studio'),
            notifications: page('notifications'),
        },
        { initialUrl: '/' },
    );
}

describe('openRoute on the real router', () => {
    it('returns to the one drawer from a pushed screen, where push would stack another', async () => {
        await mountApp();
        await act(async () => router.push('/notifications'));
        expect(rootRoutes()).toEqual(['(drawer)', 'notifications']);
        await act(async () => openRoute(router, '/studio'));
        expect(rootRoutes()).toEqual(['(drawer)']);
        expect(store().getRouteInfo().pathname).toBe('/studio');
    });

    it('switches the tab from inside the drawer', async () => {
        await mountApp();
        await act(async () => openRoute(router, '/studio'));
        expect(store().getRouteInfo().pathname).toBe('/studio');
        expect(rootRoutes().filter((name) => name === '(drawer)')).toHaveLength(1);
    });

    it('pushes a screen over the drawer', async () => {
        await mountApp();
        await act(async () => openRoute(router, '/notifications'));
        expect(rootRoutes()).toEqual(['(drawer)', 'notifications']);
    });
});
