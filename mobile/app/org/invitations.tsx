/** Invitations. `?new=1` opens the invite sheet at once (billing's "Add user"). See features/orgPeople. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { InvitationsScreen } from '@/features/orgPeople';

export default function InvitationsRoute() {
    const { new: fresh } = useLocalSearchParams<{ new?: string }>();
    return <InvitationsScreen startInviting={fresh === '1'} />;
}
