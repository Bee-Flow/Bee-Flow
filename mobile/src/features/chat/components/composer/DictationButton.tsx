/**
 * Dictate into the composer (the web's mic button): tap to record, tap again
 * to stop and have the words put into the message. What went wrong — no
 * microphone, nothing heard, the server failed — is said, not swallowed.
 *
 * A microphone Android will no longer ask for is not a toast and a dead
 * button: the tap offers Android's settings, and says so when the person
 * comes back with the microphone allowed. It does not start recording by
 * itself then; that stays a tap on the button.
 */

import { getRecordingPermissionsAsync } from 'expo-audio';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useDictation, type DictationProblem } from '@/features/chat/hooks/useDictation';
import { useSettingsOffer } from '@/shared/device/useSettingsOffer';
import { Icon, IconButton, Spinner, useToast } from '@/shared/ui';


export function DictationButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    const offerSettings = useSettingsOffer();
    const problemWords = (problem: DictationProblem): string =>
        problem === 'microphone'
            ? t('mobile.chat.dictate_mic', 'Bee Flow needs the microphone to take dictation.')
            : problem === 'no_speech'
              ? t('mobile.chat.dictate_no_speech', 'No speech detected.')
              : t('chat.composer.dictate_failed', 'Dictation failed');
    const backFromSettings = async () => {
        if (!(await offerSettings('microphone'))) return;
        const again = await getRecordingPermissionsAsync().catch(() => ({ granted: false }));
        if (again.granted) toast(t('mobile.chat.dictate_mic_on', 'The microphone is on. Tap it to dictate.'), 'success');
    };
    const dictation = useDictation({
        onText,
        onError: (problem) => {
            if (problem === 'microphone_blocked') void backFromSettings();
            else if (problem) toast(problemWords(problem), 'error');
        },
    });

    if (dictation.state === 'transcribing') return <Spinner />;
    const recording = dictation.state === 'recording';
    return (
        <IconButton
            icon={<Icon name={recording ? 'Square' : 'Mic'} size={18} color={recording ? theme.colors.error : theme.colors.textSecondary} />}
            accessibilityLabel={
                recording
                    ? t('chat.composer.dictate_stop', 'Stop recording and insert the text')
                    : t('chat.composer.dictate_start', 'Dictate — speak your instruction')
            }
            onPress={dictation.toggle}
            disabled={disabled}
        />
    );
}
