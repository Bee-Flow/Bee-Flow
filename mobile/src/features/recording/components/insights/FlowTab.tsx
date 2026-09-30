/**
 * How the conversation moved: the turn-taking rhythm, who held the floor
 * when, who follows whom, time in long monologues and the quiet stretches —
 * agent-hub's insights/FlowTab.jsx. The meeting-level halves show with
 * per-person stats off; the attributed ones are absent from the model then.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { formatDuration } from '@/features/recording/model/format';
import type { InsightsModel } from '@/features/recording/model/insights/model';
import { formatSpeakerLabel } from '@/features/recording/model/insights/turns';
import { Text } from '@/shared/ui';

import { Block, EmptyNote, MetricRow, Sparkline, StackedAirtime, TabBody, TabHeading } from './primitives';

type Flow = InsightsModel['flow'];
type Seek = ((seconds: number) => void) | undefined;

interface FlowTabProps {
    model: InsightsModel;
    colourFor: (speakerId: string) => string;
    onSeek?: (seconds: number) => void;
}

function Rhythm({ rhythm, onSeek }: { rhythm: NonNullable<InsightsModel['interactivity']>; onSeek: Seek }) {
    const t = useTranslation();
    return (
        <Block>
            <TabHeading>{t('meeting_notes.insights_rhythm', 'Turn-taking rhythm')}</TabHeading>
            <Sparkline
                points={rhythm.windows.map((w) => ({ start: w.start, value: w.switches }))}
                label={t('meeting_notes.insights_rhythm_hint', 'Speaker changes per time block — tall means a lively exchange')}
                onSeek={onSeek}
            />
            <Text variant="caption" tone="tertiary">
                {`${rhythm.switches} ${t('meeting_notes.insights_switches', 'switches')} · ${rhythm.switchesPerMinute.toFixed(1)}/${t('meeting_notes.insights_per_minute', 'min')}`}
            </Text>
        </Block>
    );
}

function Airtime({ windows, colourFor, onSeek }: { windows: NonNullable<Flow['airtime']>; colourFor: FlowTabProps['colourFor']; onSeek: Seek }) {
    const t = useTranslation();
    return (
        <Block>
            <TabHeading>{t('meeting_notes.insights_airtime', 'Airtime over time')}</TabHeading>
            <StackedAirtime
                windows={windows}
                colourFor={colourFor}
                label={t('meeting_notes.insights_airtime_hint', 'Who held the floor in each time block')}
                onSeek={onSeek}
            />
        </Block>
    );
}

function Handoffs({ handoffs }: { handoffs: NonNullable<Flow['handoffs']> }) {
    const t = useTranslation();
    return (
        <Block>
            <TabHeading>{t('meeting_notes.insights_handoff', 'Who follows whom')}</TabHeading>
            {handoffs.map((h, i) => (
                // Index, not the names: a display name can contain anything.
                <MetricRow
                    key={`handoff-${i}`}
                    label={`${formatSpeakerLabel(h.from)} → ${formatSpeakerLabel(h.to)}`}
                    value={`${h.count}×`}
                />
            ))}
        </Block>
    );
}

function QuietStretches({ gaps, onSeek }: { gaps: Flow['deadAir']; onSeek: Seek }) {
    const t = useTranslation();
    const labelOf = (g: Flow['deadAir'][number]) => {
        if (g.kind === 'lead_in') return t('meeting_notes.insights_lead_in', 'Before the first word');
        if (g.kind === 'lead_out') return t('meeting_notes.insights_lead_out', 'After the last word');
        return `${t('meeting_notes.insights_from', 'From')} ${formatDuration(g.start)}`;
    };
    return (
        <Block>
            <TabHeading>{t('meeting_notes.insights_dead_air', 'Quiet stretches')}</TabHeading>
            {gaps.map((g) => (
                <MetricRow
                    key={`${g.start}-${g.end}`}
                    label={labelOf(g)}
                    value={formatDuration(g.seconds)}
                    onPress={onSeek ? () => onSeek(g.start) : undefined}
                    hint={t('meeting_notes.insights_jump', 'Jump to this moment')}
                />
            ))}
        </Block>
    );
}

/** The parts worth drawing: a chart of one window, or an empty list, says nothing. */
function partsOf({ flow, interactivity }: InsightsModel) {
    const rhythm = interactivity && interactivity.windows.length > 1 ? interactivity : null;
    const airtime = flow.airtime && flow.airtime.length > 1 ? flow.airtime : null;
    const handoffs = flow.handoffs?.length ? flow.handoffs : null;
    const any = Boolean(rhythm || airtime || handoffs || flow.deadAir.length || flow.monologue);
    return { rhythm, airtime, handoffs, any };
}

export function FlowTab({ model, colourFor, onSeek }: FlowTabProps) {
    const t = useTranslation();
    const { flow } = model;
    const { rhythm, airtime, handoffs, any } = partsOf(model);
    if (!any) {
        return (
            <EmptyNote>
                {t('meeting_notes.insights_flow_empty', 'This recording is too short to show how the conversation moved.')}
            </EmptyNote>
        );
    }
    return (
        <TabBody>
            {rhythm ? <Rhythm rhythm={rhythm} onSeek={onSeek} /> : null}
            {airtime ? <Airtime windows={airtime} colourFor={colourFor} onSeek={onSeek} /> : null}
            {handoffs ? <Handoffs handoffs={handoffs} /> : null}
            {flow.monologue ? (
                <MetricRow
                    label={t('meeting_notes.insights_monologue_share', 'Time in long monologues')}
                    detail={`${flow.monologue.count}×`}
                    value={`${Math.round(flow.monologue.ratio * 100)}%`}
                />
            ) : null}
            {flow.deadAir.length > 0 ? <QuietStretches gaps={flow.deadAir} onSeek={onSeek} /> : null}
        </TabBody>
    );
}
