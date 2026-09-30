/** One organisation role and the permissions the organisation switches for it. See features/orgPeople. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { RoleScreen } from '@/features/orgPeople';

export default function RoleRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <RoleScreen id={id} />;
}
