/**
 * The conversation screen. `id` is a conversation id or the literal `new`;
 * `kb` seeds a knowledge base, `project` files a new chat in a project and
 * `draft` is sent once on mount, `memory=off` starts it with memory saving
 * paused (see
 * features/chat/screens/ChatScreen.tsx).
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ChatScreen } from '@/features/chat';

export default function ChatRoute() {
    const { id, kb, draft, project, memory } = useLocalSearchParams<{ id: string; kb?: string; draft?: string; project?: string; memory?: string }>();
    return <ChatScreen id={id} kb={kb} draft={draft} project={project} memoryOff={memory === 'off'} />;
}
