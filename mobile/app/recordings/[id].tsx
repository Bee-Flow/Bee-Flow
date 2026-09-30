/** One meeting, by its note id. The screen lives in features/recording. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { RecordingScreen } from '@/features/recording';

export default function MeetingDetailRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <RecordingScreen id={typeof id === 'string' ? id : ''} />;
}
