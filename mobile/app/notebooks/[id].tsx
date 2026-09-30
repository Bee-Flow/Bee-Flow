/** One notebook. The screen lives in features/notebooks. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { NotebookScreen } from '@/features/notebooks';

export default function NotebookRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <NotebookScreen notebookId={id ?? ''} />;
}
