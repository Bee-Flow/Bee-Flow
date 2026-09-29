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

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Linking, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Surface';
import { Text } from '../../../ui/Text';
import type { PermissionState } from '../useRecorder';

export function MicPermissionCard({
    permission,
    onRequest,
    busy = false,
}: {
    permission: PermissionState;
    onRequest: () => void;
    busy?: boolean;
}) {
    const theme = useTheme();
    const blocked = !permission.granted && !permission.canAskAgain && !permission.unknown;

    return (
        <Card>
            <View style={{ gap: theme.spacing.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
                    <View
                        style={{
                            width: 44,
                            height: 44,
                            borderRadius: theme.radii.md,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: theme.colors.bgTertiary,
                        }}
                    >
                        <Feather
                            name={blocked ? 'mic-off' : 'mic'}
                            size={20}
                            color={blocked ? theme.colors.warning : theme.colors.accentPrimary}
                        />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                        <Text variant="subheading">
                            {blocked ? 'Microphone access is off' : 'Record meetings on this phone'}
                        </Text>
                        <Text variant="caption" tone="tertiary">
                            {blocked
                                ? 'Bee Flow cannot record until you turn it back on.'
                                : 'Bee Flow needs the microphone to capture the room.'}
                        </Text>
                    </View>
                </View>

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
                                <Feather
                                    name="external-link"
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
                            <Bullet icon="mic">
                                The recording is made on this device and stays here until you upload
                                it.
                            </Bullet>
                            <Bullet icon="lock">
                                Nothing is recorded in the background. Capture only runs while this
                                screen says it is recording.
                            </Bullet>
                            <Bullet icon="server">
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
    icon: keyof typeof Feather.glyphMap;
    children: string;
}) {
    const theme = useTheme();
    return (
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'flex-start' }}>
            <Feather
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
