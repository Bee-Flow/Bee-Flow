/**
 * One recording that is still only on this phone.
 *
 * The visual weight here is deliberate — a queued recording is drawn as
 * prominently as a finished note, with a warning-toned border while it is
 * failed. This row is the difference between "the upload failed and I lost the
 * meeting" and "the upload failed and I tapped Retry": if it looked like a
 * quiet secondary item, people would swipe past it and later wonder where
 * their meeting went.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatBytes } from '@/shared/lib/bytes';
import { Badge, Card, Icon, Text, type BadgeTone } from '@/shared/ui';

import { OutboxRowActions } from './OutboxRowActions';
import { OutboxRowProgress } from './OutboxRowProgress';
import { formatDuration, formatWhen } from '../model/format';
import type { PendingRecording } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        failed: { borderColor: theme.colors.warning, borderWidth: StyleSheet.hairlineWidth },
        body: { gap: theme.spacing.md },
        top: { flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' },
        glyph: {
            width: 40,
            height: 40,
            borderRadius: theme.radii.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.bgTertiary,
        },
        titles: { flex: 1, gap: 4 },
    });

/** The row's state in a word, never by colour alone. */
const BADGES: Record<PendingRecording['status'], [string, BadgeTone]> = {
    uploading: ['Uploading', 'accent'],
    failed: ['Not uploaded', 'warning'],
    queued: ['On this phone', 'neutral'],
};

export interface OutboxRowProps {
    item: PendingRecording;
    onUpload: () => void;
    onCancel: () => void;
    onEdit: () => void;
    onDiscard: () => void;
}

export function OutboxRow({ item, onUpload, onCancel, onEdit, onDiscard }: OutboxRowProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const failed = item.status === 'failed';
    const [badgeLabel, badgeTone] = BADGES[item.status];

    return (
        <Card style={failed ? styles.failed : undefined}>
            <View style={styles.body}>
                <View style={styles.top}>
                    <View style={styles.glyph}>
                        <Icon
                            name={item.captureMode === 'recording' ? 'Mic' : 'FilePlus'}
                            size={18}
                            color={failed ? theme.colors.warning : theme.colors.textSecondary}
                        />
                    </View>
                    <View style={styles.titles}>
                        <Text variant="subheading" numberOfLines={2}>
                            {item.settings.title || item.fileName}
                        </Text>
                        <Text variant="caption" tone="tertiary">
                            {formatDuration(item.durationSeconds)} · {formatBytes(item.sizeBytes) || '—'} ·{' '}
                            {formatWhen(item.createdAt)}
                        </Text>
                    </View>
                    <Badge label={badgeLabel} tone={badgeTone} />
                </View>
                <OutboxRowProgress item={item} />
                <OutboxRowActions
                    item={item}
                    onUpload={onUpload}
                    onCancel={onCancel}
                    onEdit={onEdit}
                    onDiscard={onDiscard}
                />
            </View>
        </Card>
    );
}
