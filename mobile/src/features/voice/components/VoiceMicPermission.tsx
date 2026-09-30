/**
 * Asking for the microphone, before asking for the microphone.
 *
 * Android gives an app one good shot at this prompt: deny it once and you get
 * one more chance, deny it twice and the only route back is a Settings screen
 * nobody finds. So the system dialog is never the first thing a person sees —
 * this card says what the mic is for and where the audio goes, and only then
 * offers the button that triggers the real prompt.
 *
 * The privacy line is not filler. Bee Flow is sold as the alternative that does
 * not ship your voice to a third party by default, and this is the one screen
 * where a user is entitled to ask exactly where the recording goes.
 */

import React from 'react';
import { Linking, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { MicPermissionHead } from '@/shared/device/MicPermissionHead';
import { micBlocked } from '@/shared/device/useMicPermission';
import { Button, Card, Icon, Text } from '@/shared/ui';

import type { MicPermission } from '../hooks/useVoiceSession';

export function VoiceMicPermission({
    permission,
    onRequest,
    busy = false,
}: {
    permission: MicPermission;
    onRequest: () => void;
    busy?: boolean;
}) {
    const theme = useTheme();
    const t = useTranslation();
    const blocked = micBlocked(permission);

    return (
        <Card>
            <View style={{ gap: theme.spacing.md }}>
                <MicPermissionHead
                    blocked={blocked}
                    title={
                        blocked
                            ? t('mobile.voice.mic_blocked_title', 'Microphone access is off')
                            : t('mobile.voice.mic_title', 'Talk to Bee Flow')
                    }
                    body={
                        blocked
                            ? t('mobile.voice.mic_blocked_body', 'Voice mode cannot hear you until you turn it back on.')
                            : t('mobile.voice.mic_body', 'Voice mode needs the microphone to hear your question.')
                    }
                />

                <Text variant="body" tone="secondary">
                    {t(
                        'mobile.voice.mic_privacy',
                        'Each question is recorded on this phone and sent to your own Bee Flow ' +
                            'server to be transcribed and answered. Nothing is kept once the ' +
                            'answer comes back.',
                    )}
                </Text>

                {blocked ? (
                    <Button
                        label={t('mobile.voice.open_settings', 'Open app settings')}
                        variant="secondary"
                        fullWidth
                        icon={
                            <Icon name="ExternalLink" size={16} color={theme.colors.textPrimary} />
                        }
                        onPress={() => {
                            void Linking.openSettings();
                        }}
                    />
                ) : (
                    <Button
                        label={t('mobile.voice.allow_mic', 'Allow the microphone')}
                        fullWidth
                        loading={busy}
                        onPress={onRequest}
                        accessibilityHint={t(
                            'mobile.voice.allow_mic_hint',
                            'Opens the Android permission prompt',
                        )}
                    />
                )}
            </View>
        </Card>
    );
}
