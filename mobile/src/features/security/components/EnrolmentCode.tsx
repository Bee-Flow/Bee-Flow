/**
 * The enrolment QR, the setup key for typing it in instead, and a warning when
 * this phone's clock would make every code fail.
 */

import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, LoadingState, useToast } from '@/shared/ui';

import { useMfaSetup } from '../hooks/queries';
import { clockDriftWarning } from '../model/device';

export function EnrolmentCode({ open }: { open: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const setup = useMfaSetup(open);

    if (setup.isLoading) return <LoadingState label="Preparing your code" />;
    if (setup.isError) return <Banner tone="error">{describeError(setup.error).message}</Banner>;
    if (!setup.data) return null;
    const { qr, secret, serverTime } = setup.data;

    return (
        <>
            <View style={styles.qrBlock}>
                <Image
                    source={{ uri: qr }}
                    accessibilityLabel="Two-factor setup QR code"
                    style={styles.qr}
                    contentFit="contain"
                />
                <Button
                    label="Copy setup key instead"
                    variant="ghost"
                    onPress={() => {
                        void Clipboard.setStringAsync(secret);
                        toast('Setup key copied', 'success');
                    }}
                />
            </View>
            {clockDriftWarning(serverTime) ? (
                <Banner tone="warning">
                    This phone&rsquo;s clock is more than a minute off the server&rsquo;s.
                    Time-based codes will be rejected until you fix it in Android&rsquo;s
                    date and time settings.
                </Banner>
            ) : null}
        </>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        qrBlock: { alignItems: 'center', gap: theme.spacing.md },
        qr: {
            width: 200,
            height: 200,
            borderRadius: theme.radii.md,
            // The QR is black-on-white; on a dark theme it needs its own white
            // ground or the quiet zone vanishes and scanners fail.
            backgroundColor: '#ffffff',
        },
    });
