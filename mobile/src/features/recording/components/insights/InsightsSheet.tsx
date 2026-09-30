/**
 * The Insights details, in a sheet over the note: the web panel's tab strip
 * (Overview, People, Flow, Topics, Follow-up) and the chosen tab. A tab with
 * nothing in it is disabled rather than hidden, so the strip does not
 * reshuffle between meetings — the absence is itself information.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { InsightsModel } from '@/features/recording/model/insights/model';
import { Sheet, TabBar, Text, type TabBarItem } from '@/shared/ui';

import { FlowTab } from './FlowTab';
import { FollowUpTab } from './FollowUpTab';
import { OverviewTab } from './OverviewTab';
import { PeopleTab } from './PeopleTab';
import { TopicsTab } from './TopicsTab';

export type InsightsTabId = 'overview' | 'people' | 'flow' | 'topics' | 'followup';

export function insightsTabs(model: InsightsModel, t: TranslateFn): TabBarItem<InsightsTabId>[] {
    const f = model.followUp;
    return [
        { id: 'overview', label: t('meeting_notes.insights_tab_overview', 'Overview'), icon: 'BarChart3' },
        { id: 'people', label: t('meeting_notes.insights_tab_people', 'People'), icon: 'Users', disabled: !model.people },
        { id: 'flow', label: t('meeting_notes.insights_tab_flow', 'Flow'), icon: 'Activity' },
        {
            id: 'topics',
            label: t('meeting_notes.insights_tab_topics', 'Topics'),
            icon: 'Tags',
            disabled: model.topics.blocks.length === 0 && model.topics.tags.length === 0,
        },
        {
            id: 'followup',
            label: t('meeting_notes.insights_tab_followup', 'Follow-up'),
            icon: 'ListChecks',
            count: f.open || null,
            disabled: !f.total && !f.decisions && !f.openQuestions.length,
        },
    ];
}

export interface InsightsSheetProps {
    visible: boolean;
    onClose: () => void;
    model: InsightsModel;
    colourFor: (speakerId: string) => string;
    viewerSpeakerId: string | null;
    /** Jump the recording to a moment; absent when the note has no audio. */
    onSeek?: (seconds: number) => void;
}

export function InsightsSheet({ visible, onClose, model, colourFor, viewerSpeakerId, onSeek }: InsightsSheetProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [tab, setTab] = useState<InsightsTabId>('overview');
    const items = insightsTabs(model, t);
    // Never leave a disabled tab selected (a meeting whose per-person stats are off).
    const active = items.some((i) => i.id === tab && !i.disabled) ? tab : 'overview';
    // Seeking plays the recording on the note, so the sheet steps aside for it.
    const seek = onSeek
        ? (seconds: number) => {
              onClose();
              onSeek(seconds);
          }
        : undefined;
    return (
        <Sheet visible={visible} onClose={onClose} title={t('meeting_notes.insights', 'Insights')} tall>
            <View style={styles.body}>
                <TabBar items={items} value={active} onChange={setTab} accessibilityLabel={t('meeting_notes.insights', 'Insights')} />
                {active === 'overview' ? <OverviewTab model={model} onSeek={seek} /> : null}
                {active === 'people' ? (
                    <PeopleTab model={model} colourFor={colourFor} viewerSpeakerId={viewerSpeakerId} onSeek={seek} />
                ) : null}
                {active === 'flow' ? <FlowTab model={model} colourFor={colourFor} onSeek={seek} /> : null}
                {active === 'topics' ? <TopicsTab model={model} colourFor={colourFor} onSeek={seek} /> : null}
                {active === 'followup' ? <FollowUpTab model={model} onSeek={seek} /> : null}
                {!model.perPersonEnabled ? (
                    <Text variant="caption" tone="tertiary">
                        {t('meeting_notes.insights_per_person_off', 'Per-person statistics are disabled by your organization.')}
                    </Text>
                ) : null}
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.lg, paddingBottom: theme.spacing.lg } satisfies ViewStyle,
});
