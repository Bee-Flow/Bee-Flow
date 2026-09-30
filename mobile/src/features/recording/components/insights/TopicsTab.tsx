/**
 * Where the time went: time per chapter (and, with per-person stats on, who
 * drove it and who opened it), action items per topic, and how often each
 * keyword was actually said — agent-hub's insights/TopicsTab.jsx.
 */

import React from 'react';
import { View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatDuration } from '@/features/recording/model/format';
import type { InsightsModel } from '@/features/recording/model/insights/model';
import { formatSpeakerLabel } from '@/features/recording/model/insights/turns';
import { Text } from '@/shared/ui';

import { BarRow, Block, EmptyNote, MetricRow, TabBody, TabHeading } from './primitives';

interface TopicsTabProps {
    model: InsightsModel;
    colourFor: (speakerId: string) => string;
    onSeek?: (seconds: number) => void;
}

export function TopicsTab({ model, colourFor, onSeek }: TopicsTabProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { blocks, tags } = model.topics;
    if (!blocks.length && !tags.length) {
        return (
            <EmptyNote>
                {t('meeting_notes.insights_topics_empty', 'No chapters were detected for this meeting. Regenerate the summary to add them.')}
            </EmptyNote>
        );
    }
    const jump = t('meeting_notes.insights_jump', 'Jump to this moment');
    return (
        <TabBody>
            {blocks.length > 0 ? (
                <Block>
                    <TabHeading>{t('meeting_notes.insights_topic_time', 'Time per topic')}</TabHeading>
                    {blocks.map((c) => (
                        <View key={`${c.title}-${c.seconds}`} style={styles.topic}>
                            <BarRow
                                label={c.title}
                                fraction={c.widthFraction}
                                value={formatDuration(c.endSeconds - c.seconds)}
                                onPress={onSeek ? () => onSeek(c.seconds) : undefined}
                                hint={jump}
                            />
                            {c.topSpeakerId ? (
                                <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.driver}>
                                    <Text variant="caption" style={ink(colourFor(c.topSpeakerId))}>
                                        {'● '}
                                    </Text>
                                    {`${t('meeting_notes.insights_driven_by', 'Mostly {name}').replace('{name}', formatSpeakerLabel(c.topSpeakerId))} (${Math.round((c.topSpeakerShare ?? 0) * 100)}%)`}
                                    {c.openedBy && c.openedBy !== c.topSpeakerId
                                        ? ` · ${t('meeting_notes.insights_opened_by', 'opened by {name}').replace('{name}', formatSpeakerLabel(c.openedBy))}`
                                        : ''}
                                </Text>
                            ) : null}
                        </View>
                    ))}
                </Block>
            ) : null}
            {model.actionsPerTopic.length > 0 ? (
                <Block>
                    <TabHeading>{t('meeting_notes.insights_actions_topic', 'Action items per topic')}</TabHeading>
                    {model.actionsPerTopic.map((a) => (
                        <MetricRow
                            key={a.title}
                            label={a.title}
                            value={a.count}
                            onPress={onSeek ? () => onSeek(a.seconds) : undefined}
                            hint={jump}
                        />
                    ))}
                </Block>
            ) : null}
            {tags.length > 0 ? (
                <Block>
                    <TabHeading>{t('meeting_notes.insights_keywords', 'Keywords mentioned')}</TabHeading>
                    {tags.map((tag) => (
                        <MetricRow
                            key={tag.tag}
                            label={tag.tag}
                            value={`${tag.count}×`}
                            onPress={tag.firstSeconds !== null && onSeek ? () => onSeek(tag.firstSeconds as number) : undefined}
                            hint={t('meeting_notes.insights_first_mention', 'Jump to the first mention')}
                        />
                    ))}
                </Block>
            ) : null}
        </TabBody>
    );
}

const ink = (colour: string): TextStyle => ({ color: colour });

const makeStyles = (theme: Theme) => ({
    topic: { gap: 2 } satisfies ViewStyle,
    driver: { paddingLeft: 112 + theme.spacing.sm },
});
