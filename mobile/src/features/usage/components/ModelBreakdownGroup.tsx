/**
 * Where the spend went, by the model that served it. The top ten only: a
 * bounded card, not a list that can grow.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, ListSkeleton, NoteRow } from '@/shared/ui';

import { ModelUsageRow } from './ModelUsageRow';
import type { ModelUsage } from '../model/types';

export function ModelBreakdownGroup({
    models,
    loading,
    wholeOrg,
    flatRate,
}: {
    models: ModelUsage[] | undefined;
    loading: boolean;
    /** Everyone in the organisation, rather than just the viewer. */
    wholeOrg: boolean;
    flatRate: boolean;
}) {
    const t = useTranslation();
    return (
        <Group
            title={t('mobile.usage.where_title', 'Where it went')}
            footer={
                wholeOrg
                    ? t('mobile.usage.where_org', 'Every call in your organisation, grouped by model.')
                    : t('mobile.usage.where_me', 'Your own calls, grouped by the model that served them.')
            }
        >
            {loading ? (
                <NoteRow>
                    <ListSkeleton rows={3} />
                </NoteRow>
            ) : models && models.length > 0 ? (
                models
                    .slice(0, 10)
                    .map((row) => <ModelUsageRow key={row.model} row={row} flatRate={flatRate} />)
            ) : (
                <NoteRow>{t('mobile.usage.nothing_used', 'Nothing has been used in this period.')}</NoteRow>
            )}
        </Group>
    );
}
