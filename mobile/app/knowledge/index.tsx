/** Knowledge bases. The screen lives in features/knowledge; `?new=1` opens the new-base sheet. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { KnowledgeListScreen } from '@/features/knowledge';

export default function KnowledgeListRoute() {
    const params = useLocalSearchParams<{ new?: string }>();
    return <KnowledgeListScreen startCreating={params.new === '1'} />;
}
