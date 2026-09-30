/**
 * One reminder. Tapping the row moves it (snoozes); the check completes it —
 * one tap each, because that is all a reminder ever needs.
 */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { absoluteTime } from '@/features/automations';
import { Icon, IconButton, ListRow } from '@/shared/ui';

import type { Reminder } from '../model/types';

/**
 * Module-level so the clock is read outside the render pass — a component body
 * that calls Date.now() directly is impure by React's rules.
 */
function isDue(remindAt: string | null): boolean {
    if (!remindAt) return false;
    return new Date(remindAt).getTime() <= Date.now();
}

function subtitleOf(reminder: Reminder): string {
    return [
        absoluteTime(reminder.remindAt),
        reminder.repeatInterval ? `repeats ${reminder.repeatInterval}` : null,
        reminder.message || null,
    ]
        .filter(Boolean)
        .join(' · ');
}

export function ReminderRow({
    reminder,
    onSnooze,
    onComplete,
}: {
    reminder: Reminder;
    onSnooze: () => void;
    onComplete: () => void;
}) {
    const theme = useTheme();
    const due = isDue(reminder.remindAt);

    return (
        <ListRow
            title={reminder.title}
            subtitle={subtitleOf(reminder)}
            wrapTitle
            leading={<Icon name="Bell" size={18} color={due ? theme.colors.warning : theme.colors.textMuted} />}
            trailing={
                <IconButton
                    icon={<Icon name="Check" size={18} color={theme.colors.success} />}
                    accessibilityLabel={`Mark “${reminder.title}” done`}
                    onPress={onComplete}
                />
            }
            chevron={false}
            onPress={onSnooze}
        />
    );
}
