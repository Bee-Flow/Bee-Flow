/** One skill, read in full. The screen lives in features/skills. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { SkillScreen } from '@/features/skills';

export default function SkillRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <SkillScreen skillId={id} />;
}
