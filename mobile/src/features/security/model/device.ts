/** What this phone can do for security, in words and in numbers. */

import * as LocalAuthentication from 'expo-local-authentication';

/** "a fingerprint", "your face", "biometrics" — used inside a sentence. */
export function describeBiometrics(types: readonly LocalAuthentication.AuthenticationType[]): string {
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
        return 'your face or fingerprint';
    }
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
        return 'your fingerprint';
    }
    return 'your device unlock';
}

/**
 * TOTP has a ±30s window; a phone more than a minute out will have every code
 * rejected and no idea why. The server sends its own clock for exactly this.
 */
export function clockDriftWarning(serverTime: number | null, now = Date.now()): boolean {
    if (serverTime === null) return false;
    return Math.abs(now - serverTime) > 60_000;
}
