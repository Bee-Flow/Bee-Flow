/** Webpages. The screen lives in features/webpages; `?new=1` opens the new-page sheet. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { WebpagesScreen } from '@/features/webpages';

export default function WebpagesRoute() {
    const params = useLocalSearchParams<{ new?: string }>();
    return <WebpagesScreen startCreating={params.new === '1'} />;
}
