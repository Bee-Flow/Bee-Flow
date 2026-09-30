/**
 * "Edit with AI" for one agent; `?q=` is the first ask handed over by
 * "Create with AI" (features/agents/screens/AgentRefineScreen.tsx).
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { AgentRefineScreen } from '@/features/agents';

export default function AgentRefineRoute() {
    const { id, q } = useLocalSearchParams<{ id: string; q?: string }>();
    return <AgentRefineScreen id={id} q={q} />;
}
