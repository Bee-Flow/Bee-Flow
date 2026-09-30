/**
 * Cowork — everything that runs without you. Opened from Studio's Workspace
 * group (a pushed screen, with Back), and from links and search.
 *
 * This is a hub, not a list. The web app puts automations, AI tasks,
 * reminders, projects and Studio apps in five separate sidebar destinations;
 * on a phone that is five taps to answer the only question anyone opens this
 * screen to ask, which is "is anything wrong?". So the order is by urgency,
 * not by feature (see components/hubBlocks.tsx), and a section the licence withholds
 * fails on its own without taking the tab down (see useCoworkHub).
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useCancelRun } from '@/features/automations';
import { ComposeCowork } from '@/features/cowork';
import { ReminderSheet, TaskSheet } from '@/features/tasks';
import { BlockList } from '@/shared/patterns';
import { ListSkeleton, Screen, ScreenHeader, useToast } from '@/shared/ui';

import { hubBlocks } from '../components/hubBlocks';
import { useCoworkHub } from '../hooks/useCoworkHub';

export function CoworkHubScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const [taskSheet, setTaskSheet] = useState(false);
    const [reminderSheet, setReminderSheet] = useState(false);
    const hub = useCoworkHub();

    const stop = useCancelRun(() => void hub.active.refetch(), {
        onSuccess: () => toast('Stop requested'),
        onError: (err) => toast(describeError(err).message, 'error'),
    });

    return (
        <Screen avoidKeyboard>
            <ScreenHeader title={t('sidebar.cowork', 'Cowork')} />

            {hub.firstLoad ? (
                <ListSkeleton />
            ) : (
                <BlockList
                    refreshing={hub.refreshing}
                    onRefresh={hub.refreshAll}
                    blocks={hubBlocks(hub, {
                        onStop: (runId) => stop.mutate(runId),
                        onNewTask: () => setTaskSheet(true),
                        onNewReminder: () => setReminderSheet(true),
                    })}
                />
            )}

            {/*
              * Delegating IS this tab's verb, so the composer is pinned where
              * the chat tab pins its own: describe the work, the AI works out
              * the schedule, a sheet asks before anything is created.
              */}
            <ComposeCowork />

            <TaskSheet visible={taskSheet} onClose={() => setTaskSheet(false)} />
            <ReminderSheet visible={reminderSheet} onClose={() => setReminderSheet(false)} />
        </Screen>
    );
}
