/** One playbook, phase by phase. The screen lives in features/playbooks. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { PlaybookScreen } from '@/features/playbooks';

export default function PlaybookRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <PlaybookScreen id={id} />;
}
