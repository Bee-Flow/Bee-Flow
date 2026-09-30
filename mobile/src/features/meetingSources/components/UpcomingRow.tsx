/**
 * One upcoming meeting (agent-hub UpcomingMeetings.jsx, UpcomingMeetingRow):
 * date block, title and status, `time · duration · participants · provider`,
 * the event's tags, and the record switch with the state it will really have.
 *
 * The web explains an "off" switch in a hover title; a phone has no hover, so
 * the reason is a caption under the row instead.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Badge, Card, Switch, Text } from '@/shared/ui';

import { DateBlock } from './DateBlock';
import { UpcomingStatus } from './UpcomingStatus';
import type { UpcomingRow as Row } from '../model/rows';
import { meetingTags, metaSegments, recordReasonHint, toggleStateLabel } from '../model/upcomingMeta';

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    main: { flex: 1, gap: 4 },
    titleLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
    toggle: { alignItems: 'flex-end', gap: 2 },
    dim: { fontStyle: 'italic' },
});

export interface UpcomingRowProps {
    row: Row;
    /** Talk records audio or video (the org's `recordingMode`); Meet is always a video call. */
    talkMode: string;
    busy: boolean;
    overridden: boolean;
    error: unknown;
    onToggle: () => void;
    onOpenNote: (id: string) => void;
}

export function UpcomingRow({ row, talkMode, busy, overridden, error, onToggle, onOpenNote }: UpcomingRowProps) {
    const t = useTranslation();
    const m = row.meeting;
    const record = !m.excluded;
    const title = m.title || t('meetings.untitled', 'Untitled meeting');
    const hint = recordReasonHint(m.recordReason, record, t, { recordDecided: m.recordDecided, overridden });
    const tags = meetingTags(m);
    const provider = row.provider === 'gmeet' ? 'Meet' : 'Talk';
    const mode = row.provider === 'gmeet' || talkMode === 'video' ? 'Video' : 'Mic';

    return (
        <Card>
            <View style={styles.row}>
                <DateBlock start={m.start} />
                <View style={styles.main}>
                    <View style={styles.titleLine}>
                        <Text variant="body" weight="medium" numberOfLines={2}>
                            {title}
                        </Text>
                        <UpcomingStatus
                            status={row.status}
                            onOpenNote={row.noteId ? () => onOpenNote(row.noteId as string) : undefined}
                        />
                    </View>
                    <View style={styles.wrap}>
                        {metaSegments(m, t).map((seg) => (
                            <Text key={seg.key} variant="caption" tone="tertiary" style={seg.dim ? styles.dim : undefined}>
                                {`${seg.text} ·`}
                            </Text>
                        ))}
                        <Badge label={provider} icon={mode} tone="info" />
                    </View>
                    {tags.length ? (
                        <View style={styles.wrap}>
                            {tags.map((tag) => (
                                <Badge key={tag} label={tag} />
                            ))}
                        </View>
                    ) : null}
                    {hint ? (
                        <Text variant="caption" tone="tertiary">
                            {hint}
                        </Text>
                    ) : null}
                    {error ? (
                        <Text variant="caption" tone="error">
                            {describeError(error).message}
                        </Text>
                    ) : null}
                </View>
                <View style={styles.toggle}>
                    <Switch
                        value={record}
                        onValueChange={onToggle}
                        disabled={!row.toggleable || busy}
                        accessibilityLabel={t('meetings.upcoming_toggle_label', 'Record {title}', { title })}
                    />
                    <Text variant="caption" tone="tertiary">
                        {toggleStateLabel(record, m.recordDecided, t)}
                    </Text>
                </View>
            </View>
        </Card>
    );
}
