/**
 * Studio Documents: invoices, quotes, letters and presentations. The screen
 * lives in features/studioDocuments; `?new=1` opens the starter gallery. (The
 * knowledge-base file list is at /knowledge/documents.)
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { StudioDocumentsScreen } from '@/features/studioDocuments';

export default function StudioDocumentsRoute() {
    const params = useLocalSearchParams<{ new?: string }>();
    return <StudioDocumentsScreen startCreating={params.new === '1'} />;
}
