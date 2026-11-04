/**
 * Asking for the microphone, honestly.
 *
 * Android gives an app one good chance at this: a person who taps Deny on a
 * dialog they did not expect gets a second prompt at best, and after that the
 * only route back is Settings — which nobody finds. So the system dialog is
 * never the first thing shown. This card explains what the microphone is for
 * and, just as importantly, what happens to the audio, THEN offers the button
 * that triggers the real prompt.
 *
 * The denied state is not a dead end either: it says what is missing, and
 * `Linking.openSettings()` opens this app's own permission screen directly.
 * Nothing tells the app that the person allowed it there, and a grant does not
 * restart the app, so while the card is blocked it reads the permission again
 * each time the app comes back to the front (`onRefresh`).
 */

import React, { useCallback } from 'react';
import { Linking, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useOnForeground } from '@/shared/device/appSettings';
import { MicPermissionHead } from '@/shared/device/MicPermissionHead';
import { micBlocked, type MicPermission } from '@/shared/device/useMicPermission';
import { Button, Card, Icon, Text, type IconName } from '@/shared/ui';

export function MicPermissionCard({
    permission,
    onRequest,
    onRefresh,
    busy = false,
}: {
    permission: MicPermission;
    onRequest: () => void;
    /** Reads the permission again without prompting. */
    onRefresh: () => Promise<unknown>;
    busy?: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const blocked = micBlocked(permission);
    const refresh = useCallback(() => void onRefresh(), [onRefresh]);
    useOnForeground(refresh, blocked);

    return (
        <Card>
            <View style={{ gap: theme.spacing.md }}>
                <MicPermissionHead
                    blocked={blocked}
                    title={blocked ? t('mobile.recording.mic_off_title', 'Microphone access is off') : t('mobile.recording.mic_ask_title', 'Record meetings on this phone')}
                    body={blocked
                        ? t('mobile.recording.mic_off_body', 'Bee Flow cannot record until you turn it back on.')
                        : t('mobile.recording.mic_ask_body', 'Bee Flow needs the microphone to capture the room.')}
                />

                {blocked ? (
                    <>
                        <Text variant="body" tone="secondary">
                            {t(
                                'mobile.recording.mic_off_steps',
                                "Open this app's settings, allow the Microphone permission, and come back to this screen. You can still import an audio file in the meantime.",
                            )}
                        </Text>
                        <Button
                            label={t('mobile.recording.battery_settings', 'Open app settings')}
                            variant="secondary"
                            fullWidth
                            icon={
                                <Icon
                                    name="ExternalLink"
                                    size={16}
                                    color={theme.colors.textPrimary}
                                />
                            }
                            onPress={() => {
                                void Linking.openSettings();
                            }}
                        />
                    </>
                ) : (
                    <>
                        <View style={{ gap: theme.spacing.sm }}>
                            <Bullet icon="Mic">
                                {t('mobile.recording.mic_bullet_local', 'The recording is made on this device and stays here until you upload it.')}
                            </Bullet>
                            <Bullet icon="Lock">
                                {t(
                                    'mobile.recording.mic_bullet_foreground',
                                    'Nothing is recorded in the background. Capture only runs while this screen says it is recording.',
                                )}
                            </Bullet>
                            <Bullet icon="Server">
                                {t(
                                    'mobile.recording.mic_bullet_server',
                                    'Transcription happens on your Bee Flow server, using the engine your administrator configured.',
                                )}
                            </Bullet>
                        </View>
                        <Button
                            label={t('mobile.recording.mic_allow', 'Allow microphone access')}
                            fullWidth
                            loading={busy}
                            onPress={onRequest}
                            accessibilityHint={t('mobile.recording.mic_allow_hint', 'Opens the Android permission dialog')}
                        />
                    </>
                )}
            </View>
        </Card>
    );
}

function Bullet({
    icon,
    children,
}: {
    icon: IconName;
    children: string;
}) {
    const theme = useTheme();
    return (
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'flex-start' }}>
            <Icon
                name={icon}
                size={14}
                color={theme.colors.textMuted}
                style={{ marginTop: 3 }}
            />
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                {children}
            </Text>
        </View>
    );
}
