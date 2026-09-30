/** A run in progress on the hub, stoppable from the row. */

import { useRouter } from 'expo-router';
import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { StatusIcon, statusLabel, statusToken, type ActiveRun } from '@/features/automations';
import { Icon, IconButton, ListRow } from '@/shared/ui';

export function RunningRow({ run, title, onStop }: { run: ActiveRun; title: string; onStop: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={title}
            subtitle={`${statusLabel(t, statusToken(run.status))} · ${t('mobile.cowork_hub.started_when', 'started {when}', { when: timeAgo(run.startedAt, { suffix: true }) })}`}
            leading={<StatusIcon status={run.status} />}
            trailing={
                <IconButton
                    icon={<Icon name="Square" size={16} color={theme.colors.error} />}
                    accessibilityLabel={`Stop ${title}`}
                    tone="danger"
                    onPress={onStop}
                />
            }
            onPress={() => router.push(`/automations/${run.automationId}/runs?runId=${run.runId}`)}
        />
    );
}
