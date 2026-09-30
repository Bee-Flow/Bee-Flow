/** The skill library. The screen lives in features/skills; `?new=1` opens the New skill sheet. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { SkillsScreen } from '@/features/skills';

export default function SkillsRoute() {
    const params = useLocalSearchParams<{ new?: string }>();
    return <SkillsScreen startCreating={params.new === '1'} />;
}
