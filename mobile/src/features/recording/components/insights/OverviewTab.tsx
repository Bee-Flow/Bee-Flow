/**
 * The five-second read: one line per headline fact, each jumping into the
 * recording where it applies — agent-hub's insights/OverviewTab.jsx. The
 * highlights come from buildOverviewHighlights, which already respects the
 * per-person switch.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { formatDuration } from '@/features/recording/model/format';
import type { Highlight, InsightsModel } from '@/features/recording/model/insights/model';

import { EmptyNote, MetricRow, TabBody } from './primitives';

function labelOf(h: Highlight, t: TranslateFn): string {
    switch (h.id) {
        case 'longest_monologue':
            return t('meeting_notes.insights_hl_monologue', 'Longest monologue');
        case 'most_questions':
            return t('meeting_notes.insights_hl_questions', 'Most questions asked');
        case 'biggest_topic':
            return t('meeting_notes.insights_hl_topic', 'Biggest topic');
        case 'open_actions':
            return t('meeting_notes.insights_hl_actions', 'Open action items');
        case 'participants':
            return t('meeting_notes.insights_hl_participants', 'People who spoke');
        default:
            return t('meeting_notes.insights_hl_attention', 'Attention spent');
    }
}

function valueOf(h: Highlight): string {
    if (h.kind === 'duration') return formatDuration(h.value);
    if (h.kind === 'percent') return `${h.value}%`;
    if (h.kind === 'hours') return `${h.value.toFixed(1)} h`;
    return String(h.value);
}

function detailOf(h: Highlight, t: TranslateFn): string | undefined {
    const n = h.detail?.split(' ')[0] ?? '';
    if (h.id === 'participants' && h.detail) return t('meeting_notes.insights_hl_silent', '{n} silent').replace('{n}', n);
    if (h.id === 'open_actions' && h.detail) return t('meeting_notes.insights_hl_unassigned', '{n} unassigned').replace('{n}', n);
    return h.detail;
}

export function OverviewTab({ model, onSeek }: { model: InsightsModel; onSeek?: (seconds: number) => void }) {
    const t = useTranslation();
    if (!model.overview.length) {
        return <EmptyNote>{t('meeting_notes.insights_empty', 'Not enough data for insights on this meeting.')}</EmptyNote>;
    }
    const jump = t('meeting_notes.insights_jump', 'Jump to this moment');
    return (
        <TabBody>
            {model.overview.map((h) => (
                <MetricRow
                    key={h.id}
                    label={labelOf(h, t)}
                    detail={detailOf(h, t)}
                    value={valueOf(h)}
                    flagged={h.id === 'open_actions' && h.value > 0 && model.followUp.overdue > 0}
                    onPress={h.seconds !== undefined && onSeek ? () => onSeek(h.seconds as number) : undefined}
                    hint={h.seconds !== undefined ? jump : undefined}
                />
            ))}
        </TabBody>
    );
}
