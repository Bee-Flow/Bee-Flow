/**
 * Build a routine: its flow as an editable outline. See features/flow-editor BuildScreen.
 *
 * Frozen while the step editor is pushed over it: both edit one draft store,
 * and a hidden outline or canvas has no reason to rebuild on every keystroke.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import React from 'react';

import { BuildScreen } from '@/features/flow-editor';

export default function BuildRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return (
        <>
            <Stack.Screen options={{ freezeOnBlur: true }} />
            <BuildScreen id={id} />
        </>
    );
}
