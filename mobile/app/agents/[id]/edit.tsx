/** The manual agent editor (features/agents/screens/AgentEditScreen.tsx). */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { AgentEditScreen } from '@/features/agents';

export default function AgentEditRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <AgentEditScreen id={id} />;
}
