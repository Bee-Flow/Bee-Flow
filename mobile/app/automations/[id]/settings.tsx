/** A routine's settings: details, notifications, webhooks, folder, export, delete. See features/flow-editor FlowSettingsScreen. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { FlowSettingsScreen } from '@/features/flow-editor';

export default function FlowSettingsRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <FlowSettingsScreen automationId={id} />;
}
