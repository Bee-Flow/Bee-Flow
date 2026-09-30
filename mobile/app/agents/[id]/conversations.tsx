/**
 * Every conversation with one agent — the complete list, where the
 * cross-agent one is capped (features/agents/screens/AgentConversationsScreen.tsx).
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { AgentConversationsScreen } from '@/features/agents';

export default function AgentConversationsRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <AgentConversationsScreen id={id} />;
}
