/**
 * leaveDeletedChat against the real router, in the app's shape: a root Stack
 * holding the (drawer) and, over it, whatever the chat was opened from, the
 * chat, and its details. What this pins is where a delete lands — on the
 * screen under the chat, with the drawer that was there — and not on a new
 * chat's composer over a drawer rebuilt by `replace`.
 */

import { router, Stack, Tabs, useNavigation } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import React, { useEffect } from 'react';
import { Text } from 'react-native';

import { leaveDeletedChat, type StackEntry } from './deletedChat';

jest.setTimeout(60_000);

const page = (name: string) =>
    function Page() {
        return <Text>{name}</Text>;
    };

// The router's own state; `renderRouter`'s helpers are lost to the async render.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = () => require('expo-router/build/global-state/router-store').store;

interface RouteState {
    routes: { name: string; key?: string; state?: RouteState }[];
}

/** The root Stack's routes (under expo-router's own `__root`). */
function rootRoutes(): string[] {
    const outer = store().state as RouteState;
    return (outer.routes[0]?.state?.routes ?? []).map((r) => r.name);
}

/** What the details screen reads when the delete lands: its own navigator's routes. */
let readStack: () => readonly StackEntry[] = () => [];

function Details() {
    const navigation = useNavigation();
    useEffect(() => {
        readStack = () => navigation.getState()?.routes ?? [];
    });
    return <Text>details</Text>;
}

async function mountApp(initialUrl = '/') {
    await renderRouter(
        {
            _layout: () => <Stack screenOptions={{ headerShown: false }} />,
            '(drawer)/_layout': () => <Stack screenOptions={{ headerShown: false }} />,
            '(drawer)/(tabs)/_layout': () => <Tabs />,
            '(drawer)/(tabs)/index': page('home'),
            '(drawer)/(tabs)/studio': page('studio'),
            'chats/index': page('chats'),
            'chat/[id]': page('chat'),
            'chat/[id]/details': Details,
        },
        { initialUrl },
    );
}

describe('leaving a deleted chat on the real router', () => {
    it('lands on the list the chat was opened from', async () => {
        await mountApp();
        await act(async () => router.push('/chats'));
        await act(async () => router.push('/chat/c1'));
        await act(async () => router.push('/chat/c1/details'));
        expect(rootRoutes()).toEqual(['(drawer)', 'chats/index', 'chat/[id]', 'chat/[id]/details']);

        await act(async () => leaveDeletedChat(router, readStack(), 'c1'));
        expect(rootRoutes()).toEqual(['(drawer)', 'chats/index']);
        expect(store().getRouteInfo().pathname).toBe('/chats');
    });

    it('lands back on the tab the chat was opened over, with the same drawer', async () => {
        await mountApp();
        await act(async () => router.navigate('/studio'));
        const drawer = (store().state as RouteState).routes[0]?.state?.routes[0]?.key;
        await act(async () => router.push('/chat/c1'));
        await act(async () => router.push('/chat/c1/details'));

        await act(async () => leaveDeletedChat(router, readStack(), 'c1'));
        expect(rootRoutes()).toEqual(['(drawer)']);
        expect((store().state as RouteState).routes[0]?.state?.routes[0]?.key).toBe(drawer);
        expect(store().getRouteInfo().pathname).toBe('/studio');
    });

    it('replaces a chat with nothing under it (a cold start from a notification) by the Chat tab', async () => {
        await mountApp('/chat/c1');
        await act(async () => router.push('/chat/c1/details'));
        expect(rootRoutes()).toEqual(['chat/[id]', 'chat/[id]/details']);

        await act(async () => leaveDeletedChat(router, readStack(), 'c1'));
        expect(rootRoutes()).toEqual(['(drawer)']);
        expect(store().getRouteInfo().pathname).toBe('/');
    });
});
