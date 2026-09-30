/** The screen and header every state of the details screen shares. */

import { Stack } from 'expo-router';
import React, { type ReactNode } from 'react';

import { Screen, ScreenHeader, Spinner } from '@/shared/ui';

export function DetailsFrame({
    title,
    busy = false,
    avoidKeyboard = false,
    children,
}: {
    title: string;
    /** A PATCH in flight: the header shows a spinner. */
    busy?: boolean;
    avoidKeyboard?: boolean;
    children: ReactNode;
}) {
    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard={avoidKeyboard}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader title={title} actions={busy ? <Spinner /> : null} />
            {children}
        </Screen>
    );
}
