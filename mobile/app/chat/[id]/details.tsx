/**
 * Conversation details — name, pin, labels, project, session skills, the
 * transcript and delete (features/chat/screens/ChatDetailsScreen.tsx).
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ChatDetailsScreen } from '@/features/chat';

export default function ChatDetailsRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <ChatDetailsScreen id={id} />;
}
