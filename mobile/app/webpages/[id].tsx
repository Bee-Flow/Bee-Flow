/** One webpage. The screen lives in features/webpages; `?tab=` opens one of its sections. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { WebpageScreen } from '@/features/webpages';

export default function WebpageRoute() {
    const params = useLocalSearchParams<{ id: string; tab?: string }>();
    return (
        <WebpageScreen
            pageId={typeof params.id === 'string' ? params.id : ''}
            tab={typeof params.tab === 'string' ? params.tab : undefined}
        />
    );
}
