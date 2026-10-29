/**
 * One automation in the list. It leads with the trigger, not the status, because
 * the trigger is what tells two similarly named automations apart; the status
 * rides on the right, where the eye goes second.
 */

import React from 'react';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, ListRow, Spinner } from '@/shared/ui';

import { StatusIcon } from './StatusPill';
import { absoluteTime } from '../model/time';
import { describeTrigger, triggerIcon } from '../model/trigger';
import type { Automation } from '../model/types';

function subtitleOf(t: TranslateFn, automation: Automation): string {
    if (!automation.isActive) {
        return automation.isDraft
            ? t('mobile.automations.row.draft', 'Draft — not finished yet')
            : t('automations.paused', 'Paused');
    }
    return automation.nextRunAt
        ? t('mobile.automations.row.next', 'Next {time}', { time: absoluteTime(automation.nextRunAt).toLowerCase() })
        : describeTrigger(automation.definition?.trigger ?? null);
}

export function AutomationListRow({
    automation,
    running,
    onPress,
    onLongPress,
}: {
    automation: Automation;
    running: boolean;
    onPress: () => void;
    /** The row's menu (edit its flow, delete). */
    onLongPress?: () => void;
}) {
    const theme = useTheme();
    const t = useTranslation();
    const trigger = automation.definition?.trigger ?? null;

    return (
        <ListRow
            title={automation.title || t('automations.library.untitled', 'Untitled automation')}
            subtitle={subtitleOf(t, automation)}
            meta={automation.lastRunAt ? timeAgo(automation.lastRunAt) : undefined}
            wrapTitle
            leading={
                running ? (
                    <Spinner />
                ) : (
                    <Icon
                        name={triggerIcon(trigger?.kind ?? automation.triggerType)}
                        size={18}
                        color={automation.isActive ? theme.colors.accentPrimary : theme.colors.textMuted}
                    />
                )
            }
            trailing={
                automation.lastStatus ? <StatusIcon status={automation.lastStatus} size={16} /> : undefined
            }
            onPress={onPress}
            onLongPress={onLongPress}
        />
    );
}
