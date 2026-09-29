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

import { Feather } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Badge, Chip } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/Input';
import { Text } from '../../../ui/Text';
import { buildSpeakerColors } from '../format';
import type { Speaker } from '../types';

export interface SpeakerEdit {
    renames: Record<string, string>;
    merges: { from: string[]; into: string }[];
}

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
    const colours = useMemo(() => buildSpeakerColors(speakers), [speakers]);

    const [names, setNames] = useState<Record<string, string>>(() =>
        Object.fromEntries(speakers.map((s) => [s.id, s.id])),
    );
    const [selected, setSelected] = useState<string[]>([]);
    const [roster, setRoster] = useState(attendees.join(', '));

    const toggleSelected = (id: string) =>
        setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));

    /**
     * Two surviving speakers must not end up sharing a name. The server
     * refuses this too, but catching it here means the user sees which two
     * rows collide instead of a sentence about it after a round trip.
     */
    const collision = useMemo(() => {
        const seen = new Map<string, string>();
        for (const speaker of speakers) {
            if (selected.includes(speaker.id) && selected.length > 1) continue;
            const next = (names[speaker.id] ?? speaker.id).trim();
            if (!next) return `${speaker.id} needs a name.`;
            const clash = seen.get(next.toLowerCase());
            if (clash && clash !== speaker.id) {
                return `"${clash}" and "${speaker.id}" would both become "${next}". Merge them instead, or use different names.`;
            }
            seen.set(next.toLowerCase(), speaker.id);
        }
        return null;
    }, [names, selected, speakers]);

    const buildEdit = (mergeInto: string | null): SpeakerEdit => {
        const renames: Record<string, string> = {};
        for (const speaker of speakers) {
            const next = (names[speaker.id] ?? speaker.id).trim();
            if (next && next !== speaker.id) renames[speaker.id] = next;
        }
        const merges =
            mergeInto && selected.length > 1
                ? [{ from: selected.filter((id) => id !== mergeInto), into: mergeInto }]
                : [];
        return { renames, merges };
    };

    return (
        <View style={{ gap: theme.spacing.lg }}>
            {error ? (
                <Text variant="caption" tone="error">
                    {error}
                </Text>
            ) : null}

            <View style={{ gap: theme.spacing.md }}>
                {speakers.map((speaker) => {
                    const isSelected = selected.includes(speaker.id);
                    return (
                        <View
                            key={speaker.id}
                            style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' }}
                        >
                            <View
                                style={{
                                    width: 12,
                                    height: 12,
                                    borderRadius: 6,
                                    marginTop: 34,
                                    backgroundColor: colours[speaker.id] ?? theme.colors.textMuted,
                                }}
                            />
                            <View style={{ flex: 1, gap: theme.spacing.xs }}>
                                <TextField
                                    label={speaker.id}
                                    value={names[speaker.id] ?? speaker.id}
                                    onChangeText={(value) =>
                                        setNames((prev) => ({ ...prev, [speaker.id]: value }))
                                    }
                                    autoCapitalize="words"
                                    autoCorrect={false}
                                />
                                <View
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: theme.spacing.sm,
                                        flexWrap: 'wrap',
                                    }}
                                >
                                    <Text variant="caption" tone="tertiary">
                                        {speaker.speakingTime ?? '—'}
                                        {speaker.segments ? ` · ${speaker.segments} turns` : ''}
                                    </Text>
                                    {speaker.source === 'voiceprint' ? (
                                        <Badge label="Voice match" tone="success" />
                                    ) : null}
                                    {speaker.source === 'manual' ? <Badge label="Edited" /> : null}
                                    <Chip
                                        label={isSelected ? 'Selected to merge' : 'Select to merge'}
                                        selected={isSelected}
                                        onPress={() => toggleSelected(speaker.id)}
                                    />
                                </View>
                            </View>
                        </View>
                    );
                })}
            </View>

            {selected.length > 1 ? (
                <View
                    style={{
                        gap: theme.spacing.sm,
                        padding: theme.spacing.md,
                        borderRadius: theme.radii.md,
                        backgroundColor: theme.colors.bgTertiary,
                    }}
                >
                    <Text variant="caption" tone="secondary">
                        Merge {selected.length} speakers into one. Pick who they really are:
                    </Text>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: theme.spacing.sm }}
                    >
                        {selected.map((id) => (
                            <Chip
                                key={id}
                                label={names[id] ?? id}
                                onPress={() => onSave(buildEdit(id))}
                            />
                        ))}
                    </ScrollView>
                    <Text variant="caption" tone="tertiary">
                        Merging cannot be undone from here — the turns are relabelled.
                    </Text>
                </View>
            ) : null}

            <Button
                label="Save speaker names"
                fullWidth
                loading={saving}
                disabled={Boolean(collision) || selected.length > 1}
                onPress={() => onSave(buildEdit(null))}
            />
            {collision ? (
                <Text variant="caption" tone="warning">
                    {collision}
                </Text>
            ) : null}

            <View
                style={{
                    gap: theme.spacing.sm,
                    paddingTop: theme.spacing.md,
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.borderSubtle,
                }}
            >
                <Text variant="subheading">Let Bee Flow try again</Text>
                <Text variant="caption" tone="tertiary">
                    Re-reads the transcript and re-assigns names. It has almost nothing to go on
                    without a list of who was there — so give it one.
                </Text>
                <TextField
                    label="Who was in the meeting?"
                    value={roster}
                    onChangeText={setRoster}
                    placeholder="Tom, Gerard, René"
                    autoCapitalize="words"
                />
                <Button
                    label="Re-identify speakers"
                    variant="secondary"
                    fullWidth
                    loading={reidentifying}
                    onPress={() => onReidentify(roster)}
                    icon={<Feather name="users" size={16} color={theme.colors.textPrimary} />}
                />
            </View>
        </View>
    );
}
