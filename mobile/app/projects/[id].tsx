/**
 * One Solution (project): its content, checks, versions, wiring, chats,
 * members and activity. `?tab=<section>` opens one directly. See
 * features/projects.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ProjectDetailScreen } from '@/features/projects';

export default function ProjectDetailRoute() {
    const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
    return <ProjectDetailScreen id={id} initialTab={tab} />;
}
