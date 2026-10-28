/**
 * One speaker in the editor: their colour, their name as a field, how much
 * they spoke, where the name came from, and the chip that selects them for a
 * merge.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Chip, Text, TextField } from '@/shared/ui';

import type { Speaker } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' },
        dot: { width: 12, height: 12, borderRadius: 6, marginTop: 34 },
        body: { flex: 1, gap: theme.spacing.xs },
        meta: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' },
    });

export function SpeakerNameRow({
    speaker,
    colour,
    name,
    onRename,
    selected,
    onToggleSelected,
}: {
    speaker: Speaker;
    colour: string;
    name: string;
    onRename: (next: string) => void;
    selected: boolean;
    onToggleSelected: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: colour }]} />
            <View style={styles.body}>
                <TextField
                    label={speaker.id}
                    value={name}
                    onChangeText={onRename}
                    autoCapitalize="words"
                    autoCorrect={false}
                />
                <View style={styles.meta}>
                    <Text variant="caption" tone="tertiary">
                        {speaker.speakingTime ?? '—'}
                        {speaker.segments ? ` · ${t('mobile.recording.speaker_turns', '{count} turns', { count: speaker.segments })}` : ''}
                    </Text>
                    {/* 'voiceprint': an acoustic match settled it; 'manual': a person did. */}
                    {speaker.source === 'voiceprint' ? <Badge label={t('mobile.recording.speaker_voice_match', 'Voice match')} tone="success" /> : null}
                    {speaker.source === 'manual' ? <Badge label={t('automations.ndv.edited', 'Edited')} /> : null}
                    <Chip
                        label={selected ? t('mobile.recording.merge_selected', 'Selected to merge') : t('mobile.recording.merge_select', 'Select to merge')}
                        selected={selected}
                        onPress={onToggleSelected}
                    />
                </View>
            </View>
        </View>
    );
}
