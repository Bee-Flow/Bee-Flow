/**
 * Run history for one automation — and, with `?runId=`, one run in full.
 *
 * Both live in one route rather than a nested `runs/[runId]` because they are
 * one activity: you come here to find the run that went wrong and then read
 * it. A search param makes a run deep-linkable from the tab hub, the detail
 * screen and a notification alike; Back from a run returns to wherever it was
 * opened from, and to this list only when nothing is behind it (leaveRun).
 */

import React from 'react';

import { RunDetailScreen } from './RunDetailScreen';
import { RunListScreen } from './RunListScreen';

export function RunsScreen({ automationId, runId }: { automationId: string; runId?: string }) {
    return runId ? (
        <RunDetailScreen automationId={automationId} runId={runId} />
    ) : (
        <RunListScreen automationId={automationId} />
    );
}
