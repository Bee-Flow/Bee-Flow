/**
 * One agent: its profile at /agents/<id>, a chat with it at ?c=new or
 * ?c=<conversationId>, a starter prompt in ?q= (features/agents/screens/
 * AgentScreen.tsx).
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { AgentScreen } from '@/features/agents';

export default function AgentRoute() {
    const { id, c, q } = useLocalSearchParams<{ id: string; c?: string; q?: string }>();
    return <AgentScreen id={id} c={c} q={q} />;
}
