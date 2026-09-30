/** One Studio document, in its editor. The screen lives in features/studioDocuments. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { StudioDocumentScreen } from '@/features/studioDocuments';

export default function StudioDocumentRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <StudioDocumentScreen documentId={id ?? ''} />;
}
