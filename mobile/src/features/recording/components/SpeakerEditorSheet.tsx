/**
 * Renaming and merging the people in a meeting.
 *
 * Diarization gets the number of voices right far more often than it gets the
 * NAMES right, and a transcript full of "Speaker 2" is a transcript nobody
 * reads twice. This sheet is the repair, and it has to support two different
 * repairs at once because they are the two different ways it goes wrong:
 *
 *   - A rename: this voice is Gerard, not "Speaker 2".
 *   - A merge: these two voices are the same person, split by the diarizer.
 *
 * They are sent as ONE atomic edit (PATCH /:id/speakers), because the server
 * resolves merges and renames simultaneously against the ORIGINAL names. That
 * is what makes swapping two speakers' names a supported edit rather than a
 * silent, irreversible collapse of both into one — see the long note in
 * server/routes/transcriptions/speakers.js.
 *
 * A row the user touches is marked `manual` server-side and outranks every
 * later automatic pass, which is why this is worth doing rather than
 * re-running the AI naming and hoping.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

import { ReidentifyPanel } from './ReidentifyPanel';
import { SpeakerMergePanel } from './SpeakerMergePanel';
import { SpeakerNameRow } from './SpeakerNameRow';
import { buildSpeakerColors } from '../model/format';
import { buildSpeakerEdit, speakerCollision } from '../model/speakers';
import type { Speaker, SpeakerEdit } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ body: { gap: theme.spacing.lg }, rows: { gap: theme.spacing.md } });

export function SpeakerEditorSheetBody({
    speakers,
    saving,
    error,
    onSave,
    onReidentify,
    reidentifying,
    attendees,
}: {
    speakers: Speaker[];
    saving: boolean;
    error: string | null;
    onSave: (edit: SpeakerEdit) => void;
    /** Ask the model to name them again from the stored text. */
    onReidentify: (roster: string) => void;
    reidentifying: boolean;
    attendees: string[];
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const colours = buildSpeakerColors(speakers);
    const [names, setNames] = useState<Record<string, string>>(() =>
        Object.fromEntries(speakers.map((s) => [s.id, s.id])),
    );
    const [selected, setSelected] = useState<string[]>([]);

    const toggleSelected = (id: string) =>
        setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
    const collision = speakerCollision(speakers, names, selected);
    const save = (mergeInto: string | null) => onSave(buildSpeakerEdit(speakers, names, selected, mergeInto));

    return (
        <View style={styles.body}>
            {error ? (
                <Text variant="caption" tone="error">
                    {error}
                </Text>
            ) : null}

            <View style={styles.rows}>
                {speakers.map((speaker) => (
                    <SpeakerNameRow
                        key={speaker.id}
                        speaker={speaker}
                        colour={colours[speaker.id] ?? theme.colors.textMuted}
                        name={names[speaker.id] ?? speaker.id}
                        onRename={(value) => setNames((prev) => ({ ...prev, [speaker.id]: value }))}
                        selected={selected.includes(speaker.id)}
                        onToggleSelected={() => toggleSelected(speaker.id)}
                    />
                ))}
            </View>

            <SpeakerMergePanel selected={selected} names={names} onMergeInto={save} />

            <Button
                label="Save speaker names"
                fullWidth
                loading={saving}
                disabled={Boolean(collision) || selected.length > 1}
                onPress={() => save(null)}
            />
            {collision ? (
                <Text variant="caption" tone="warning">
                    {collision}
                </Text>
            ) : null}

            <ReidentifyPanel attendees={attendees} busy={reidentifying} onReidentify={onReidentify} />
        </View>
    );
}
