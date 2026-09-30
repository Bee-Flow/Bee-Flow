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
 */

import React from 'react';
import { Linking, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { MicPermissionHead } from '@/shared/device/MicPermissionHead';
import { micBlocked, type MicPermission } from '@/shared/device/useMicPermission';
import { Button, Card, Icon, Text, type IconName } from '@/shared/ui';

export function MicPermissionCard({
    permission,
    onRequest,
    busy = false,
}: {
    permission: MicPermission;
    onRequest: () => void;
    busy?: boolean;
}) {
    const theme = useTheme();
    const blocked = micBlocked(permission);

    return (
        <Card>
            <View style={{ gap: theme.spacing.md }}>
                <MicPermissionHead
                    blocked={blocked}
                    title={blocked ? 'Microphone access is off' : 'Record meetings on this phone'}
                    body={blocked ? 'Bee Flow cannot record until you turn it back on.' : 'Bee Flow needs the microphone to capture the room.'}
                />

                {blocked ? (
                    <>
                        <Text variant="body" tone="secondary">
                            Open this app&apos;s settings, allow the Microphone permission, and come
                            back to this screen. You can still import an audio file in the meantime.
                        </Text>
                        <Button
                            label="Open app settings"
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
                                The recording is made on this device and stays here until you upload
                                it.
                            </Bullet>
                            <Bullet icon="Lock">
                                Nothing is recorded in the background. Capture only runs while this
                                screen says it is recording.
                            </Bullet>
                            <Bullet icon="Server">
                                Transcription happens on your Bee Flow server, using the engine your
                                administrator configured.
                            </Bullet>
                        </View>
                        <Button
                            label="Allow microphone access"
                            fullWidth
                            loading={busy}
                            onPress={onRequest}
                            accessibilityHint="Opens the Android permission dialog"
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
