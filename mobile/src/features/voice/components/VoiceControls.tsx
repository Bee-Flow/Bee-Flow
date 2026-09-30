/**
 * The bottom of the voice screen, in the thumb zone: what went wrong, what to
 * know, the orb, and End.
 */

import React from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Icon, IconButton } from '@/shared/ui';

import { VoiceOrb } from './VoiceOrb';
import type { UseVoiceSession } from '../hooks/useVoiceSession';

const makeStyles = (theme: Theme) => ({
    bar: {
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.md,
        paddingBottom: theme.spacing.lg,
        gap: theme.spacing.md,
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderSubtle,
    },
});

export function VoiceControls({ voice, needsPermission }: { voice: UseVoiceSession; needsPermission: boolean }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const dismissIcon = <Icon name="X" size={16} color={theme.colors.textSecondary} />;
    return (
        <View style={styles.bar}>
            {voice.error ? (
                <Banner
                    tone="error"
                    action={
                        <IconButton
                            icon={dismissIcon}
                            accessibilityLabel="Dismiss this problem"
                            onPress={voice.clearError}
                        />
                    }
                >
                    {describeError(voice.error).message}
                </Banner>
            ) : null}

            {/* no_speech and a missing TTS voice are ordinary outcomes of a
                working system, so they are a note, not a red box. */}
            {voice.notice ? (
                <Banner
                    tone="info"
                    action={
                        <IconButton icon={dismissIcon} accessibilityLabel="Dismiss this note" onPress={voice.clearNotice} />
                    }
                >
                    {voice.notice}
                </Banner>
            ) : null}

            {!needsPermission ? (
                <VoiceOrb phase={voice.phase} level={voice.level} elapsed={voice.elapsed} onPress={voice.pressPrimary} />
            ) : null}

            {voice.phase !== 'offline' ? (
                <Button
                    label="End"
                    variant="danger"
                    size="lg"
                    fullWidth
                    iconName="PhoneOff"
                    onPress={voice.hangUp}
                    accessibilityHint="Stops listening and closes the microphone"
                />
            ) : null}
        </View>
    );
}
