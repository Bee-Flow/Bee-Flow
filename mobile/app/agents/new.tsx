/**
 * A new agent — the Agents list's New action: `?ai=1` is "Create with AI",
 * without it the empty manual editor (features/agents/screens/NewAgentScreen.tsx).
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { NewAgentScreen } from '@/features/agents';

export default function NewAgentRoute() {
    const { ai } = useLocalSearchParams<{ ai?: string }>();
    return <NewAgentScreen ai={ai === '1'} />;
}
