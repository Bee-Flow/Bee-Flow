/**
 * A new routine: the build screen on a routine that does not exist yet (it
 * is created on the first edit). `?kind=form` starts it with a form trigger;
 * `?from=template` opens the template gallery first. Frozen while the step
 * editor is pushed over it, as the build route is.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import React from 'react';

import { BuildScreen, NEW_FLOW_ID } from '@/features/flow-editor';

export default function NewRoutineRoute() {
    const { kind, from } = useLocalSearchParams<{ kind?: string; from?: string }>();
    return (
        <>
            <Stack.Screen options={{ freezeOnBlur: true }} />
            <BuildScreen id={NEW_FLOW_ID} kind={kind === 'form' ? 'form' : 'manual'} fromTemplate={from === 'template'} />
        </>
    );
}
