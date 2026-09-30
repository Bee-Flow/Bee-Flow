/**
 * Per speaker: share of the talk time, longest monologue (tap to hear it),
 * pace, turns, questions, listening time, and the AI's line on what they
 * contributed — agent-hub's insights/PeopleTab.jsx. The viewer's own row
 * comes first. Never drawn when the organisation switched per-person stats
 * off: the model does not even build `people` then.
 */

import React, { useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatDuration } from '@/features/recording/model/format';
import type { InsightsModel, PersonRow } from '@/features/recording/model/insights/model';
import { formatSpeakerLabel } from '@/features/recording/model/insights/turns';
import { Badge, Icon, Text } from '@/shared/ui';

import { BarRow, Block, EmptyNote, TabBody, TabHeading } from './primitives';

interface PeopleTabProps {
    model: InsightsModel;
    colourFor: (speakerId: string) => string;
    viewerSpeakerId: string | null;
    onSeek?: (seconds: number) => void;
}

export function PeopleTab({ model, colourFor, viewerSpeakerId, onSeek }: PeopleTabProps) {
    const t = useTranslation();
    const [expanded, setExpanded] = useState<string | null>(null);
    const people = model.people;
    if (!people || !people.rows.length) {
        return <EmptyNote>{t('meeting_notes.insights_empty', 'Not enough data for insights on this meeting.')}</EmptyNote>;
    }
    // A stable partition, not a re-sort: everyone else keeps their talk-time order.
    const rows = viewerSpeakerId
        ? [...people.rows.filter((s) => s.speakerId === viewerSpeakerId), ...people.rows.filter((s) => s.speakerId !== viewerSpeakerId)]
        : people.rows;
    return (
        <TabBody>
            {rows.map((row) => (
                <SpeakerBlock
                    key={row.speakerId}
                    row={row}
                    colour={colourFor(row.speakerId)}
                    isViewer={row.speakerId === viewerSpeakerId}
                    expanded={expanded === row.speakerId}
                    onToggle={() => setExpanded((cur) => (cur === row.speakerId ? null : row.speakerId))}
                    onSeek={onSeek}
                />
            ))}
            {people.silentAttendees.length > 0 ? (
                <Block>
                    <TabHeading>{t('meeting_notes.insights_silent', 'Did not speak')}</TabHeading>
                    <Text variant="caption" tone="secondary">
                        {people.silentAttendees.join(', ')}
                    </Text>
                </Block>
            ) : null}
        </TabBody>
    );
}

/** Pace, turns, questions and listening time in one line. */
function deliveryLine(row: PersonRow, t: TranslateFn): string {
    const parts: string[] = [];
    if (row.wpm !== null && row.wpm !== undefined) {
        parts.push(`${t('meeting_notes.insights_pace', 'Pace')} ${row.wpm} ${t('meeting_notes.insights_wpm', 'wpm')}`);
    }
    const avg = row.avgTurnSeconds ? ` · ${t('meeting_notes.insights_avg', 'avg')} ${formatDuration(row.avgTurnSeconds)}` : '';
    parts.push(`${t('meeting_notes.insights_turns', 'Turns')} ${row.turnCount}${avg}`);
    parts.push(`${t('meeting_notes.insights_questions_asked', 'Questions')} ${row.questionCount ?? 0}`);
    parts.push(`${t('meeting_notes.insights_listening', 'Listening')} ${formatDuration(row.listeningSeconds ?? 0)}`);
    return parts.join('   ');
}

interface SpeakerBlockProps {
    row: PersonRow;
    colour: string;
    isViewer: boolean;
    expanded: boolean;
    onToggle: () => void;
    onSeek?: (seconds: number) => void;
}

function SpeakerBlock({ row, colour, isViewer, expanded, onToggle, onSeek }: SpeakerBlockProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const mono = row.longestMonologue;
    const name = formatSpeakerLabel(row.speakerId);
    return (
        <Block>
            <View style={styles.nameRow}>
                <Text variant="body" weight="medium" numberOfLines={1} style={styles.flex}>
                    {name}
                </Text>
                {isViewer ? <Badge label={t('meeting_notes.insights_you', 'you')} tone="accent" /> : null}
                {row.summary ? (
                    <Pressable
                        onPress={onToggle}
                        accessibilityRole="button"
                        accessibilityState={{ expanded }}
                        accessibilityLabel={
                            expanded
                                ? t('meeting_notes.insights_hide_contribution', 'Hide contribution')
                                : t('meeting_notes.insights_show_contribution', 'Show contribution')
                        }
                        hitSlop={8}
                    >
                        <Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={16} color={theme.colors.textTertiary} />
                    </Pressable>
                ) : null}
            </View>
            <BarRow
                label={formatDuration(row.speakingSeconds)}
                fraction={row.share}
                value={`${Math.round(row.share * 100)}%`}
                colour={colour}
            />
            <Text variant="caption" tone="tertiary">
                {deliveryLine(row, t)}
            </Text>
            {mono ? (
                <Pressable
                    disabled={!onSeek}
                    onPress={() => onSeek?.(mono.start)}
                    accessibilityRole={onSeek ? 'button' : undefined}
                    style={styles.monologue}
                >
                    <Text variant="caption" tone={mono.flagged ? 'warning' : onSeek ? 'accent' : 'tertiary'}>
                        {`${t('meeting_notes.insights_hl_monologue', 'Longest monologue')} ${formatDuration(mono.seconds)}`}
                    </Text>
                </Pressable>
            ) : null}
            {expanded && row.summary ? (
                <View style={[styles.contribution, leftRule(colour)]}>
                    <Text variant="caption" tone="secondary">
                        {row.summary}
                    </Text>
                </View>
            ) : null}
        </Block>
    );
}

const leftRule = (colour: string): ViewStyle => ({ borderLeftColor: colour });

const makeStyles = (theme: Theme) => ({
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    flex: { flex: 1 },
    monologue: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' } satisfies ViewStyle,
    contribution: { borderLeftWidth: 2, paddingLeft: theme.spacing.md, marginTop: theme.spacing.xs } satisfies ViewStyle,
});
