/** One group: description, role, allowed tiers, members. See features/orgPeople. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { GroupScreen } from '@/features/orgPeople';

export default function GroupRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <GroupScreen id={id} />;
}
