/**
 * One past meeting in the library list.
 *
 * The status is carried by an icon AND a word, never by colour alone — a
 * red/green dot is invisible to a large minority of users and meaningless in
 * bright sunlight, which is exactly where a phone gets used.
 *
 * 'processing' is a normal, expected state that lasts minutes, so it reads as
 * "working on it" rather than as an error, and the row stays openable the
 * whole time: the detail screen has something useful to say while it waits.
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { ListRow } from '../../../ui/List';
import { Text } from '../../../ui/Text';
import { formatDuration, formatWhen } from '../format';
import type { TranscriptionStatus, TranscriptionSummary } from '../types';

export function statusLabel(status: TranscriptionStatus): string {
    switch (status) {
        case 'processing':
            return 'Transcribing';
        case 'failed':
            return 'Failed';
        default:
            return 'Ready';
    }
}

export function TranscriptionRow({
    item,
    onPress,
    onLongPress,
}: {
    item: TranscriptionSummary;
    onPress: () => void;
    onLongPress?: () => void;
}) {
    const theme = useTheme();

    const { icon, colour } =
        item.status === 'processing'
            ? { icon: 'loader' as const, colour: theme.colors.accentPrimary }
            : item.status === 'failed'
              ? { icon: 'alert-triangle' as const, colour: theme.colors.error }
              : item.source === 'recording'
                ? { icon: 'mic' as const, colour: theme.colors.textSecondary }
                : { icon: 'file-text' as const, colour: theme.colors.textSecondary };

    // What the row says under the title, in priority order: a failure needs
    // explaining, a job in flight needs reassuring, and a finished note is
    // best described by what it was actually about.
    const subtitle =
        item.status === 'failed'
            ? 'Transcription did not finish. Open it to retry.'
            : item.status === 'processing'
              ? 'Transcribing and summarising — this can take a few minutes.'
              : (item.summarySnippet || item.transcriptSnippet || '').replace(/\s+/g, ' ').trim() ||
                undefined;

    const facts = [
        item.durationSeconds ? formatDuration(item.durationSeconds) : null,
        item.speakerCount ? `${item.speakerCount} ${item.speakerCount === 1 ? 'speaker' : 'speakers'}` : null,
    ].filter((value): value is string => Boolean(value));

    return (
        <ListRow
            title={item.title || 'Untitled meeting'}
            subtitle={subtitle}
            wrapTitle
            meta={formatWhen(item.createdAt)}
            onPress={onPress}
            onLongPress={onLongPress}
            leading={
                <View
                    style={{
                        width: 40,
                        height: 40,
                        borderRadius: theme.radii.md,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: theme.colors.bgTertiary,
                    }}
                >
                    <Feather name={icon} size={18} color={colour} />
                </View>
            }
            trailing={
                item.status === 'completed' && facts.length ? (
                    <Text variant="label" tone="tertiary" numberOfLines={1}>
                        {facts.join(' · ')}
                    </Text>
                ) : (
                    <Text
                        variant="label"
                        tone={item.status === 'failed' ? 'error' : 'accent'}
                        numberOfLines={1}
                    >
                        {statusLabel(item.status)}
                    </Text>
                )
            }
        />
    );
}
