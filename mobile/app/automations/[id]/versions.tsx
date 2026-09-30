/** A routine's saved versions: compare and restore. See features/flow-editor VersionsScreen. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { VersionsScreen } from '@/features/flow-editor';

export default function VersionsRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <VersionsScreen automationId={id} />;
}
