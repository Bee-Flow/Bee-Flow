/** One capability: which groups, or all members, may use it. See features/orgPeople. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { CapabilityScreen } from '@/features/orgPeople';

export default function CapabilityRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <CapabilityScreen id={id} />;
}
