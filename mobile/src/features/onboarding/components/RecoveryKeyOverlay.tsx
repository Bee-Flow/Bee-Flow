/**
 * The recovery key, shown over whatever is on screen.
 *
 * It has to live at the root (app/_layout.tsx), and that is not a stylistic
 * choice. The server mints a recovery key DURING a password or MFA sign-in,
 * which sets the stage to 'signed-in' — at which point the gate replaces to
 * /(tabs) and the onboarding screens unmount. Rendered anywhere below, the key
 * would be torn down in the same frame it arrived. It is shown exactly once
 * and nobody, the server included, can recover it: hence an overlay that
 * outlives the navigation and a card the user must explicitly acknowledge.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTheme } from '@/core/theme/ThemeProvider';

import { RecoveryKeyCard } from './RecoveryKeyCard';

export function RecoveryKeyOverlay() {
    const { pendingRecoveryKey, acknowledgeRecoveryKey } = useAuth();
    const theme = useTheme();
    if (!pendingRecoveryKey) return null;
    return (
        <View
            style={[
                StyleSheet.absoluteFill,
                {
                    backgroundColor: theme.colors.bgPrimary,
                    padding: theme.spacing.lg,
                    justifyContent: 'center',
                    zIndex: 100,
                },
            ]}
        >
            <RecoveryKeyCard secret={pendingRecoveryKey} onConfirm={acknowledgeRecoveryKey} />
        </View>
    );
}
