/** App Studio: coming soon on the phone (features/studio AppStudioSoonScreen). `?app=<id>` offers to run that app. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { AppStudioSoonScreen } from '@/features/studio';

export default function AppStudioRoute() {
    const { app } = useLocalSearchParams<{ app?: string }>();
    return <AppStudioSoonScreen appId={typeof app === 'string' && app ? app : undefined} />;
}
