/**
 * What we ask about a meeting, and the order we ask it in.
 *
 * The order is copied from the web capture panel and it is not arbitrary.
 * "Who is in the meeting" sits first, above everything else, because it is the
 * single strongest input to speaker naming: it turns "which of these fourteen
 * voice IDs are the same person?" — a question nothing can answer from text —
 * into assigning each one to a known handful of names. Buried under a
 * disclosure nobody opens, it never gets filled in and the naming stays
 * guesswork.
 *
 * Language is second because it decides which engine and which speech model
 * run; silently defaulting to Dutch behind a collapsed panel is how an English
 * meeting comes back transcribed as Dutch and nobody notices until they read
 * it. Everything below that is genuinely optional.
 */

import React, { useRef, useState } from 'react';
import { ScrollView, View, type TextInput } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Chip, Text, TextField } from '@/shared/ui';

import { TRANSCRIPTION_LANGUAGES } from '../model/capture';
import type { CaptureSettings } from '../model/types';

export function CaptureSettingsForm({
    value,
    onChange,
}: {
    value: CaptureSettings;
    onChange: (patch: Partial<CaptureSettings>) => void;
}) {
    const theme = useTheme();
    const [showAdvanced, setShowAdvanced] = useState(false);
    const attendeesField = useRef<TextInput>(null);

    return (
        <View style={{ gap: theme.spacing.lg }}>
            <TextField
                label="Title"
                value={value.title}
                onChangeText={(title) => onChange({ title })}
                placeholder="Weekly planning"
                hint="A better title is written automatically once the summary is ready."
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => attendeesField.current?.focus()}
            />

            <TextField
                ref={attendeesField}
                label="Who is in the meeting?"
                value={value.attendees}
                onChangeText={(attendees) => onChange({ attendees })}
                placeholder="Tom, Gerard, René"
                hint="Names, comma separated. This is what lets speakers be named instead of numbered."
                autoCapitalize="words"
                // The last field before the language chips: Done closes the
                // keyboard rather than promising a next field there is not.
                returnKeyType="done"
            />

            <View style={{ gap: theme.spacing.sm }}>
                <Text variant="label" tone="secondary">
                    LANGUAGE
                </Text>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
                >
                    {TRANSCRIPTION_LANGUAGES.map((language) => (
                        <Chip
                            key={language.code}
                            label={language.label}
                            selected={value.language === language.code}
                            onPress={() => onChange({ language: language.code })}
                        />
                    ))}
                </ScrollView>
                <Text variant="caption" tone="tertiary">
                    The language spoken in the room, not the language you want the notes in.
                </Text>
            </View>

            <Chip
                label={showAdvanced ? 'Hide extra options' : 'More options'}
                selected={showAdvanced}
                onPress={() => setShowAdvanced((open) => !open)}
                style={{ alignSelf: 'flex-start' }}
            />

            {showAdvanced ? (
                <View style={{ gap: theme.spacing.lg }}>
                    <TextField
                        label="Number of speakers"
                        value={value.numSpeakers}
                        onChangeText={(raw) => onChange({ numSpeakers: raw.replace(/[^0-9]/g, '') })}
                        placeholder="Auto"
                        keyboardType="number-pad"
                        hint="Leave blank to detect automatically. An exact count sharpens diarization."
                        containerStyle={{ maxWidth: 180 }}
                    />
                    <TextField
                        label="Glossary"
                        value={value.contextTerms}
                        onChangeText={(contextTerms) => onChange({ contextTerms })}
                        placeholder="AFAS, Bee Flow, n8n"
                        hint="Product names and jargon the transcriber would otherwise mishear."
                        autoCapitalize="none"
                    />
                </View>
            ) : null}
        </View>
    );
}
