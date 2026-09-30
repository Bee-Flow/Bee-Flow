/**
 * Running one Studio app. The runner lives in features/apps. `?draft=1` (from
 * Studio) runs the owner's saved draft; anyone else still gets the published app.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { AppDetailScreen } from '@/features/apps';

export default function AppDetailRoute() {
    const { id, draft } = useLocalSearchParams<{ id: string; draft?: string }>();
    return <AppDetailScreen id={id} draft={draft === '1'} />;
}
