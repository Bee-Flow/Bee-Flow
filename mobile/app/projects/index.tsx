/**
 * The Solutions overview (projects). `?tab=installed|catalogue` opens a tab,
 * `?create=1` the New Solution sheet. The screen lives in features/projects.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ProjectsScreen } from '@/features/projects';

export default function ProjectsRoute() {
    const { tab, create } = useLocalSearchParams<{ tab?: string; create?: string }>();
    return <ProjectsScreen initialTab={tab} create={create === '1'} />;
}
