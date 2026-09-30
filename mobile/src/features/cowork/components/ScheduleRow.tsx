/** One Cowork schedule on the hub: when it next runs, or that it is paused. */

import { useRouter } from 'expo-router';
import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { statusLabel, statusToken } from '@/features/automations';
import { Icon, ListRow } from '@/shared/ui';

import { describeSchedule } from '../model/schedule';
import type { CoworkSchedule } from '../model/types';

export function ScheduleRow({ schedule }: { schedule: CoworkSchedule }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={schedule.title}
            subtitle={
                schedule.isActive
                    ? describeSchedule({ presetId: '', runAt: schedule.nextRunAt, repeatInterval: schedule.repeatInterval })
                    : statusLabel(t, statusToken('paused'))
            }
            meta={schedule.lastRunAt ? timeAgo(schedule.lastRunAt) : undefined}
            leading={
                <Icon
                    name={schedule.isActive ? 'Clock' : 'Pause'}
                    size={16}
                    color={schedule.isActive ? theme.colors.accentText : theme.colors.textMuted}
                />
            }
            onPress={() => router.push(`/cowork/${schedule.id}`)}
        />
    );
}
