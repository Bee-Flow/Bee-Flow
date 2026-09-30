/**
 * The enrolment QR. Our own encoder handles anything a TOTP URI can be; the
 * server's PNG is here for the payload it cannot, so the screen degrades to a
 * picture rather than to nothing.
 */

import { Image } from 'expo-image';
import React from 'react';
import { StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';

import { QrCode } from './QrCode';

const styles = StyleSheet.create({ fallback: { width: 220, height: 220, alignSelf: 'center' } });

export function MfaSetupQr({ otpauthUrl, png }: { otpauthUrl: string; png: string }) {
    const t = useTranslation();
    const label = t('mobile.onboarding.mfa_qr_label', 'QR code containing your two-factor setup key');
    return (
        <QrCode
            value={otpauthUrl}
            size={220}
            accessibilityLabel={label}
            fallback={
                png ? (
                    <Image
                        source={{ uri: png }}
                        style={styles.fallback}
                        contentFit="contain"
                        accessibilityLabel={label}
                    />
                ) : null
            }
        />
    );
}
