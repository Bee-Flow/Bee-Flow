/**
 * One flowlet of an automation (definition.layers[layerKey]), built as if it were
 * the automation — its own outline and canvas, over the automation's draft. See
 * features/flow-editor FlowletScreen.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import React from 'react';

import { FlowletScreen } from '@/features/flow-editor';

export default function FlowletRoute() {
    const { id, layerKey } = useLocalSearchParams<{ id: string; layerKey: string }>();
    return (
        <>
            <Stack.Screen options={{ freezeOnBlur: true }} />
            <FlowletScreen id={id} layerKey={layerKey} />
        </>
    );
}
