/** One member: profile, role, groups, two-factor reset, removal. See features/orgPeople. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { MemberScreen } from '@/features/orgPeople';

export default function MemberRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <MemberScreen id={id} />;
}
