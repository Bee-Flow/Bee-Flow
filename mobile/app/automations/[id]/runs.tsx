/**
 * Run history for one automation — and, with `?runId=`, one run in full. One
 * route rather than a nested `runs/[runId]`, so a run is deep-linkable from
 * the hub, the detail screen and a notification alike (see RunsScreen).
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { RunsScreen } from '@/features/automations';

export default function RunsRoute() {
    const { id, runId } = useLocalSearchParams<{ id: string; runId?: string }>();
    return <RunsScreen automationId={id} runId={runId} />;
}
