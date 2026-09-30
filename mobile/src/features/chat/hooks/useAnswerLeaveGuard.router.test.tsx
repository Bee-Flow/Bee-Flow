/**
 * The leave guard on the real router: the details screen's delete pops itself
 * and the chat under it (router.dismiss(2)) while that chat is still
 * answering. The guard holds that pop for a conversation that still exists,
 * and lets it through for the one just deleted.
 */

import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import React, { useEffect } from 'react';
import { Text } from 'react-native';

import { ThemeProvider } from '@/core/theme/ThemeProvider';
import { ConfirmProvider } from '@/shared/patterns';

import { useAnswerLeaveGuard } from './useAnswerLeaveGuard';
import { leaveDeletedChat, markDeleted, type StackEntry } from '../model/deletedChat';

jest.setTimeout(60_000);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = () => require('expo-router/build/global-state/router-store').store;

interface RouteState {
    routes: { name: string; state?: RouteState }[];
}

const rootRoutes = (): string[] => ((store().state as RouteState).routes[0]?.state?.routes ?? []).map((r) => r.name);

let readStack: () => readonly StackEntry[] = () => [];

/** A chat that is answering for as long as the test lasts. */
function Chat() {
    const { id } = useLocalSearchParams<{ id: string }>();
    useAnswerLeaveGuard(true, id ?? null);
    return <Text>chat</Text>;
}

function Details() {
    const navigation = useNavigation();
    useEffect(() => {
        readStack = () => navigation.getState()?.routes ?? [];
    });
    return <Text>details</Text>;
}

async function openDetails(id: string) {
    await renderRouter({
        _layout: () => (
            <ThemeProvider>
                <ConfirmProvider>
                    <Stack screenOptions={{ headerShown: false }} />
                </ConfirmProvider>
            </ThemeProvider>
        ),
        index: () => <Text>chats</Text>,
        'chat/[id]': Chat,
        'chat/[id]/details': Details,
    });
    await act(async () => router.push(`/chat/${id}`));
    await act(async () => router.push(`/chat/${id}/details`));
    expect(rootRoutes()).toEqual(['index', 'chat/[id]', 'chat/[id]/details']);
}

it('holds the pop over a chat that is still answering', async () => {
    await openDetails('r1');
    await act(async () => leaveDeletedChat(router, readStack(), 'r1'));
    expect(rootRoutes()).toEqual(['index', 'chat/[id]', 'chat/[id]/details']);
});

it('lets the pop through once the conversation is deleted', async () => {
    await openDetails('r2');
    await act(async () => {
        markDeleted('r2');
        leaveDeletedChat(router, readStack(), 'r2');
    });
    expect(rootRoutes()).toEqual(['index']);
});
