/** One automation: run it, watch it, understand why it failed. See features/automations. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { AutomationDetailScreen } from '@/features/automations';

export default function AutomationDetailRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <AutomationDetailScreen id={id} />;
}
