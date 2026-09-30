/**
 * "Used by" — what attaches or applies this skill, and, under it, the delete
 * (the web puts DangerZone at the bottom of this tab: the decision is made
 * looking at what it would break). The server's 409 guard stays the
 * authority; the sheet only ever confirms a list it has shown.
 */

import React from 'react';

import type { UsageAnswer } from '@/core/api/usage';
import { useTranslation } from '@/core/i18n';
import { UsedByList } from '@/shared/patterns';

export function SkillUsageTab({
    usage,
    isLoading,
    error,
    onRetry,
    onDelete,
}: {
    usage: UsageAnswer | undefined;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    /** Absent when this viewer may not delete the skill. */
    onDelete?: () => void;
}) {
    const t = useTranslation();
    return (
        <UsedByList
            answer={usage}
            isLoading={isLoading}
            error={error}
            onRetry={onRetry}
            emptyText={t('skills_studio.usage.empty', 'No agent or automation uses this skill yet.')}
            danger={
                onDelete
                    ? {
                          notice: t('skills_studio.delete_notice', 'Agents that attach this skill lose the behaviour immediately.'),
                          label: t('skills_studio.delete_title', 'Delete skill'),
                          onPress: onDelete,
                      }
                    : null
            }
        />
    );
}
