/**
 * The item's goal and how it stands, under its summary on the detail screen. Look along only: the goal is set and its
 * check approved on the computer. Nothing shows without a goal, or when it cannot be read.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Text } from '@/shared/ui';

import { useGoal } from '../hooks/queries';
import { goalLabel } from '../model/goal';

export function GoalNote({ scheduleId }: { scheduleId: string }) {
    const t = useTranslation();
    const goal = useGoal(scheduleId);
    if (!goal.data) return null;
    return (
        <Text variant="body" tone="secondary" testID="cowork-goal">
            {goalLabel(goal.data, t)}
        </Text>
    );
}
