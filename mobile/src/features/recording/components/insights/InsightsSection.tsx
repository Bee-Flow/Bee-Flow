/**
 * Meeting dynamics on the note — agent-hub's InsightsPanel.jsx in its
 * "headline" form: the three numbers (balance, interactivity, silence)
 * always visible above the summary, everything else one tap away in a sheet,
 * so the insights never push the summary off screen.
 *
 * Privacy: the organisation's per-person switch (`perPersonInsights`) goes
 * into buildInsightsModel, which then never builds anything that names a
 * person; the viewer's own row floats to the top of People.
 */

import React, { useMemo, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { buildSpeakerColors, formatDuration } from '@/features/recording/model/format';
import { buildInsightsModel } from '@/features/recording/model/insights/model';
import { matchViewerSpeaker } from '@/features/recording/model/insights/talk';
import type { Transcription } from '@/features/recording/model/types';
import { Button, Section, Text } from '@/shared/ui';

import { InsightsSheet } from './InsightsSheet';
import { StatTile } from './primitives';

export interface InsightsSectionProps {
    meeting: Transcription;
    onSeek?: (seconds: number) => void;
}

export function InsightsSection({ meeting, onSeek }: InsightsSectionProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { user } = useAuth();
    const [open, setOpen] = useState(false);
    const model = useMemo(
        () => buildInsightsModel(meeting, { perPersonEnabled: meeting.perPersonInsights !== false }),
        [meeting],
    );
    const colours = useMemo(() => buildSpeakerColors(meeting.speakers), [meeting.speakers]);
    const viewerSpeakerId = matchViewerSpeaker(meeting.speakers, user?.displayName);
    const title = t('meeting_notes.insights', 'Insights');

    if (!model) {
        return (
            <Section title={title}>
                <Text variant="caption" tone="tertiary">
                    {t('meeting_notes.insights_empty', 'Not enough data for insights on this meeting.')}
                </Text>
            </Section>
        );
    }

    return (
        <Section
            title={title}
            action={
                <Button
                    label={t('meeting_notes.insights_show', 'Show details')}
                    variant="ghost"
                    size="sm"
                    onPress={() => setOpen(true)}
                    testID="insights-details"
                />
            }
        >
            <View style={styles.tiles}>
                <StatTile
                    label={t('meeting_notes.insights_balance', 'Balance')}
                    value={`${Math.round(model.talk.balance * 100)}%`}
                    hint={t('meeting_notes.insights_balance_hint', 'How evenly the speaking time was shared')}
                />
                <StatTile
                    label={t('meeting_notes.insights_interactivity', 'Interactivity')}
                    value={model.interactivity ? `${model.interactivity.score}/10` : '—'}
                    hint={t('meeting_notes.insights_interactivity_hint', 'How often the conversation changed hands')}
                />
                <StatTile
                    label={t('meeting_notes.insights_silence', 'Silence')}
                    value={formatDuration(model.talk.silenceSeconds)}
                    hint={t('meeting_notes.insights_silence_hint', 'Recording time when nobody spoke')}
                />
            </View>
            <InsightsSheet
                visible={open}
                onClose={() => setOpen(false)}
                model={model}
                colourFor={(id) => colours[id] ?? theme.colors.textMuted}
                viewerSpeakerId={viewerSpeakerId}
                onSeek={onSeek}
            />
        </Section>
    );
}

const makeStyles = (theme: Theme) => ({
    tiles: { flexDirection: 'row', gap: theme.spacing.sm } satisfies ViewStyle,
});
