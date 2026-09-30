/** One knowledge base. The screen lives in features/knowledge; `?tab=` opens one of its tabs. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { KnowledgeBaseScreen } from '@/features/knowledge';

export default function KnowledgeBaseRoute() {
    const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
    return <KnowledgeBaseScreen kbId={id ?? ''} initialTab={tab} />;
}
