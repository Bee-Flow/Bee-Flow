/** Access & features. `?kind=integration` narrows it to one kind. See features/orgPeople. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { AccessScreen } from '@/features/orgPeople';

export default function AccessRoute() {
    const { kind } = useLocalSearchParams<{ kind?: string }>();
    return <AccessScreen kind={kind} />;
}
