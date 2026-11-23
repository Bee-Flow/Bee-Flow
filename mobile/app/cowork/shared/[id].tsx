/**
 * Someone else's Cowork work shared with the caller, read only. The screen
 * lives in features/cowork. A static `shared` segment wins over `[id]`.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { SharedDetailScreen } from '@/features/cowork';

export default function SharedCoworkRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <SharedDetailScreen id={id} />;
}
