/**
 * One piece of delegated work — what a Cowork notification opens
 * (`/app/cowork/:taskId`). The screen lives in features/cowork.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { CoworkDetailScreen } from '@/features/cowork';

export default function CoworkDetailRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <CoworkDetailScreen id={id} />;
}
