/**
 * Studio → Playbooks. `?new=1` opens the New sheet at once — where the web's
 * /app/studio/playbooks/new and the Studio New menu land. The screen lives in
 * features/playbooks.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { PlaybooksScreen } from '@/features/playbooks';

export default function PlaybooksRoute() {
    const { new: startNew } = useLocalSearchParams<{ new?: string }>();
    return <PlaybooksScreen startNew={startNew === '1'} />;
}
