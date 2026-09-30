/**
 * Overview — what this Solution IS, at a glance (the web's
 * ProjectOverviewTab): a count per kind, then the recent activity, compact.
 * The counts come from the same resources payload Content renders, so the
 * two can never disagree about what is here.
 *
 * The web's "Running now" band is fed by the project's live stream; the phone
 * does not hold that stream open, so the band is not drawn rather than drawn
 * stale.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { cardRows, type Block } from '@/shared/patterns';
import { Button, Text } from '@/shared/ui';

import { ActivityRow } from './ActivityRow';
import { CountTiles } from './CountTiles';
import { Strip } from './Strip';
import { block, TabBlocks } from './TabBlocks';
import { useDirectory, useProjectActivity } from '../hooks/queries';
import type { SolutionState } from '../hooks/useSolution';
import { nameResolver } from '../model/people';

const COMPACT_ACTIVITY = 8;

export function OverviewTab({ id, sol, onTab }: { id: string; sol: SolutionState; onTab: (tab: 'content' | 'activity') => void }) {
    const t = useTranslation();
    const activity = useProjectActivity(id);
    const directory = useDirectory();
    const nameFor = nameResolver(directory.data);
    const recent = (activity.data?.pages[0]?.items ?? []).slice(0, COMPACT_ACTIVITY);

    const activityBlocks: Block[] =
        recent.length === 0
            ? [block('recent:none', () => <Strip tone="quiet">{t('projects.section_empty', 'Nothing here yet.')}</Strip>, 'inner')]
            : [
                  ...cardRows({ key: 'recent', rows: recent, rowKey: (item) => item.id, render: (item) => <ActivityRow item={item} nameFor={nameFor} /> }),
                  block('recent:all', () => (
                      <Button label={t('mobile.projects.all_activity', 'All activity')} variant="ghost" size="sm" onPress={() => onTab('activity')} />
                  ), 'inner'),
              ];
    const blocks: Block[] = [
        block('counts', () => <CountTiles resources={sol.resources.data} onOpen={() => onTab('content')} />, 'none'),
        block('recent', () => <Text variant="subheading">{t('projects.recent_activity', 'Recent activity')}</Text>),
        ...(activity.isError
            ? [block('recent:error', () => <Strip tone="warning">{t('projects.section_unavailable', 'Could not load this section. Your items are safe — try again shortly.')}</Strip>, 'inner')]
            : activityBlocks),
    ];
    return (
        <TabBlocks
            blocks={blocks}
            onRefresh={() => Promise.all([sol.resources.refetch(), activity.refetch()])}
        />
    );
}
