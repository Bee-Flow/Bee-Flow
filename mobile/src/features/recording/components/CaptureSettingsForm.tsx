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

import { useTranslation } from '@/core/i18n';
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
    const t = useTranslation();
    const theme = useTheme();
    const [showAdvanced, setShowAdvanced] = useState(false);
    const attendeesField = useRef<TextInput>(null);

    return (
        <View style={{ gap: theme.spacing.lg }}>
            <TextField
                label={t('automations.document_fields.title', 'Title')}
                value={value.title}
                onChangeText={(title) => onChange({ title })}
                placeholder={t('mobile.recording.capture_title_ph', 'Weekly planning')}
                hint={t('mobile.recording.capture_title_hint', 'A better title is written automatically once the summary is ready.')}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => attendeesField.current?.focus()}
            />

            <TextField
                ref={attendeesField}
                label={t('mobile.recording.capture_attendees', 'Who is in the meeting?')}
                value={value.attendees}
                onChangeText={(attendees) => onChange({ attendees })}
                placeholder={t('mobile.recording.capture_attendees_ph', 'Tom, Gerard, René')}
                hint={t('mobile.recording.capture_attendees_hint', 'Names, comma separated. This is what lets speakers be named instead of numbered.')}
                autoCapitalize="words"
                // The last field before the language chips: Done closes the
                // keyboard rather than promising a next field there is not.
                returnKeyType="done"
            />

            <View style={{ gap: theme.spacing.sm }}>
                <Text variant="label" tone="secondary">
                    {t('mobile.recording.capture_language', 'LANGUAGE')}
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
                    {t('mobile.recording.capture_language_hint', 'The language spoken in the room, not the language you want the notes in.')}
                </Text>
            </View>

            <Chip
                label={showAdvanced ? t('mobile.recording.capture_hide_options', 'Hide extra options') : t('automations.ndv.more_options', 'More options')}
                selected={showAdvanced}
                onPress={() => setShowAdvanced((open) => !open)}
                style={{ alignSelf: 'flex-start' }}
            />

            {showAdvanced ? (
                <View style={{ gap: theme.spacing.lg }}>
                    <TextField
                        label={t('mobile.recording.capture_num_speakers', 'Number of speakers')}
                        value={value.numSpeakers}
                        onChangeText={(raw) => onChange({ numSpeakers: raw.replace(/[^0-9]/g, '') })}
                        placeholder={t('meeting_notes.capture_num_speakers_ph', 'Auto')}
                        keyboardType="number-pad"
                        hint={t('mobile.recording.capture_num_speakers_hint', 'Leave blank to detect automatically. An exact count sharpens diarization.')}
                        containerStyle={{ maxWidth: 180 }}
                    />
                    <TextField
                        label={t('mobile.recording.capture_glossary', 'Glossary')}
                        value={value.contextTerms}
                        onChangeText={(contextTerms) => onChange({ contextTerms })}
                        placeholder={t('mobile.recording.capture_glossary_ph', 'AFAS, Bee Flow, n8n')}
                        hint={t('mobile.recording.capture_glossary_hint', 'Product names and jargon the transcriber would otherwise mishear.')}
                        autoCapitalize="none"
                    />
                </View>
            ) : null}
        </View>
    );
}
